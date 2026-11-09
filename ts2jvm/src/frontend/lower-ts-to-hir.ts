import * as ts from 'typescript';
import { errorAtNode, FrontendError } from './errors.ts';
import type {
    HirBinaryOp,
    HirClass,
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

interface ClassSig {
    fields: Map<string, ValueType>;
    ctorParams: ValueType[];
    methods: Map<string, FunctionSig>;
}

type Callable = ts.FunctionDeclaration | ts.MethodDeclaration;

/** Per-function lowering state. */
interface FnCtx {
    scopes: Map<string, VarInfo>[];
    nextSlot: number;
    locals: HirLocal[];
    returnType: ValueType;
    /** Name of the enclosing class inside methods and constructors, else null. */
    thisClass: string | null;
}

export function compileSourceToHir(sourceText: string, opts: CompileOptions): HirProgram {
    const { program, sourceFile } = createProgram(sourceText, opts.fileName);

    const syntactic = program.getSyntacticDiagnostics(sourceFile);
    const first = syntactic[0];
    if (first) {
        const pos = first.start ?? 0;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
        throw new FrontendError(
            ts.flattenDiagnosticMessageText(first.messageText, '\n'),
            sourceFile.fileName,
            line,
            character,
        );
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
        case 'new':
        case 'call-method':
            return e.resultType;
        case 'this':
        case 'field':
        case 'set-field':
            return e.type;
    }
}

function describe(t: ValueType): string {
    return t.kind === 'object' ? t.className : t.kind;
}

class Lowerer {
    private readonly checker: ts.TypeChecker;
    private readonly registry: Map<string, ForeignClassInfo>;
    private readonly functions = new Map<string, FunctionSig>();
    private readonly classes = new Map<string, ClassSig>();
    private fn!: FnCtx;

    constructor(checker: ts.TypeChecker, opts: CompileOptions) {
        this.checker = checker;
        this.registry = opts.registry;
    }

    // ---- top level ---------------------------------------------------------

    lowerFile(sf: ts.SourceFile): HirProgram {
        const fnDecls: ts.FunctionDeclaration[] = [];
        const classDecls: ts.ClassDeclaration[] = [];
        // Pass 1: names, so signatures can mention classes declared later in the file.
        for (const stmt of sf.statements) {
            if (ts.isFunctionDeclaration(stmt)) {
                fnDecls.push(stmt);
            } else if (ts.isClassDeclaration(stmt)) {
                const name = this.classNameOf(stmt);
                this.classes.set(name, { fields: new Map(), ctorParams: [], methods: new Map() });
                classDecls.push(stmt);
            } else {
                errorAtNode(stmt, 'unsupported top-level statement');
            }
        }
        // Pass 2: signatures.
        for (const decl of fnDecls) {
            this.validateCallable(decl);
            const name = decl.name!.text;
            if (this.functions.has(name)) errorAtNode(decl.name!, `duplicate function '${name}'`);
            this.functions.set(name, this.signatureOf(decl));
        }
        for (const decl of classDecls) this.declareClass(decl);

        return {
            functions: fnDecls.map((d) => this.lowerCallable(d, d.name!.text, this.functions.get(d.name!.text)!, null)),
            classes: classDecls.map((d) => this.lowerClass(d)),
        };
    }

    private classNameOf(node: ts.ClassDeclaration): string {
        if (!node.name) errorAtNode(node, 'anonymous classes are not supported');
        const name = node.name.text;
        if (this.classes.has(name)) errorAtNode(node.name, `duplicate class '${name}'`);
        for (const m of node.modifiers ?? []) errorAtNode(m, `unsupported modifier '${m.getText()}'`);
        if (node.heritageClauses?.length)
            errorAtNode(node.heritageClauses[0]!, 'class inheritance is not supported yet');
        if (node.typeParameters?.length) errorAtNode(node, 'generic classes are not supported in v1');
        return name;
    }

    private validateParams(params: ts.NodeArray<ts.ParameterDeclaration>): void {
        for (const p of params) {
            if (p.modifiers?.length) errorAtNode(p, 'parameter properties are not supported');
            if (!ts.isIdentifier(p.name) || p.questionToken || p.dotDotDotToken || p.initializer) {
                errorAtNode(
                    p,
                    'unsupported parameter (destructuring, optional, rest and default values are not supported)',
                );
            }
        }
    }

    private validateCallable(node: Callable): void {
        if (!node.name) errorAtNode(node, 'anonymous functions are not supported');
        if (!ts.isIdentifier(node.name))
            errorAtNode(node.name, 'only plain identifiers can name functions and methods');
        for (const m of node.modifiers ?? []) {
            if (m.kind === ts.SyntaxKind.AsyncKeyword) errorAtNode(node, 'async functions are not supported in v1');
            errorAtNode(m, `unsupported modifier '${m.getText()}'`);
        }
        if (node.asteriskToken) errorAtNode(node, 'generator functions are not supported in v1');
        if (node.typeParameters?.length) errorAtNode(node, 'generic functions are not supported in v1');
        if (!node.body) errorAtNode(node, 'function must have a body');
        this.validateParams(node.parameters);
    }

    private signatureOf(node: Callable): FunctionSig {
        const params = node.parameters.map((p) => this.mapType(this.checker.getTypeAtLocation(p), p));
        const sig = this.checker.getSignatureFromDeclaration(node);
        if (!sig) errorAtNode(node, 'cannot resolve function signature');
        const returnType = this.mapType(this.checker.getReturnTypeOfSignature(sig), node, 'return');
        return { params, returnType };
    }

    private declareClass(node: ts.ClassDeclaration): void {
        const sig = this.classes.get(node.name!.text)!;
        let sawCtor = false;
        for (const member of node.members) {
            if (ts.isPropertyDeclaration(member)) {
                for (const m of member.modifiers ?? []) errorAtNode(m, `unsupported modifier '${m.getText()}'`);
                if (!ts.isIdentifier(member.name)) errorAtNode(member.name, 'only plain identifiers can name fields');
                if (member.questionToken || member.exclamationToken)
                    errorAtNode(member, 'optional fields are not supported');
                if (!member.type && !member.initializer)
                    errorAtNode(member, 'field needs a type annotation or an initializer');
                const fname = member.name.text;
                if (sig.fields.has(fname) || sig.methods.has(fname))
                    errorAtNode(member.name, `duplicate member '${fname}'`);
                sig.fields.set(fname, this.mapType(this.checker.getTypeAtLocation(member.name), member.name));
            } else if (ts.isMethodDeclaration(member)) {
                this.validateCallable(member);
                const mname = (member.name as ts.Identifier).text;
                if (sig.fields.has(mname) || sig.methods.has(mname))
                    errorAtNode(member.name, `duplicate member '${mname}'`);
                sig.methods.set(mname, this.signatureOf(member));
            } else if (ts.isConstructorDeclaration(member)) {
                if (sawCtor) errorAtNode(member, 'a class can have only one constructor');
                sawCtor = true;
                for (const m of member.modifiers ?? []) errorAtNode(m, `unsupported modifier '${m.getText()}'`);
                if (!member.body) errorAtNode(member, 'constructor must have a body');
                this.validateParams(member.parameters);
                sig.ctorParams = member.parameters.map((p) => this.mapType(this.checker.getTypeAtLocation(p), p));
            } else {
                errorAtNode(member, `unsupported class member (${ts.SyntaxKind[member.kind]})`);
            }
        }
    }

    private lowerClass(node: ts.ClassDeclaration): HirClass {
        const name = node.name!.text;
        const sig = this.classes.get(name)!;
        const methods: HirFunction[] = [];
        let ctorNode: ts.ConstructorDeclaration | undefined;
        for (const member of node.members) {
            if (ts.isMethodDeclaration(member)) {
                const mname = (member.name as ts.Identifier).text;
                methods.push(this.lowerCallable(member, mname, sig.methods.get(mname)!, name));
            } else if (ts.isConstructorDeclaration(member)) {
                ctorNode = member;
            }
        }
        const fields = [...sig.fields].map(([fname, type]) => ({ name: fname, type }));
        return { name, fields, ctor: this.lowerConstructor(node, ctorNode, sig), methods };
    }

    /** Field initializers run first, then the constructor body. They can't see the constructor's parameters. */
    private lowerConstructor(
        cls: ts.ClassDeclaration,
        node: ts.ConstructorDeclaration | undefined,
        sig: ClassSig,
    ): HirFunction {
        const name = cls.name!.text;
        const self: ValueType = { kind: 'object', className: name };
        this.fn = { scopes: [new Map()], nextSlot: 1, locals: [], returnType: VOID, thisClass: name };

        const inits: HirStmt[] = [];
        for (const m of cls.members) {
            if (!ts.isPropertyDeclaration(m) || !m.initializer) continue;
            const fname = (m.name as ts.Identifier).text;
            const type = sig.fields.get(fname)!;
            const rhs = this.lowerExpr(m.initializer);
            if (!assignable(typeOf(rhs), type)) {
                errorAtNode(m.initializer, `cannot assign ${describe(typeOf(rhs))} to ${describe(type)}`);
            }
            inits.push({
                k: 'expr',
                expr: { k: 'set-field', object: { k: 'this', type: self }, owner: name, name: fname, type, rhs },
            });
        }

        const params: HirParam[] = (node?.parameters ?? []).map((p, i) => {
            const pname = (p.name as ts.Identifier).text;
            const type = sig.ctorParams[i]!;
            return { name: pname, type, slot: this.declareSlot(pname, type, p.name) };
        });
        const body: HirStmt = node ? this.lowerStmt(node.body!) : { k: 'block', stmts: [] };
        return {
            name: '<init>',
            params,
            returnType: VOID,
            locals: this.fn.locals,
            body: { k: 'block', stmts: [...inits, body] },
        };
    }

    /** Lowers a function or method. In a method, slot 0 is `this` and parameters start at slot 1. */
    private lowerCallable(node: Callable, name: string, sig: FunctionSig, thisClass: string | null): HirFunction {
        this.fn = {
            scopes: [new Map()],
            nextSlot: thisClass ? 1 : 0,
            locals: [],
            returnType: sig.returnType,
            thisClass,
        };

        const params: HirParam[] = node.parameters.map((p, i) => {
            const pname = (p.name as ts.Identifier).text;
            const type = sig.params[i]!;
            return { name: pname, type, slot: this.declareSlot(pname, type, p.name) };
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
        const decl = type.symbol?.valueDeclaration;
        if (decl && ts.isClassDeclaration(decl) && decl.name && this.classes.has(decl.name.text)) {
            return { kind: 'object', className: decl.name.text };
        }
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
    private declareSlot(name: string, type: ValueType, node: ts.Node): number {
        const scope = this.fn.scopes[this.fn.scopes.length - 1]!;
        if (scope.has(name)) errorAtNode(node, `duplicate declaration of '${name}'`);
        const slot = this.fn.nextSlot;
        this.fn.nextSlot += slotsOf(type);
        scope.set(name, { slot, type });
        return slot;
    }

    private declareLocal(name: string, type: ValueType, node: ts.Node): number {
        const slot = this.declareSlot(name, type, node);
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
            const tk = typeOf(expr).kind;
            // JVM `athrow` needs a Throwable: strings are wrapped in an exception, objects are a caught error rethrown.
            if (tk !== 'string' && tk !== 'object') {
                errorAtNode(node.expression, 'can only throw a string or a caught error in v1');
            }
            return { k: 'throw', expr };
        }
        if (ts.isTryStatement(node)) return this.lowerTry(node);
        if (ts.isFunctionDeclaration(node)) errorAtNode(node, 'closures are not supported in v1');
        return errorAtNode(node, `unsupported statement (${ts.SyntaxKind[node.kind]})`);
    }

    private lowerCondition(node: ts.Expression): HirExpr {
        const cond = this.lowerExpr(node);
        if (typeOf(cond).kind !== 'boolean')
            errorAtNode(node, `condition must be boolean, got ${describe(typeOf(cond))}`);
        return cond;
    }

    private lowerVariableStatement(node: ts.VariableStatement): HirStmt {
        const list = node.declarationList;
        if (!(list.flags & ts.NodeFlags.BlockScoped)) errorAtNode(node, "'var' is not supported; use let or const");
        if (list.declarations.length !== 1)
            errorAtNode(node, 'only one declarator per let/const statement is supported');
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
            errorAtNode(
                node.expression,
                `cannot return ${describe(typeOf(expr))} from a function returning ${describe(rt)}`,
            );
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
        if (node.kind === ts.SyntaxKind.ThisKeyword) return this.lowerThis(node);
        if (ts.isNewExpression(node)) return this.lowerNew(node);
        if (ts.isPropertyAccessExpression(node)) return this.lowerFieldAccess(node);
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            return errorAtNode(node, 'closures are not supported in v1');
        }
        if (ts.isAwaitExpression(node))
            return errorAtNode(node, 'await is not supported (async is not supported in v1)');
        return errorAtNode(node, `unsupported expression (${ts.SyntaxKind[node.kind]})`);
    }

    private lowerThis(node: ts.Expression): HirExpr {
        const cls = this.fn.thisClass;
        if (!cls) return errorAtNode(node, "'this' is only available inside class methods");
        return { k: 'this', type: { kind: 'object', className: cls } };
    }

    /** The user class an expression's value is an instance of, or an error. */
    private classOf(object: HirExpr, node: ts.Node): { name: string; sig: ClassSig } {
        const t = typeOf(object);
        const sig = t.kind === 'object' ? this.classes.get(t.className) : undefined;
        if (t.kind !== 'object' || !sig) return errorAtNode(node, `'${describe(t)}' has no fields or methods`);
        return { name: t.className, sig };
    }

    private lowerFieldAccess(node: ts.PropertyAccessExpression): Extract<HirExpr, { k: 'field' }> {
        if (node.questionDotToken) errorAtNode(node, 'optional chaining is not supported');
        if (!ts.isIdentifier(node.name)) errorAtNode(node.name, 'private names are not supported');
        const object = this.lowerExpr(node.expression);
        const { name: owner, sig } = this.classOf(object, node.expression);
        const type = sig.fields.get(node.name.text);
        if (!type) {
            const hint = sig.methods.has(node.name.text) ? ' (methods can only be called)' : '';
            errorAtNode(node.name, `'${owner}' has no field '${node.name.text}'${hint}`);
        }
        return { k: 'field', object, owner, name: node.name.text, type };
    }

    private lowerNew(node: ts.NewExpression): HirExpr {
        if (node.typeArguments?.length) errorAtNode(node, 'type arguments are not supported');
        if (!ts.isIdentifier(node.expression)) return errorAtNode(node.expression, 'unsupported new target');
        const name = node.expression.text;
        const sig = this.classes.get(name);
        if (!sig) return errorAtNode(node.expression, `unknown class '${name}'`);
        const args = this.lowerArgs(node.arguments ?? [], node, `new ${name}`, sig.ctorParams);
        return { k: 'new', className: name, args, resultType: { kind: 'object', className: name } };
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
            errorAtNode(
                node.operatorToken,
                `operator '${node.operatorToken.getText()}' can't be applied to ${describe(lt)} and ${describe(rt)}`,
            );

        switch (op) {
            case '+':
                if (lt.kind === 'void' || rt.kind === 'void') return bad();
                if (lt.kind === 'string' || rt.kind === 'string')
                    return { k: 'binary', op, left, right, resultType: STRING };
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
                if (lt.kind === 'f64' && rt.kind === 'f64')
                    return { k: 'binary', op, left, right, resultType: BOOLEAN };
                return bad();
            case '&&':
            case '||':
                if (lt.kind === 'boolean' && rt.kind === 'boolean')
                    return { k: 'binary', op, left, right, resultType: BOOLEAN };
                return bad();
        }
    }

    private lowerAssign(node: ts.BinaryExpression): HirExpr {
        if (ts.isPropertyAccessExpression(node.left)) {
            const target = this.lowerFieldAccess(node.left);
            const rhs = this.lowerExpr(node.right);
            if (!assignable(typeOf(rhs), target.type)) {
                errorAtNode(node.right, `cannot assign ${describe(typeOf(rhs))} to ${describe(target.type)}`);
            }
            return {
                k: 'set-field',
                object: target.object,
                owner: target.owner,
                name: target.name,
                type: target.type,
                rhs,
            };
        }
        if (!ts.isIdentifier(node.left)) return errorAtNode(node.left, 'can only assign to a variable or a field');
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
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
            const target = callee.expression;
            if (ts.isIdentifier(target) && !this.lookup(target.text) && this.registry.has(target.text)) {
                return this.lowerForeignCall(node, target, callee.name);
            }
            return this.lowerMethodCall(node, callee, callee.name);
        }
        return errorAtNode(node, 'unsupported call target');
    }

    private lowerLocalCall(node: ts.CallExpression, callee: ts.Identifier): HirExpr {
        const name = callee.text;
        if (this.lookup(name)) errorAtNode(callee, `'${name}' is a variable, not a function`);
        const sig = this.functions.get(name);
        if (!sig) return errorAtNode(callee, `unknown function '${name}'`);
        const args = this.lowerArgs(node.arguments, node, name, sig.params);
        return { k: 'call', calleeName: name, args, resultType: sig.returnType };
    }

    private lowerMethodCall(
        node: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
        method: ts.Identifier,
    ): HirExpr {
        const object = this.lowerExpr(callee.expression);
        const { name: owner, sig } = this.classOf(object, callee.expression);
        const msig = sig.methods.get(method.text);
        if (!msig) return errorAtNode(method, `'${owner}' has no method '${method.text}'`);
        const args = this.lowerArgs(node.arguments, node, `${owner}.${method.text}`, msig.params);
        return { k: 'call-method', object, owner, name: method.text, args, resultType: msig.returnType };
    }

    /** Checks the argument count and that each argument can be passed as its parameter type. */
    private lowerArgs(
        argNodes: readonly ts.Expression[],
        node: ts.Node,
        label: string,
        params: ValueType[],
    ): HirExpr[] {
        if (argNodes.length !== params.length) {
            errorAtNode(node, `'${label}' expects ${params.length} arguments, got ${argNodes.length}`);
        }
        return argNodes.map((a, i) => {
            const arg = this.lowerExpr(a);
            if (!assignable(typeOf(arg), params[i]!)) {
                errorAtNode(
                    a,
                    `argument ${i + 1} of '${label}': cannot pass ${describe(typeOf(arg))} as ${describe(params[i]!)}`,
                );
            }
            return arg;
        });
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
        return {
            k: 'call',
            calleeName: qualified,
            args,
            resultType: match.returnType,
            foreign: { owner: cls.jvmInternalName, method: match },
        };
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
