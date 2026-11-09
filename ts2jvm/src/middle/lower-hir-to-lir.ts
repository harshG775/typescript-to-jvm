import type { HirClass, HirExpr, HirFunction, HirProgram, HirStmt, ValueType } from '../frontend/hir.ts';
import {
    D_BOOLEAN,
    D_DOUBLE,
    D_OBJECT,
    D_RUNTIME_EXCEPTION,
    D_STRING,
    D_VOID,
    type CompareOp,
    type Desc,
    type DoubleOp,
    type LirClass,
    type LirExpr,
    type LirFunction,
    type LirProgram,
    type LirStmt,
} from './lir.ts';

export interface LirOptions {
    /** JVM internal name of the class that will hold the functions, e.g. `app/Main`. */
    className: string;
}

export function descOf(t: ValueType): Desc {
    switch (t.kind) {
        case 'f64':
            return D_DOUBLE;
        case 'boolean':
            return D_BOOLEAN;
        case 'string':
            return D_STRING;
        case 'null':
            return D_OBJECT;
        case 'void':
            return D_VOID;
        case 'object':
            return `L${t.className};`;
    }
}

function functionDescriptor(fn: HirFunction): string {
    return `(${fn.params.map((p) => descOf(p.type)).join('')})${descOf(fn.returnType)}`;
}

const DOUBLE_OPS: Partial<Record<string, DoubleOp>> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem' };
const COMPARE_OPS: Partial<Record<string, CompareOp>> = {
    '<': '<',
    '<=': '<=',
    '>': '>',
    '>=': '>=',
    '==': '==',
    '!=': '!=',
};

export function lowerHirToLir(program: HirProgram, opts: LirOptions): LirProgram {
    const fns = new Map(program.functions.map((f) => [f.name, f]));
    const classes = new Map(program.classes.map((c) => [c.name, c]));
    const lowerer = new Lowerer(opts.className, fns, classes);
    return {
        className: opts.className,
        functions: program.functions.map((f) => lowerer.lowerFunction(f)),
        classes: program.classes.map((c) => lowerer.lowerClass(c)),
    };
}

class Lowerer {
    private readonly className: string;
    private readonly fns: Map<string, HirFunction>;
    private readonly classes: Map<string, HirClass>;
    private returnType: ValueType = { kind: 'void' };

    constructor(className: string, fns: Map<string, HirFunction>, classes: Map<string, HirClass>) {
        this.className = className;
        this.fns = fns;
        this.classes = classes;
    }

    lowerClass(c: HirClass): LirClass {
        const ctor = this.lowerFunction(c.ctor);
        const superCall: LirStmt = {
            k: 'expr',
            expr: {
                k: 'invoke',
                kind: 'special',
                owner: 'java/lang/Object',
                name: '<init>',
                descriptor: '()V',
                object: { k: 'load', slot: 0, desc: `L${c.name};` },
                args: [],
                desc: D_VOID,
            },
        };
        return {
            name: c.name,
            fields: c.fields.map((f) => ({ name: f.name, desc: descOf(f.type) })),
            ctor: { ...ctor, body: { k: 'block', stmts: [superCall, ctor.body] } },
            methods: c.methods.map((m) => this.lowerFunction(m)),
        };
    }

    lowerFunction(fn: HirFunction): LirFunction {
        this.returnType = fn.returnType;
        return {
            name: fn.name,
            descriptor: functionDescriptor(fn),
            params: fn.params.map((p) => ({ name: p.name, desc: descOf(p.type), slot: p.slot })),
            locals: fn.locals.map((l) => ({ name: l.name, desc: descOf(l.type), slot: l.slot })),
            body: this.stmt(fn.body),
        };
    }

    // ---- statements --------------------------------------------------------

