import * as ts from 'typescript';
import { errorAtNode, FrontendError } from './errors.ts';
import type {
  HirBinaryOp,
  HirExpr,
  HirFunction,
  HirLocal,
  HirParam,
  HirProgram,
  HirStmt,
  ValueType,
} from './hir.ts';
import type { ForeignClassInfo, ForeignMethod } from './type-registry.ts';

export interface CompileOptions {
  registry: Map<string, ForeignClassInfo>;
  fileName: string;
}

const F64: ValueType = { kind: 'f64' };
const BOOLEAN: ValueType = { kind: 'boolean' };
const STRING: ValueType = { kind: 'string' };
const NULL: ValueType = { kind: 'null' };
const VOID: ValueType = { kind: 'void' };
const OBJECT: ValueType = { kind: 'object', className: 'java/lang/Object' };

interface VarInfo {
  slot: number;
  type: ValueType;
}

interface FunctionSig {
  params: ValueType[];
  returnType: ValueType;
}

/** Per-function lowering state. */
interface FnCtx {
  scopes: Map<string, VarInfo>[];
  nextSlot: number;
  locals: HirLocal[];
  returnType: ValueType;
}

export function compileSourceToHir(sourceText: string, opts: CompileOptions): HirProgram {
  const { program, sourceFile } = createProgram(sourceText, opts.fileName);

  const syntactic = program.getSyntacticDiagnostics(sourceFile);
  const first = syntactic[0];
  if (first) {
    const pos = first.start ?? 0;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    throw new FrontendError(ts.flattenDiagnosticMessageText(first.messageText, '\n'), sourceFile.fileName, line, character);
  }

  return new Lowerer(program.getTypeChecker(), opts).lowerFile(sourceFile);
}

const libCache = new Map<string, ts.SourceFile>();

function createProgram(sourceText: string, fileName: string): { program: ts.Program; sourceFile: ts.SourceFile } {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.None,
    skipLibCheck: true,
    noResolve: true, // v1: no imports
    types: [], // don't pull in @types/* from the surrounding project
  };

  const host = ts.createCompilerHost(options, true);
  const canonical = (f: string): string => host.getCanonicalFileName(ts.sys.resolvePath(f));
  const target = canonical(fileName);
  const sourceFile = ts.createSourceFile(fileName, sourceText, options.target!, true, ts.ScriptKind.TS);

  const { getSourceFile, readFile, fileExists } = host;
  host.getSourceFile = (name, ...rest) => {
    if (canonical(name) === target) return sourceFile;
    // Parsing lib.*.d.ts dominates compile time, and lib SourceFiles are never mutated.
    let lib = libCache.get(name);
    if (!lib) {
      lib = getSourceFile.call(host, name, ...rest);
      if (lib) libCache.set(name, lib);
    }
    return lib;
  };
  host.readFile = (name) => (canonical(name) === target ? sourceText : readFile.call(host, name));
  host.fileExists = (name) => canonical(name) === target || fileExists.call(host, name);

  return { program: ts.createProgram([fileName], options, host), sourceFile };
}

function slotsOf(t: ValueType): number {
  return t.kind === 'f64' ? 2 : 1;
}

function typesEqual(a: ValueType, b: ValueType): boolean {
  return a.kind === b.kind && (a.kind !== 'object' || b.kind !== 'object' || a.className === b.className);
}

/** Exact match, or widening of any value to java/lang/Object. */
function assignable(from: ValueType, to: ValueType): boolean {
  if (from.kind === 'void') return false;
  return typesEqual(from, to) || (to.kind === 'object' && to.className === 'java/lang/Object');
}

function typeOf(e: HirExpr): ValueType {
  switch (e.k) {
    case 'num':
      return F64;
    case 'str':
      return STRING;
    case 'bool':
      return BOOLEAN;
    case 'null':
    case 'undefined':
      return NULL;
    case 'local':
    case 'assign':
      return e.type;
    case 'binary':
    case 'unary':
    case 'call':
    case 'cond':
      return e.resultType;
  }
}

function describe(t: ValueType): string {
  return t.kind === 'object' ? t.className : t.kind;
}

class Lowerer {
  private readonly checker: ts.TypeChecker;
  private readonly registry: Map<string, ForeignClassInfo>;
  private readonly functions = new Map<string, FunctionSig>();
  private fn!: FnCtx;

  constructor(checker: ts.TypeChecker, opts: CompileOptions) {
    this.checker = checker;
    this.registry = opts.registry;
  }

