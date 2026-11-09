import * as ts from 'typescript';
import { parseMethodDescriptor } from '../classfile/descriptors.ts';
import { errorAtNode, FrontendError } from './errors.ts';
import {
    descriptorOf,
    type HirBinaryOp,
    type HirClass,
    type HirExpr,
    type HirFunction,
    type HirLocal,
    type HirParam,
    type HirProgram,
    type HirStmt,
    type ValueType,
} from './hir.ts';
import type { ClassResolver, ForeignMethod } from './type-registry.ts';

export interface CompileOptions {
    classes: ClassResolver;
    fileName: string;
    /** Prepended to user class names to form JVM internal names, e.g. `com/example/app/`. */
    classPrefix?: string;
}

const F64: ValueType = { kind: 'f64' };
const BOOLEAN: ValueType = { kind: 'boolean' };
const STRING: ValueType = { kind: 'string' };
const NULL: ValueType = { kind: 'null' };
const VOID: ValueType = { kind: 'void' };
const OBJECT_NAME = 'java/lang/Object';
const OBJECT: ValueType = { kind: 'object', className: OBJECT_NAME };

interface VarInfo {
    slot: number;
    type: ValueType;
}

interface FunctionSig {
    params: ValueType[];
    returnType: ValueType;
}

/** Methods and constructors, user-written or from an existing class, share one shape. */
type Method = ForeignMethod;

interface ClassSig {
    /** JVM internal name. */
    internal: string;
    /** JVM internal name of the superclass. */
    superName: string;
    fields: Map<string, ValueType>;
    /** The explicit constructor, if the class has one. */
    ctor: Method | null;
    methods: Map<string, Method>;
}

type Callable = ts.FunctionDeclaration | ts.MethodDeclaration;

/** Per-function lowering state. */
interface FnCtx {
    scopes: Map<string, VarInfo>[];
    nextSlot: number;
    locals: HirLocal[];
    returnType: ValueType;
    /** JVM internal name of the enclosing class inside methods and constructors, else null. */
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
        noResolve: true, // imports are Java packages, not files
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

function methodOf(name: string, sig: FunctionSig): Method {
    const descriptor = `(${sig.params.map(descriptorOf).join('')})${descriptorOf(sig.returnType)}`;
    return { name, params: sig.params, returnType: sig.returnType, isStatic: false, descriptor };
}

const IMPLICIT_CTOR: Method = { name: '<init>', params: [], returnType: VOID, isStatic: false, descriptor: '()V' };

class Lowerer {
    private readonly checker: ts.TypeChecker;
    private readonly resolver: ClassResolver;
    private readonly prefix: string;
    private readonly functions = new Map<string, FunctionSig>();
    /** User classes by their TS name, and by JVM internal name. */
    private readonly classes = new Map<string, ClassSig>();
    private readonly byInternal = new Map<string, ClassSig>();
    /** Names that refer to existing JVM classes (imports and the implicit `Math`): local name -> internal name. */
    private readonly foreign = new Map<string, string>();
    private fn!: FnCtx;

    constructor(checker: ts.TypeChecker, opts: CompileOptions) {
        this.checker = checker;
        this.resolver = opts.classes;
        this.prefix = opts.classPrefix ?? '';
    }

    // ---- top level ---------------------------------------------------------