    private stmt(s: HirStmt): LirStmt {
        switch (s.k) {
            case 'block':
                return { k: 'block', stmts: s.stmts.map((c) => this.stmt(c)) };
            case 'var-decl': {
                const desc = descOf(s.type);
                const value = s.init ? this.coerce(this.expr(s.init), s.type) : defaultValue(desc);
                return { k: 'store', slot: s.slot, desc, value };
            }
            case 'expr': {
                const e = this.expr(s.expr);
                // `x = v;` as a statement doesn't need the value left on the stack.
                if (e.k === 'store') return { k: 'store', slot: e.slot, desc: e.desc, value: e.value };
                if (e.k === 'putfield') return { ...e };
                return { k: 'expr', expr: e };
            }
            case 'if':
                return {
                    k: 'if',
                    cond: this.expr(s.cond),
                    then: this.stmt(s.then),
                    else_: s.else_ ? this.stmt(s.else_) : null,
                };
            case 'while':
                return { k: 'while', cond: this.expr(s.cond), body: this.stmt(s.body) };
            case 'return':
                return { k: 'return', value: s.expr ? this.coerce(this.expr(s.expr), this.returnType) : null };
            case 'throw':
                return { k: 'throw', expr: this.throwable(this.expr(s.expr)) };
            case 'try':
                return {
                    k: 'try',
                    body: this.stmt(s.try_),
                    catch_: s.catch_ ? { slot: s.catchVar?.slot ?? null, body: this.stmt(s.catch_) } : null,
                    finally_: s.finally_ ? this.stmt(s.finally_) : null,
                };
        }
    }

    /** Strings become `new RuntimeException(msg)`; any other reference is a caught error being rethrown. */
    private throwable(e: LirExpr): LirExpr {
        if (e.desc === D_STRING) return { k: 'new-exception', message: e, desc: D_RUNTIME_EXCEPTION };
        if (e.desc.startsWith('L')) {
            return { k: 'checkcast', cls: 'java/lang/Throwable', operand: e, desc: 'Ljava/lang/Throwable;' };
        }
        throw new Error(`cannot throw a value of type ${e.desc}`);
    }

    // ---- expressions -------------------------------------------------------

    /** Widens `e` to `to`. HIR only allows exact matches and widening to Object, which boxes primitives. */
    private coerce(e: LirExpr, to: ValueType): LirExpr {
        if (
            to.kind === 'object' &&
            to.className === 'java/lang/Object' &&
            (e.desc === D_DOUBLE || e.desc === D_BOOLEAN)
        ) {
            return { k: 'box', operand: e, desc: D_OBJECT };
        }
        return e;
    }

    private expr(e: HirExpr): LirExpr {
        switch (e.k) {
            case 'num':
                return { k: 'dconst', value: e.value, desc: D_DOUBLE };
            case 'str':
                return { k: 'sconst', value: e.value, desc: D_STRING };
            case 'bool':
                return { k: 'bconst', value: e.value, desc: D_BOOLEAN };
            case 'null':
            case 'undefined':
                return { k: 'null', desc: D_OBJECT };
            case 'local':
                return { k: 'load', slot: e.slot, desc: descOf(e.type) };
            case 'assign':
                return { k: 'store', slot: e.slot, desc: descOf(e.type), value: this.coerce(this.expr(e.rhs), e.type) };
            case 'unary': {
                const operand = this.expr(e.operand);
                return e.op === '-' ? { k: 'dneg', operand, desc: D_DOUBLE } : { k: 'not', operand, desc: D_BOOLEAN };
            }
            case 'binary':
                return this.binary(e);
            case 'cond':
                return {
                    k: 'cond',
                    cond: this.expr(e.cond),
                    then: this.coerce(this.expr(e.then), e.resultType),
                    else_: this.coerce(this.expr(e.else_), e.resultType),
                    desc: descOf(e.resultType),
                };
            case 'call':
                return this.call(e);
            case 'this':
                return { k: 'load', slot: 0, desc: descOf(e.type) };
            case 'new': {
                const ctor = this.classOf(e.className).ctor;
                return {
                    k: 'new',
                    cls: e.className,
                    descriptor: functionDescriptor(ctor),
                    args: e.args.map((a, i) => this.coerce(this.expr(a), ctor.params[i]!.type)),
                    desc: descOf(e.resultType),
                };
            }
            case 'field':
                return {
                    k: 'getfield',
                    owner: e.owner,
                    name: e.name,
                    object: this.expr(e.object),
                    desc: descOf(e.type),
                };
            case 'set-field':
                return {
                    k: 'putfield',
                    owner: e.owner,
                    name: e.name,
                    object: this.expr(e.object),
                    value: this.coerce(this.expr(e.rhs), e.type),
                    desc: descOf(e.type),
                };
            case 'call-method': {
                const method = this.classOf(e.owner).methods.find((m) => m.name === e.name);
                if (!method) throw new Error(`call to unknown method '${e.owner}.${e.name}'`);
                return {
                    k: 'invoke',
                    kind: 'virtual',
                    owner: e.owner,
                    name: e.name,
                    descriptor: functionDescriptor(method),
                    object: this.expr(e.object),
                    args: e.args.map((a, i) => this.coerce(this.expr(a), method.params[i]!.type)),
                    desc: descOf(e.resultType),
                };
            }
        }
    }