  // ---- top level ---------------------------------------------------------

  lowerFile(sf: ts.SourceFile): HirProgram {
    const decls: ts.FunctionDeclaration[] = [];
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt)) errorAtNode(stmt, 'unsupported top-level statement');
      this.validateFunction(stmt);
      const name = stmt.name!.text;
      if (this.functions.has(name)) errorAtNode(stmt.name!, `duplicate function '${name}'`);
      this.functions.set(name, this.signatureOf(stmt));
      decls.push(stmt);
    }
    return { functions: decls.map((d) => this.lowerFunction(d)) };
  }

  private validateFunction(node: ts.FunctionDeclaration): void {
    if (!node.name) errorAtNode(node, 'anonymous functions are not supported');
    for (const m of node.modifiers ?? []) {
      if (m.kind === ts.SyntaxKind.AsyncKeyword) errorAtNode(node, 'async functions are not supported in v1');
      errorAtNode(m, `unsupported modifier '${m.getText()}'`);
    }
    if (node.asteriskToken) errorAtNode(node, 'generator functions are not supported in v1');
    if (node.typeParameters?.length) errorAtNode(node, 'generic functions are not supported in v1');
    if (!node.body) errorAtNode(node, 'function must have a body');
    for (const p of node.parameters) {
      if (!ts.isIdentifier(p.name) || p.questionToken || p.dotDotDotToken || p.initializer) {
        errorAtNode(p, 'unsupported parameter (destructuring, optional, rest and default values are not supported)');
      }
    }
  }

  private signatureOf(node: ts.FunctionDeclaration): FunctionSig {
    const params = node.parameters.map((p) => this.mapType(this.checker.getTypeAtLocation(p), p));
    const sig = this.checker.getSignatureFromDeclaration(node);
    if (!sig) errorAtNode(node, 'cannot resolve function signature');
    const returnType = this.mapType(this.checker.getReturnTypeOfSignature(sig), node, 'return');
    return { params, returnType };
  }

  private lowerFunction(node: ts.FunctionDeclaration): HirFunction {
    const name = node.name!.text;
    const sig = this.functions.get(name)!;
    this.fn = { scopes: [new Map()], nextSlot: 0, locals: [], returnType: sig.returnType };

    const params: HirParam[] = node.parameters.map((p, i) => {
      const pname = (p.name as ts.Identifier).text;
      const type = sig.params[i]!;
      return { name: pname, type, slot: this.declare(pname, type, p.name) };
    });

    const body = this.lowerStmt(node.body!);
    return { name, params, returnType: sig.returnType, locals: this.fn.locals, body };
  }

  // ---- types -------------------------------------------------------------

  private mapType(type: ts.Type, node: ts.Node, position: 'value' | 'return' = 'value'): ValueType {
    const f = type.flags;
    if (f & ts.TypeFlags.NumberLike) return F64;
    if (f & ts.TypeFlags.StringLike) return STRING;
    if (f & ts.TypeFlags.BooleanLike) return BOOLEAN; // before Union: `boolean` is true | false
    if (f & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return position === 'return' ? VOID : NULL;
    if (f & ts.TypeFlags.Null) return NULL;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union)) return OBJECT;
    return errorAtNode(node, `unsupported type '${this.checker.typeToString(type)}'`);
  }

  // ---- scopes and slots --------------------------------------------------

  private lookup(name: string): VarInfo | undefined {
    for (let i = this.fn.scopes.length - 1; i >= 0; i--) {
      const v = this.fn.scopes[i]!.get(name);
      if (v) return v;
    }
    return undefined;
  }

  /** Allocates the next slot(s), no reuse. Does not record the variable in `locals`. */
  private declare(name: string, type: ValueType, node: ts.Node): number {
    const scope = this.fn.scopes[this.fn.scopes.length - 1]!;
    if (scope.has(name)) errorAtNode(node, `duplicate declaration of '${name}'`);
    const slot = this.fn.nextSlot;
    this.fn.nextSlot += slotsOf(type);
    scope.set(name, { slot, type });
    return slot;
  }

  private declareLocal(name: string, type: ValueType, node: ts.Node): number {
    const slot = this.declare(name, type, node);
    this.fn.locals.push({ name, type, slot });
    return slot;
  }

  private withScope<T>(body: () => T): T {
    this.fn.scopes.push(new Map());
    try {
      return body();
    } finally {
      this.fn.scopes.pop();
    }
  }

  // ---- statements --------------------------------------------------------

  private lowerStmt(node: ts.Statement): HirStmt {
    if (ts.isBlock(node)) {
      return this.withScope(() => ({ k: 'block', stmts: node.statements.map((s) => this.lowerStmt(s)) }));
    }
    if (ts.isVariableStatement(node)) return this.lowerVariableStatement(node);
    if (ts.isExpressionStatement(node)) return { k: 'expr', expr: this.lowerExpr(node.expression) };
    if (ts.isIfStatement(node)) {
      return {
        k: 'if',
        cond: this.lowerCondition(node.expression),
        then: this.lowerStmt(node.thenStatement),
        else_: node.elseStatement ? this.lowerStmt(node.elseStatement) : null,
      };
    }
    if (ts.isWhileStatement(node)) {
      return { k: 'while', cond: this.lowerCondition(node.expression), body: this.lowerStmt(node.statement) };
    }
    if (ts.isReturnStatement(node)) return this.lowerReturn(node);
    if (ts.isThrowStatement(node)) {
      const expr = this.lowerExpr(node.expression);
      if (typeOf(expr).kind === 'void') errorAtNode(node.expression, 'cannot throw a void value');
      return { k: 'throw', expr };
    }
    if (ts.isTryStatement(node)) return this.lowerTry(node);
    if (ts.isFunctionDeclaration(node)) errorAtNode(node, 'closures are not supported in v1');
    return errorAtNode(node, `unsupported statement (${ts.SyntaxKind[node.kind]})`);
  }

  private lowerCondition(node: ts.Expression): HirExpr {
    const cond = this.lowerExpr(node);
    if (typeOf(cond).kind !== 'boolean') errorAtNode(node, `condition must be boolean, got ${describe(typeOf(cond))}`);
    return cond;
  }

  private lowerVariableStatement(node: ts.VariableStatement): HirStmt {
    const list = node.declarationList;
    if (!(list.flags & ts.NodeFlags.BlockScoped)) errorAtNode(node, "'var' is not supported; use let or const");
    if (list.declarations.length !== 1) errorAtNode(node, 'only one declarator per let/const statement is supported');
    const decl = list.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) errorAtNode(decl.name, 'destructuring is not supported');
    if (!decl.initializer && !decl.type) errorAtNode(decl, 'variable needs an initializer or a type annotation');

    // Lower the initializer before declaring so `let x = x` can't see itself.
    const init = decl.initializer ? this.lowerExpr(decl.initializer) : null;
    const type = this.mapType(this.checker.getTypeAtLocation(decl.name), decl.name);
    if (init && !assignable(typeOf(init), type)) {
      errorAtNode(decl.initializer!, `cannot assign ${describe(typeOf(init))} to ${describe(type)}`);
    }
    const slot = this.declareLocal(decl.name.text, type, decl.name);
    return { k: 'var-decl', name: decl.name.text, slot, type, init };
  }

  private lowerReturn(node: ts.ReturnStatement): HirStmt {
    const rt = this.fn.returnType;
    if (!node.expression) {
      if (rt.kind !== 'void') errorAtNode(node, `missing return value (function returns ${describe(rt)})`);
      return { k: 'return', expr: null };
    }
    if (rt.kind === 'void') errorAtNode(node, 'cannot return a value from a void function');
    const expr = this.lowerExpr(node.expression);
    if (!assignable(typeOf(expr), rt)) {
      errorAtNode(node.expression, `cannot return ${describe(typeOf(expr))} from a function returning ${describe(rt)}`);
    }
    return { k: 'return', expr };
  }

  private lowerTry(node: ts.TryStatement): HirStmt {
    const try_ = this.lowerStmt(node.tryBlock);
    let catchVar: { name: string; slot: number; type: ValueType } | null = null;
    let catch_: HirStmt | null = null;
    if (node.catchClause) {
      const clause = node.catchClause;
      catch_ = this.withScope(() => {
        const v = clause.variableDeclaration;
        if (v) {
          if (!ts.isIdentifier(v.name)) errorAtNode(v.name, 'destructuring is not supported');
          const type = this.mapType(this.checker.getTypeAtLocation(v.name), v.name);
          catchVar = { name: v.name.text, slot: this.declareLocal(v.name.text, type, v.name), type };
        }
        return this.lowerStmt(clause.block);
      });
    }
    const finally_ = node.finallyBlock ? this.lowerStmt(node.finallyBlock) : null;
    return { k: 'try', try_, catchVar, catch_, finally_ };
  }

  // ---- expressions -------------------------------------------------------

  private lowerExpr(node: ts.Expression): HirExpr {
    if (ts.isParenthesizedExpression(node)) return this.lowerExpr(node.expression);
    if (ts.isNumericLiteral(node)) return { k: 'num', value: Number(node.text) };
    if (ts.isStringLiteral(node)) return { k: 'str', value: node.text };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: 'bool', value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: 'bool', value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { k: 'null' };
    if (ts.isIdentifier(node)) return this.lowerIdentifier(node);
    if (ts.isBinaryExpression(node)) return this.lowerBinary(node);
    if (ts.isPrefixUnaryExpression(node)) return this.lowerPrefixUnary(node);
    if (ts.isConditionalExpression(node)) return this.lowerConditional(node);
    if (ts.isCallExpression(node)) return this.lowerCall(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return errorAtNode(node, 'closures are not supported in v1');
    }
    if (ts.isAwaitExpression(node)) return errorAtNode(node, 'await is not supported (async is not supported in v1)');
    return errorAtNode(node, `unsupported expression (${ts.SyntaxKind[node.kind]})`);
  }

  private lowerIdentifier(node: ts.Identifier): HirExpr {
    const v = this.lookup(node.text);
    if (v) return { k: 'local', slot: v.slot, type: v.type };
    if (node.text === 'undefined') return { k: 'undefined' };
    return errorAtNode(node, `unknown identifier '${node.text}'`);
  }

  private lowerPrefixUnary(node: ts.PrefixUnaryExpression): HirExpr {
    const operand = this.lowerExpr(node.operand);
    const t = typeOf(operand);
    if (node.operator === ts.SyntaxKind.MinusToken) {
      if (t.kind !== 'f64') errorAtNode(node, `operator '-' needs a number, got ${describe(t)}`);
      return { k: 'unary', op: '-', operand, resultType: F64 };
    }
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      if (t.kind !== 'boolean') errorAtNode(node, `operator '!' needs a boolean, got ${describe(t)}`);
      return { k: 'unary', op: '!', operand, resultType: BOOLEAN };
    }
    return errorAtNode(node, 'unsupported unary operator');
  }

  private lowerConditional(node: ts.ConditionalExpression): HirExpr {
    const cond = this.lowerCondition(node.condition);
    const then = this.lowerExpr(node.whenTrue);
    const else_ = this.lowerExpr(node.whenFalse);
    const [tt, et] = [typeOf(then), typeOf(else_)];
    if (tt.kind === 'void' || et.kind === 'void') errorAtNode(node, 'conditional branches must produce values');
    return { k: 'cond', cond, then, else_, resultType: typesEqual(tt, et) ? tt : OBJECT };
  }

  private lowerBinary(node: ts.BinaryExpression): HirExpr {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.EqualsToken) return this.lowerAssign(node);

    const op = BINARY_OPS.get(kind);
    if (!op) {
      return errorAtNode(node.operatorToken, `unsupported operator '${node.operatorToken.getText()}'`);
    }
    const left = this.lowerExpr(node.left);
    const right = this.lowerExpr(node.right);
    const [lt, rt] = [typeOf(left), typeOf(right)];
    const bad = (): never =>
      errorAtNode(node.operatorToken, `operator '${node.operatorToken.getText()}' can't be applied to ${describe(lt)} and ${describe(rt)}`);

    switch (op) {
      case '+':
        if (lt.kind === 'void' || rt.kind === 'void') return bad();
        if (lt.kind === 'string' || rt.kind === 'string') return { k: 'binary', op, left, right, resultType: STRING };
        if (lt.kind === 'f64' && rt.kind === 'f64') return { k: 'binary', op, left, right, resultType: F64 };
        return bad();
      case '-':
      case '*':
      case '/':
      case '%':
        if (lt.kind === 'f64' && rt.kind === 'f64') return { k: 'binary', op, left, right, resultType: F64 };
        return bad();
      case '==':
      case '!=':
        if ((lt.kind === 'f64' && rt.kind === 'f64') || (lt.kind === 'string' && rt.kind === 'string')) {
          return { k: 'binary', op, left, right, resultType: BOOLEAN };
        }
        return bad();
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (lt.kind === 'f64' && rt.kind === 'f64') return { k: 'binary', op, left, right, resultType: BOOLEAN };
        return bad();
      case '&&':
      case '||':
        if (lt.kind === 'boolean' && rt.kind === 'boolean') return { k: 'binary', op, left, right, resultType: BOOLEAN };
        return bad();
    }
  }

  private lowerAssign(node: ts.BinaryExpression): HirExpr {
    if (!ts.isIdentifier(node.left)) return errorAtNode(node.left, 'can only assign to a local variable');
    const v = this.lookup(node.left.text);
    if (!v) return errorAtNode(node.left, `unknown identifier '${node.left.text}'`);
    const rhs = this.lowerExpr(node.right);
    if (!assignable(typeOf(rhs), v.type)) {
      errorAtNode(node.right, `cannot assign ${describe(typeOf(rhs))} to ${describe(v.type)}`);
    }
    return { k: 'assign', slot: v.slot, type: v.type, rhs };
  }

  private lowerCall(node: ts.CallExpression): HirExpr {
    if (node.questionDotToken) errorAtNode(node, 'optional chaining is not supported');
    if (node.typeArguments?.length) errorAtNode(node, 'type arguments are not supported');
    const callee = node.expression;

    if (ts.isIdentifier(callee)) return this.lowerLocalCall(node, callee);
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
      return this.lowerForeignCall(node, callee.expression, callee.name);
    }
    return errorAtNode(node, 'unsupported call target');
  }

  private lowerLocalCall(node: ts.CallExpression, callee: ts.Identifier): HirExpr {
    const name = callee.text;
    if (this.lookup(name)) errorAtNode(callee, `'${name}' is a variable, not a function`);
    const sig = this.functions.get(name);
    if (!sig) return errorAtNode(callee, `unknown function '${name}'`);
    if (node.arguments.length !== sig.params.length) {
      errorAtNode(node, `'${name}' expects ${sig.params.length} arguments, got ${node.arguments.length}`);
    }
    const args = node.arguments.map((a, i) => {
      const arg = this.lowerExpr(a);
      if (!assignable(typeOf(arg), sig.params[i]!)) {
        errorAtNode(a, `argument ${i + 1} of '${name}': cannot pass ${describe(typeOf(arg))} as ${describe(sig.params[i]!)}`);
      }
      return arg;
    });
    return { k: 'call', calleeName: name, args, resultType: sig.returnType };
  }

  private lowerForeignCall(node: ts.CallExpression, obj: ts.Identifier, method: ts.Identifier): HirExpr {
    const qualified = `${obj.text}.${method.text}`;
    const cls = this.registry.get(obj.text);
    if (!cls || this.lookup(obj.text)) errorAtNode(node, `unsupported call target '${qualified}'`);
    const candidates = cls.methods.filter((m) => m.name === method.text);
    if (candidates.length === 0) errorAtNode(method, `unknown method '${qualified}'`);

    const args = node.arguments.map((a) => this.lowerExpr(a));
    const argTypes = args.map(typeOf);
    const match: ForeignMethod | undefined = candidates.find(
      (m) =>
        m.isStatic &&
        m.params.length === argTypes.length &&
        m.params.every((p, i) => typesEqual(p, argTypes[i]!)),
    );
    if (!match) {
      errorAtNode(
        node,
        `no overload of '${qualified}' accepts (${argTypes.map(describe).join(', ')}); expected ` +
          candidates.map((m) => `(${m.params.map(describe).join(', ')})`).join(' or '),
      );
    }
    return { k: 'call', calleeName: qualified, args, resultType: match.returnType };
  }
}

const BINARY_OPS = new Map<ts.SyntaxKind, HirBinaryOp>([
  [ts.SyntaxKind.PlusToken, '+'],
  [ts.SyntaxKind.MinusToken, '-'],
  [ts.SyntaxKind.AsteriskToken, '*'],
  [ts.SyntaxKind.SlashToken, '/'],
  [ts.SyntaxKind.PercentToken, '%'],
  [ts.SyntaxKind.EqualsEqualsToken, '=='],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '=='], // same semantics once both sides are statically f64/string
  [ts.SyntaxKind.ExclamationEqualsToken, '!='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '!='],
  [ts.SyntaxKind.LessThanToken, '<'],
  [ts.SyntaxKind.LessThanEqualsToken, '<='],
  [ts.SyntaxKind.GreaterThanToken, '>'],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>='],
  [ts.SyntaxKind.AmpersandAmpersandToken, '&&'],
  [ts.SyntaxKind.BarBarToken, '||'],
]);