    lowerFile(sf: ts.SourceFile): HirProgram {
        if (this.resolver.lookup('java/lang/Math')) this.foreign.set('Math', 'java/lang/Math');

        const fnDecls: ts.FunctionDeclaration[] = [];
        const classDecls: ts.ClassDeclaration[] = [];
        // Pass 1: names, so signatures can mention classes declared later in the file.
        for (const stmt of sf.statements) {
            if (ts.isImportDeclaration(stmt)) {
                this.declareImport(stmt);
            } else if (ts.isFunctionDeclaration(stmt)) {
                fnDecls.push(stmt);
            } else if (ts.isClassDeclaration(stmt)) {
                const name = this.classNameOf(stmt);
                const sig: ClassSig = {
                    internal: this.prefix + name,
                    superName: OBJECT_NAME,
                    fields: new Map(),
                    ctor: null,
                    methods: new Map(),
                };
                this.classes.set(name, sig);
                this.byInternal.set(sig.internal, sig);
                classDecls.push(stmt);
            } else {
                errorAtNode(stmt, 'unsupported top-level statement');
            }
        }
        // Pass 2: superclasses, then signatures.
        for (const decl of classDecls) this.resolveSuper(decl);
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

    /** `import { Activity } from 'android.app'` binds `Activity` to `android/app/Activity`. */
    private declareImport(node: ts.ImportDeclaration): void {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings)) {
            errorAtNode(node, "only named imports are supported: import { Name } from 'java.package'");
        }
        const module = (node.moduleSpecifier as ts.StringLiteral).text;
        if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(module)) {
            errorAtNode(node.moduleSpecifier, `'${module}' is not a Java package (for example 'android.widget')`);
        }
        for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            const local = el.name.text;
            const internal = `${module.replaceAll('.', '/')}/${imported}`;
            if (!this.resolver.lookup(internal)) errorAtNode(el, `class '${module}.${imported}' not found`);
            if (this.foreign.has(local) || this.classes.has(local)) errorAtNode(el.name, `duplicate name '${local}'`);
            this.foreign.set(local, internal);
        }
    }

    private classNameOf(node: ts.ClassDeclaration): string {
        if (!node.name) errorAtNode(node, 'anonymous classes are not supported');
        const name = node.name.text;
        if (this.classes.has(name) || this.foreign.has(name)) errorAtNode(node.name, `duplicate class '${name}'`);
        for (const m of node.modifiers ?? []) errorAtNode(m, `unsupported modifier '${m.getText()}'`);
        if (node.typeParameters?.length) errorAtNode(node, 'generic classes are not supported in v1');
        return name;
    }

    /** `class A extends B`: B is a user class or an imported class. */
    private resolveSuper(node: ts.ClassDeclaration): void {
        const sig = this.classes.get(node.name!.text)!;
        const clauses = node.heritageClauses ?? [];
        if (clauses.length === 0) return;
        const clause = clauses[0]!;
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword || clauses.length > 1) {
            errorAtNode(clause, "'implements' is not supported yet");
        }
        const target = clause.types[0]!;
        if (!ts.isIdentifier(target.expression) || target.typeArguments?.length) {
            errorAtNode(target, 'a class can only extend a plain class name');
        }
        const name = target.expression.text;
        const internal = this.classes.get(name)?.internal ?? this.foreign.get(name);
        if (!internal) errorAtNode(target, `unknown class '${name}'`);
        if (this.resolver.lookup(internal)?.isInterface) errorAtNode(target, `cannot extend interface '${name}'`);
        sig.superName = internal;

        let steps = 0;
        for (let c = this.byInternal.get(internal); c; c = this.byInternal.get(c.superName)) {
            if (c === sig || ++steps > this.classes.size) {
                errorAtNode(node, `circular inheritance involving '${name}'`);
            }
        }
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

    private paramType(p: ts.ParameterDeclaration): ValueType {
        return (p.type && this.typeFromNode(p.type)) || this.mapType(this.checker.getTypeAtLocation(p), p);
    }

    private signatureOf(node: Callable): FunctionSig {
        const params = node.parameters.map((p) => this.paramType(p));
        const declared = node.type && this.typeFromNode(node.type);
        if (declared) return { params, returnType: declared };
        const sig = this.checker.getSignatureFromDeclaration(node);
        if (!sig) errorAtNode(node, 'cannot resolve function signature');
        return { params, returnType: this.mapType(this.checker.getReturnTypeOfSignature(sig), node, 'return') };
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
                const type =
                    (member.type && this.typeFromNode(member.type)) ||
                    this.mapType(this.checker.getTypeAtLocation(member.name), member.name);
                sig.fields.set(fname, type);
            } else if (ts.isMethodDeclaration(member)) {
                this.validateCallable(member);
                const mname = (member.name as ts.Identifier).text;
                if (sig.fields.has(mname) || sig.methods.has(mname))
                    errorAtNode(member.name, `duplicate member '${mname}'`);
                const method = methodOf(mname, this.signatureOf(member));
                this.checkOverride(sig, method, member.name);
                sig.methods.set(mname, method);
            } else if (ts.isConstructorDeclaration(member)) {
                if (sawCtor) errorAtNode(member, 'a class can have only one constructor');
                sawCtor = true;
                for (const m of member.modifiers ?? []) errorAtNode(m, `unsupported modifier '${m.getText()}'`);
                if (!member.body) errorAtNode(member, 'constructor must have a body');
                this.validateParams(member.parameters);
                const params = member.parameters.map((p) => this.paramType(p));
                sig.ctor = methodOf('<init>', { params, returnType: VOID });
            } else {
                errorAtNode(member, `unsupported class member (${ts.SyntaxKind[member.kind]})`);
            }
        }
    }

    /**
     * A method that shares a name and arity with an inherited one must have its exact JVM signature, or it
     * silently wouldn't override anything. (E.g. Android's `onKeyDown(int, KeyEvent)` takes an int, which a TS
     * `number` parameter can't match.)
     */
    private checkOverride(sig: ClassSig, method: Method, node: ts.Node): void {
        const inherited = this.methodsNamed(sig.superName, method.name).filter(
            (m) => !m.isStatic && m.params.length === method.params.length,
        );
        if (inherited.length > 0 && !inherited.some((m) => m.descriptor === method.descriptor)) {
            errorAtNode(
                node,
                `'${method.name}' doesn't match the JVM signature of the inherited method ` +
                    `(${inherited.map((m) => m.descriptor).join(' or ')}; this one is ${method.descriptor}). ` +
                    `Overriding methods that take Java int/float/long parameters isn't supported yet`,
            );
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
                const m = sig.methods.get(mname)!;
                methods.push(this.lowerCallable(member, mname, m, sig.internal));
            } else if (ts.isConstructorDeclaration(member)) {
                ctorNode = member;
            }
        }
        const fields = [...sig.fields].map(([fname, type]) => ({ name: fname, type }));
        const { ctor, superCall } = this.lowerConstructor(node, ctorNode, sig);
        return { name: sig.internal, superName: sig.superName, superCall, fields, ctor, methods };
    }

    /**
     * The super constructor call runs first, then field initializers, then the rest of the body.
     * Initializers can't see the constructor's parameters; `super(...)` arguments can.
     */
    private lowerConstructor(
        cls: ts.ClassDeclaration,
        node: ts.ConstructorDeclaration | undefined,
        sig: ClassSig,
    ): { ctor: HirFunction; superCall: HirClass['superCall'] } {
        const self: ValueType = { kind: 'object', className: sig.internal };
        this.fn = { scopes: [new Map()], nextSlot: 1, locals: [], returnType: VOID, thisClass: sig.internal };

        const inits: HirStmt[] = [];
        for (const m of cls.members) {
            if (!ts.isPropertyDeclaration(m) || !m.initializer) continue;
            const fname = (m.name as ts.Identifier).text;
            const type = sig.fields.get(fname)!;
            const rhs = this.lowerExpr(m.initializer);
            if (!this.assignable(typeOf(rhs), type)) {
                errorAtNode(m.initializer, `cannot assign ${describe(typeOf(rhs))} to ${describe(type)}`);
            }
            inits.push({
                k: 'expr',
                expr: {
                    k: 'set-field',
                    object: { k: 'this', type: self },
                    owner: sig.internal,
                    name: fname,
                    type,
                    rhs,
                },
            });
        }

        const ctorSig = sig.ctor ?? IMPLICIT_CTOR;
        const params: HirParam[] = (node?.parameters ?? []).map((p, i) => {
            const pname = (p.name as ts.Identifier).text;
            const type = ctorSig.params[i]!;
            return { name: pname, type, slot: this.declareSlot(pname, type, p.name) };
        });

        let rest: readonly ts.Statement[] = node?.body?.statements ?? [];
        const first = rest[0];
        const superNode =
            first &&
            ts.isExpressionStatement(first) &&
            ts.isCallExpression(first.expression) &&
            first.expression.expression.kind === ts.SyntaxKind.SuperKeyword
                ? first.expression
                : undefined;
        if (superNode) rest = rest.slice(1);

        const superCtors = this.ctorsOf(sig.superName);
        let superCall: HirClass['superCall'];
        if (superNode) {
            const { method, args } = this.resolveCall('super', superCtors, superNode.arguments, superNode);
            superCall = { descriptor: method.descriptor, args };
        } else {
            const implicit = this.pick(superCtors, []);
            if (!implicit) {
                errorAtNode(cls, `'${sig.superName}' has no constructor without arguments; call super(...) explicitly`);
            }
            superCall = { descriptor: implicit.descriptor, args: [] };
        }

        const body: HirStmt = this.withScope(() => ({ k: 'block', stmts: rest.map((s) => this.lowerStmt(s)) }));
        const ctor: HirFunction = {
            name: '<init>',
            params,
            returnType: VOID,
            locals: this.fn.locals,
            body: { k: 'block', stmts: [...inits, body] },
        };
        return { ctor, superCall };
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

    /**
     * Resolves a written type that names a class (`Bundle`, `Counter`, `Bundle | null`) without asking the checker,
     * which can't see imported Java classes. Anything else returns undefined and goes through the checker.
     */
    private typeFromNode(node: ts.TypeNode): ValueType | undefined {
        if (ts.isParenthesizedTypeNode(node)) return this.typeFromNode(node.type);
        if (ts.isUnionTypeNode(node)) {
            const isNullish = (t: ts.TypeNode): boolean =>
                t.kind === ts.SyntaxKind.UndefinedKeyword ||
                (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword);
            const rest = node.types.filter((t) => !isNullish(t));
            return rest.length === 1 && rest.length < node.types.length ? this.typeFromNode(rest[0]!) : undefined;
        }
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const name = node.typeName.text;
            const internal = this.classes.get(name)?.internal ?? this.foreign.get(name);
            return internal ? { kind: 'object', className: internal } : undefined;
        }
        return undefined;
    }

    private mapType(type: ts.Type, node: ts.Node, position: 'value' | 'return' = 'value'): ValueType {
        const f = type.flags;
        if (f & ts.TypeFlags.NumberLike) return F64;
        if (f & ts.TypeFlags.StringLike) return STRING;
        if (f & ts.TypeFlags.BooleanLike) return BOOLEAN; // before Union: `boolean` is true | false
        if (f & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return position === 'return' ? VOID : NULL;
        if (f & ts.TypeFlags.Null) return NULL;
        if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union)) return OBJECT;
        const decl = type.symbol?.valueDeclaration;
        if (decl && ts.isClassDeclaration(decl) && decl.name) {
            const sig = this.classes.get(decl.name.text);
            if (sig) return { kind: 'object', className: sig.internal };
        }
        return errorAtNode(node, `unsupported type '${this.checker.typeToString(type)}'`);
    }

    // ---- class hierarchy ---------------------------------------------------

    private parentsOf(cls: string): string[] {
        const user = this.byInternal.get(cls);
        if (user) return [user.superName];
        const f = this.resolver.lookup(cls);
        return f ? [...(f.superName ? [f.superName] : []), ...f.interfaces] : [];
    }

    private isSubclass(a: string, b: string): boolean {
        const seen = new Set<string>([a]);
        for (const c of seen) {
            if (c === b) return true;
            for (const p of this.parentsOf(c)) seen.add(p);
        }
        return false;
    }

    /** Exact match, widening to Object (which boxes numbers and booleans), a subclass for a superclass, or null. */
    private assignable(from: ValueType, to: ValueType): boolean {
        if (from.kind === 'void') return false;
        if (typesEqual(from, to)) return true;
        if (to.kind !== 'object') return false;
        if (to.className === OBJECT_NAME || from.kind === 'null') return true;
        if (from.kind === 'object') return this.isSubclass(from.className, to.className);
        if (from.kind === 'string') return this.isSubclass('java/lang/String', to.className);
        return false;
    }

    /** All methods called `name` visible on `cls`: its own first, then inherited ones. */
    private methodsNamed(cls: string, name: string): Method[] {
        const found: Method[] = [];
        const keys = new Set<string>();
        const visited = new Set<string>([cls]);
        for (const c of visited) {
            const user = this.byInternal.get(c);
            const own: Method[] = user
                ? [user.methods.get(name)].filter((m) => m !== undefined)
                : (this.resolver.lookup(c)?.methods.filter((m) => m.name === name) ?? []);
            for (const m of own) {
                const key = `${m.isStatic}${m.descriptor}`;
                if (!keys.has(key)) {
                    keys.add(key);
                    found.push(m);
                }
            }
            for (const p of this.parentsOf(c)) visited.add(p);
        }
        return found;
    }

    private ctorsOf(cls: string): Method[] {
        const user = this.byInternal.get(cls);
        if (user) return [user.ctor ?? IMPLICIT_CTOR];
        return this.resolver.lookup(cls)?.ctors ?? [];
    }

    private fieldOf(cls: string, name: string): ValueType | undefined {
        for (let c = this.byInternal.get(cls); c; c = this.byInternal.get(c.superName)) {
            const f = c.fields.get(name);
            if (f) return f;
        }
        return undefined;
    }

    // ---- overload resolution -----------------------------------------------

    /** How well `from` fits a parameter (`to` in TS terms, `jvm` in JVM terms): undefined if it doesn't, else a cost. */
    private argCost(from: ValueType, to: ValueType, jvm: string): number | undefined {
        if (!this.assignable(from, to)) return undefined;
        let cost = 0;
        if (from.kind === 'f64' && jvm !== 'D' && jvm !== 'Ljava/lang/Object;') cost += 1; // narrowing to int/float/long
        if (to.kind === 'object' && to.className === OBJECT_NAME && !typesEqual(from, to)) {
            cost += from.kind === 'f64' || from.kind === 'boolean' ? 2 : 1; // boxing, or just a wide parameter
        }
        return cost;
    }

    /** The cheapest overload the arguments fit, or undefined. */
    private pick(candidates: Method[], args: HirExpr[]): Method | undefined {
        let best: Method | undefined;
        let bestCost = Infinity;
        for (const m of candidates) {
            if (m.params.length !== args.length) continue;
            const jvm = parseMethodDescriptor(m.descriptor).params;
            let total: number | undefined = 0;
            for (let i = 0; i < args.length && total !== undefined; i++) {
                const c = this.argCost(typeOf(args[i]!), m.params[i]!, jvm[i]!);
                total = c === undefined ? undefined : total + c;
            }
            if (total !== undefined && total < bestCost) {
                best = m;
                bestCost = total;
            }
        }
        return best;
    }

    /** Lowers the arguments and chooses the overload. One candidate gets precise argument errors. */
    private resolveCall(
        label: string,
        candidates: Method[],
        argNodes: readonly ts.Expression[],
        node: ts.Node,
    ): { method: Method; args: HirExpr[] } {
        if (candidates.length === 1) {
            const only = candidates[0]!;
            return { method: only, args: this.lowerArgs(argNodes, node, label, only.params) };
        }
        const args = argNodes.map((a) => this.lowerExpr(a));
        const method = this.pick(candidates, args);
        if (!method) {
            const shape = (m: Method): string => `(${m.params.map(describe).join(', ')})`;
            errorAtNode(
                node,
                `no overload of '${label}' accepts (${args.map((a) => describe(typeOf(a))).join(', ')})` +
                    (candidates.length ? `; expected ${candidates.map(shape).join(' or ')}` : ''),
            );
        }
        return { method, args };
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
        let type =
            (decl.type && this.typeFromNode(decl.type)) ||
            this.mapType(this.checker.getTypeAtLocation(decl.name), decl.name);
        // The checker can't see imported Java classes: `new TextView(...)` and `Integer.parseInt(s) + 1` are `any`
        // to it, but the initializer's own type is known.
        if (!decl.type && init && typesEqual(type, OBJECT)) {
            const t = typeOf(init);
            if (t.kind !== 'void' && t.kind !== 'null') type = t;
        }
        if (init && !this.assignable(typeOf(init), type)) {
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
        if (!this.assignable(typeOf(expr), rt)) {
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

    private lowerFieldAccess(node: ts.PropertyAccessExpression): Extract<HirExpr, { k: 'field' }> {
        if (node.questionDotToken) errorAtNode(node, 'optional chaining is not supported');
        if (!ts.isIdentifier(node.name)) errorAtNode(node.name, 'private names are not supported');
        const object = this.lowerExpr(node.expression);
        const t = typeOf(object);
        if (t.kind !== 'object') return errorAtNode(node.expression, `'${describe(t)}' has no fields or methods`);
        const type = this.fieldOf(t.className, node.name.text);
        if (!type) {
            const hint = this.methodsNamed(t.className, node.name.text).length ? ' (methods can only be called)' : '';
            errorAtNode(node.name, `'${t.className}' has no field '${node.name.text}'${hint}`);
        }
        return { k: 'field', object, owner: t.className, name: node.name.text, type };
    }

    private lowerNew(node: ts.NewExpression): HirExpr {
        if (node.typeArguments?.length) errorAtNode(node, 'type arguments are not supported');
        if (!ts.isIdentifier(node.expression)) return errorAtNode(node.expression, 'unsupported new target');
        const name = node.expression.text;
        const internal = this.classes.get(name)?.internal ?? this.foreign.get(name);
        if (!internal) return errorAtNode(node.expression, `unknown class '${name}'`);
        const { method, args } = this.resolveCall(`new ${name}`, this.ctorsOf(internal), node.arguments ?? [], node);
        return {
            k: 'new',
            className: internal,
            descriptor: method.descriptor,
            args,
            resultType: { kind: 'object', className: internal },
        };
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
            if (!this.assignable(typeOf(rhs), target.type)) {
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
        if (!this.assignable(typeOf(rhs), v.type)) {
            errorAtNode(node.right, `cannot assign ${describe(typeOf(rhs))} to ${describe(v.type)}`);
        }
        return { k: 'assign', slot: v.slot, type: v.type, rhs };
    }

    // ---- calls -------------------------------------------------------------

    private lowerCall(node: ts.CallExpression): HirExpr {
        if (node.questionDotToken) errorAtNode(node, 'optional chaining is not supported');
        if (node.typeArguments?.length) errorAtNode(node, 'type arguments are not supported');
        const callee = node.expression;

        if (ts.isIdentifier(callee)) return this.lowerLocalCall(node, callee);
        if (callee.kind === ts.SyntaxKind.SuperKeyword) {
            return errorAtNode(node, 'super(...) must be the first statement of a constructor');
        }
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
            const target = callee.expression;
            if (target.kind === ts.SyntaxKind.SuperKeyword) return this.lowerSuperMethodCall(node, callee.name);
            if (ts.isIdentifier(target) && !this.lookup(target.text)) {
                const internal = this.foreign.get(target.text);
                if (internal) return this.lowerStaticCall(node, target.text, internal, callee.name);
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

    /** `Math.abs(x)`, `Log.d(a, b)`: a static method of an existing class. */
    private lowerStaticCall(node: ts.CallExpression, local: string, owner: string, method: ts.Identifier): HirExpr {
        const qualified = `${local}.${method.text}`;
        const candidates = this.methodsNamed(owner, method.text).filter((m) => m.isStatic);
        if (candidates.length === 0) errorAtNode(method, `unknown method '${qualified}'`);
        const { method: chosen, args } = this.resolveCall(qualified, candidates, node.arguments, node);
        return {
            k: 'call',
            calleeName: qualified,
            args,
            resultType: chosen.returnType,
            foreign: { owner, method: chosen },
        };
    }

    private lowerMethodCall(
        node: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
        name: ts.Identifier,
    ): HirExpr {
        const object = this.lowerExpr(callee.expression);
        const t = typeOf(object);
        if (t.kind !== 'object') return errorAtNode(callee.expression, `'${describe(t)}' has no fields or methods`);
        const candidates = this.methodsNamed(t.className, name.text).filter((m) => !m.isStatic);
        if (candidates.length === 0) errorAtNode(name, `'${t.className}' has no method '${name.text}'`);
        const { method, args } = this.resolveCall(`${t.className}.${name.text}`, candidates, node.arguments, node);
        return {
            k: 'call-method',
            object,
            owner: t.className,
            name: name.text,
            descriptor: method.descriptor,
            args,
            resultType: method.returnType,
            ...(this.resolver.lookup(t.className)?.isInterface ? { iface: true as const } : {}),
        };
    }

    /** `super.m(args)`: a non-virtual call to the superclass's method. */
    private lowerSuperMethodCall(node: ts.CallExpression, name: ts.Identifier): HirExpr {
        const cls = this.fn.thisClass;
        const sig = cls ? this.byInternal.get(cls) : undefined;
        if (!cls || !sig) return errorAtNode(node, "'super' is only available inside class methods");
        const candidates = this.methodsNamed(sig.superName, name.text).filter((m) => !m.isStatic);
        if (candidates.length === 0) errorAtNode(name, `'${sig.superName}' has no method '${name.text}'`);
        const { method, args } = this.resolveCall(`super.${name.text}`, candidates, node.arguments, node);
        return {
            k: 'call-method',
            object: { k: 'this', type: { kind: 'object', className: cls } },
            owner: sig.superName,
            name: name.text,
            descriptor: method.descriptor,
            args,
            resultType: method.returnType,
            special: true,
        };
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
            if (!this.assignable(typeOf(arg), params[i]!)) {
                errorAtNode(
                    a,
                    `argument ${i + 1} of '${label}': cannot pass ${describe(typeOf(arg))} as ${describe(params[i]!)}`,
                );
            }
            return arg;
        });
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