    private classOf(name: string): HirClass {
        const c = this.classes.get(name);
        if (!c) throw new Error(`unknown class '${name}'`);
        return c;
    }

    private binary(e: Extract<HirExpr, { k: 'binary' }>): LirExpr {
        const left = this.expr(e.left);
        const right = this.expr(e.right);

        if (e.op === '&&') return { k: 'and', left, right, desc: D_BOOLEAN };
        if (e.op === '||') return { k: 'or', left, right, desc: D_BOOLEAN };

        if (e.op === '+' && e.resultType.kind === 'string') {
            return { k: 'concat', parts: [...concatParts(left), ...concatParts(right)], desc: D_STRING };
        }

        const dop = DOUBLE_OPS[e.op];
        if (dop) return { k: 'dbin', op: dop, left, right, desc: D_DOUBLE };

        if ((e.op === '==' || e.op === '!=') && left.desc === D_STRING) {
            return { k: 'scmp', negate: e.op === '!=', left, right, desc: D_BOOLEAN };
        }
        const cop = COMPARE_OPS[e.op];
        if (cop) return { k: 'dcmp', op: cop, left, right, desc: D_BOOLEAN };
        throw new Error(`unhandled binary operator '${e.op}'`);
    }

    private call(e: Extract<HirExpr, { k: 'call' }>): LirExpr {
        const desc = descOf(e.resultType);
        if (e.foreign) {
            const { owner, method } = e.foreign;
            const descriptor =
                method.jvmDescriptor ?? `(${method.params.map(descOf).join('')})${descOf(method.returnType)}`;
            return { k: 'call', owner, name: method.name, descriptor, args: e.args.map((a) => this.expr(a)), desc };
        }
        const target = this.fns.get(e.calleeName);
        if (!target) throw new Error(`call to unknown function '${e.calleeName}'`);
        const args = e.args.map((a, i) => this.coerce(this.expr(a), target.params[i]!.type));
        return {
            k: 'call',
            owner: this.className,
            name: target.name,
            descriptor: functionDescriptor(target),
            args,
            desc,
        };
    }
}

/** `(a + b) + c` with string result flattens into one StringBuilder chain. */
function concatParts(e: LirExpr): LirExpr[] {
    return e.k === 'concat' ? e.parts : [e];
}

function defaultValue(desc: Desc): LirExpr {
    if (desc === D_DOUBLE) return { k: 'dconst', value: 0, desc: D_DOUBLE };
    if (desc === D_BOOLEAN) return { k: 'bconst', value: false, desc: D_BOOLEAN };
    return { k: 'null', desc };
}
