import { parseMethodDescriptor } from '../classfile/descriptors.ts';
import {
    descriptorOf,
    type HirClass,
    type HirExpr,
    type HirFunction,
    type HirProgram,
    type HirStmt,
    type ValueType,
} from '../frontend/hir.ts';
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

export { descriptorOf as descOf };

function functionDescriptor(fn: HirFunction): string {
    return `(${fn.params.map((p) => descriptorOf(p.type)).join('')})${descriptorOf(fn.returnType)}`;
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

/** JVM numeric types that TypeScript sees as `number`; a double is converted to/from them at call boundaries. */
const NARROW_NUMERIC = new Set(['I', 'J', 'F', 'S', 'B', 'C']);

export function lowerHirToLir(program: HirProgram, opts: LirOptions): LirProgram {
    const fns = new Map(program.functions.map((f) => [f.name, f]));
    const lowerer = new Lowerer(opts.className, fns);
    return {
        className: opts.className,
        functions: program.functions.map((f) => lowerer.lowerFunction(f)),
        classes: program.classes.map((c) => lowerer.lowerClass(c)),
    };
}

class Lowerer {
    private readonly className: string;
    private readonly fns: Map<string, HirFunction>;
    private returnType: ValueType = { kind: 'void' };

    constructor(className: string, fns: Map<string, HirFunction>) {
        this.className = className;
        this.fns = fns;
    }

    lowerClass(c: HirClass): LirClass {
        const ctor = this.lowerFunction(c.ctor);
        const superCall: LirStmt = {
            k: 'expr',
            expr: {
                k: 'invoke',
                kind: 'special',
                owner: c.superName,
                name: '<init>',
                descriptor: c.superCall.descriptor,
                object: { k: 'load', slot: 0, desc: `L${c.name};` },
                args: this.args(c.superCall.args, c.superCall.descriptor),
                desc: D_VOID,
            },
        };
        return {
            name: c.name,
            superName: c.superName,
            fields: c.fields.map((f) => ({ name: f.name, desc: descriptorOf(f.type) })),
            ctor: { ...ctor, body: { k: 'block', stmts: [superCall, ctor.body] } },
            methods: c.methods.map((m) => this.lowerFunction(m)),
        };
    }

    lowerFunction(fn: HirFunction): LirFunction {
        this.returnType = fn.returnType;
        return {
            name: fn.name,
            descriptor: functionDescriptor(fn),
            params: fn.params.map((p) => ({ name: p.name, desc: descriptorOf(p.type), slot: p.slot })),
            locals: fn.locals.map((l) => ({ name: l.name, desc: descriptorOf(l.type), slot: l.slot })),
            body: this.stmt(fn.body),
        };
    }

    // ---- statements --------------------------------------------------------

    private stmt(s: HirStmt): LirStmt {
        switch (s.k) {
            case 'block':
                return { k: 'block', stmts: s.stmts.map((c) => this.stmt(c)) };
            case 'var-decl': {
                const desc = descriptorOf(s.type);
                const value = s.init ? this.coerce(this.expr(s.init), desc) : defaultValue(desc);
                return { k: 'store', slot: s.slot, desc, value };
            }
            case 'expr': {
                const e = this.expr(s.expr);
                // `x = v;` as a statement doesn't need the value left on the stack.
                if (e.k === 'store') return { k: 'store', slot: e.slot, desc: e.desc, value: e.value };
                if (e.k === 'putfield') return { ...e };
                // A converted call result that is thrown away doesn't need converting.
                if (e.k === 'convert') return { k: 'expr', expr: e.operand };
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
                return {
                    k: 'return',
                    value: s.expr ? this.coerce(this.expr(s.expr), descriptorOf(this.returnType)) : null,
                };
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

    /**
     * Adapts `e` to a target JVM type. The front end only allows exact matches, subclasses (no change needed),
     * and two widenings: a number or boolean into Object (boxing), and a number into a JVM int/long/float/... parameter.
     */
    private coerce(e: LirExpr, to: Desc): LirExpr {
        if (e.desc === to) return e;
        if (to === D_OBJECT && (e.desc === D_DOUBLE || e.desc === D_BOOLEAN)) {
            return { k: 'box', operand: e, desc: D_OBJECT };
        }
        if (e.desc === D_DOUBLE && NARROW_NUMERIC.has(to)) return { k: 'convert', operand: e, desc: to };
        return e;
    }

    /** Lowers call arguments and adapts each to its parameter in `descriptor`. */
    private args(args: HirExpr[], descriptor: string): LirExpr[] {
        const params = parseMethodDescriptor(descriptor).params;
        return args.map((a, i) => this.coerce(this.expr(a), params[i]!));
    }

    /** A call whose JVM return type is int/long/float/... is exposed to TypeScript as a double. */
    private adaptReturn(call: Extract<LirExpr, { k: 'call' | 'invoke' }>, descriptor: string): LirExpr {
        const ret = parseMethodDescriptor(descriptor).returns;
        if (!NARROW_NUMERIC.has(ret)) return call;
        return { k: 'convert', operand: { ...call, desc: ret }, desc: D_DOUBLE };
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
                return { k: 'load', slot: e.slot, desc: descriptorOf(e.type) };
            case 'assign': {
                const desc = descriptorOf(e.type);
                return { k: 'store', slot: e.slot, desc, value: this.coerce(this.expr(e.rhs), desc) };
            }
            case 'unary': {
                const operand = this.expr(e.operand);
                return e.op === '-' ? { k: 'dneg', operand, desc: D_DOUBLE } : { k: 'not', operand, desc: D_BOOLEAN };
            }
            case 'binary':
                return this.binary(e);
            case 'cond': {
                const desc = descriptorOf(e.resultType);
                return {
                    k: 'cond',
                    cond: this.expr(e.cond),
                    then: this.coerce(this.expr(e.then), desc),
                    else_: this.coerce(this.expr(e.else_), desc),
                    desc,
                };
            }
            case 'call':
                return this.call(e);
            case 'this':
                return { k: 'load', slot: 0, desc: descriptorOf(e.type) };
            case 'new':
                return {
                    k: 'new',
                    cls: e.className,
                    descriptor: e.descriptor,
                    args: this.args(e.args, e.descriptor),
                    desc: descriptorOf(e.resultType),
                };
            case 'field':
                return {
                    k: 'getfield',
                    owner: e.owner,
                    name: e.name,
                    object: this.expr(e.object),
                    desc: descriptorOf(e.type),
                };
            case 'set-field': {
                const desc = descriptorOf(e.type);
                return {
                    k: 'putfield',
                    owner: e.owner,
                    name: e.name,
                    object: this.expr(e.object),
                    value: this.coerce(this.expr(e.rhs), desc),
                    desc,
                };
            }
            case 'call-method':
                return this.adaptReturn(
                    {
                        k: 'invoke',
                        kind: e.special ? 'special' : e.iface ? 'interface' : 'virtual',
                        owner: e.owner,
                        name: e.name,
                        descriptor: e.descriptor,
                        object: this.expr(e.object),
                        args: this.args(e.args, e.descriptor),
                        desc: descriptorOf(e.resultType),
                    },
                    e.descriptor,
                );
        }
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
        const desc = descriptorOf(e.resultType);
        if (e.foreign) {
            const { owner, method } = e.foreign;
            return this.adaptReturn(
                {
                    k: 'call',
                    owner,
                    name: method.name,
                    descriptor: method.descriptor,
                    args: this.args(e.args, method.descriptor),
                    desc,
                },
                method.descriptor,
            );
        }
        const target = this.fns.get(e.calleeName);
        if (!target) throw new Error(`call to unknown function '${e.calleeName}'`);
        const descriptor = functionDescriptor(target);
        return {
            k: 'call',
            owner: this.className,
            name: target.name,
            descriptor,
            args: this.args(e.args, descriptor),
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
