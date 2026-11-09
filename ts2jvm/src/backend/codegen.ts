import {
    Acc,
    ClassWriter,
    slotSize,
    parseMethodDescriptor,
    type CodeBuilder,
    type JumpOp,
    type Kind,
    type Label,
} from '../classfile/index.ts';
import type { CompareOp, LirExpr, LirFunction, LirProgram, LirStmt } from '../middle/lir.ts';

export interface CodegenOptions {
    sourceFile?: string;
}

export interface ClassFile {
    /** JVM internal name, e.g. `Main`. */
    name: string;
    bytes: Uint8Array;
}

/**
 * Turns a LIR program into class files: one holding every top-level function as a public static method
 * (named `program.className`), plus one per user class.
 */
export function generateClasses(program: LirProgram, opts: CodegenOptions = {}): ClassFile[] {
    if (program.classes.some((c) => c.name === program.className)) {
        throw new Error(
            `a class named '${program.className}' collides with the generated class for top-level functions`,
        );
    }
    const usage = { numToString: false };
    const sourceFile = opts.sourceFile === undefined ? {} : { sourceFile: opts.sourceFile };

    const files: ClassFile[] = program.classes.map((c) => {
        const cw = new ClassWriter(c.name, sourceFile);
        for (const f of c.fields) cw.addField(Acc.PUBLIC, f.name, f.desc);
        for (const fn of [c.ctor, ...c.methods]) {
            cw.addMethod(Acc.PUBLIC, fn.name, fn.descriptor, (code) =>
                new FunctionGen(code, fn, program.className, usage).run(),
            );
        }
        return { name: c.name, bytes: cw.toBytes() };
    });

    const cw = new ClassWriter(program.className, sourceFile);
    for (const fn of program.functions) {
        cw.addMethod(Acc.PUBLIC | Acc.STATIC, fn.name, fn.descriptor, (c) =>
            new FunctionGen(c, fn, program.className, usage).run(),
        );
    }
    if (usage.numToString) addNumToString(cw);
    return [{ name: program.className, bytes: cw.toBytes() }, ...files];
}

function kindOf(desc: string): Kind {
    if (desc === 'D') return 'd';
    if (desc === 'Z' || desc === 'I') return 'i';
    return 'a';
}

const NUM_TO_STRING = '$ts2jvm$num';

/**
 * static String $num(double d): whole numbers below 1e15 print without ".0" (as in JS); everything else
 * uses Java's formatting. Large and tiny magnitudes (1e21, 1e-7) still differ from JS.
 */
function addNumToString(cw: ClassWriter): void {
    cw.addMethod(Acc.STATIC | Acc.SYNTHETIC, NUM_TO_STRING, '(D)Ljava/lang/String;', (c) => {
        const other = c.newLabel();
        c.load('d', 0);
        c.load('d', 0);
        c.invokestatic('java/lang/Math', 'rint', '(D)D');
        c.op('dcmpl');
        c.jump('ifne', other);
        c.load('d', 0);
        c.invokestatic('java/lang/Math', 'abs', '(D)D');
        c.pushDouble(1e15);
        c.op('dcmpg');
        c.jump('ifge', other);
        c.load('d', 0);
        c.op('d2l');
        c.invokestatic('java/lang/Long', 'toString', '(J)Ljava/lang/String;');
        c.op('areturn');
        c.place(other);
        c.load('d', 0);
        c.invokestatic('java/lang/String', 'valueOf', '(D)Ljava/lang/String;');
        c.op('areturn');
    });
}

const SB = 'java/lang/StringBuilder';
const SB_DESC = `L${SB};`;

/** `jump when the comparison is true` / `jump when it is false`. See jumpIf for why the dcmp variant matters. */
const JUMP_IF_TRUE: Record<CompareOp, JumpOp> = {
    '<': 'iflt',
    '<=': 'ifle',
    '>': 'ifgt',
    '>=': 'ifge',
    '==': 'ifeq',
    '!=': 'ifne',
};
const JUMP_IF_FALSE: Record<CompareOp, JumpOp> = {
    '<': 'ifge',
    '<=': 'ifgt',
    '>': 'ifle',
    '>=': 'iflt',
    '==': 'ifne',
    '!=': 'ifeq',
};

/** An enclosing `try` whose `finally` must run on early exits. `ranges` are the protected pc ranges. */
interface TryCtx {
    finally_: LirStmt | null;
    ranges: [Label, Label][];
    start: Label;
}

class FunctionGen {
    private readonly c: CodeBuilder;
    private readonly fn: LirFunction;
    private readonly returnDesc: string;
    private readonly className: string;
    private readonly usage: { numToString: boolean };
    /** Only tries that have a `finally`; innermost last. */
    private finallyStack: TryCtx[] = [];
    /** Next free local slot for compiler temporaries, past every slot the HIR assigned. */
    private nextTemp: number;

    constructor(c: CodeBuilder, fn: LirFunction, className: string, usage: { numToString: boolean }) {
        this.c = c;
        this.fn = fn;
        this.className = className;
        this.usage = usage;
        this.returnDesc = parseMethodDescriptor(fn.descriptor).returns;
        this.nextTemp = Math.max(0, ...[...fn.params, ...fn.locals].map((v) => v.slot + slotSize(v.desc)));
    }

    run(): void {
        this.stmt(this.fn.body);
        if (!this.c.isReachable) return;
        if (this.returnDesc !== 'V') {
            throw new Error(`function '${this.fn.name}' can reach its end without returning a value`);
        }
        this.c.op('return');
    }

    private temp(kind: Kind): number {
        const slot = this.nextTemp;
        this.nextTemp += kind === 'd' ? 2 : 1;
        return slot;
    }

    // ---- statements --------------------------------------------------------

    private stmt(s: LirStmt): void {
        const c = this.c;
        switch (s.k) {
            case 'block':
                for (const child of s.stmts) this.stmt(child);
                return;
            case 'store':
                this.expr(s.value);
                c.store(kindOf(s.desc), s.slot);
                return;
            case 'putfield':
                this.expr(s.object);
                this.expr(s.value);
                c.putfield(s.owner, s.name, s.desc);
                return;
            case 'expr':
                this.expr(s.expr);
                this.discard(s.expr);
                return;
            case 'if': {
                const elseL = c.newLabel();
                this.jumpIf(s.cond, false, elseL);
                this.stmt(s.then);
                if (s.else_) {
                    const endL = c.newLabel();
                    if (c.isReachable) c.jump('goto', endL);
                    c.place(elseL);
                    this.stmt(s.else_);
                    c.place(endL);
                } else {
                    c.place(elseL);
                }
                return;
            }
            case 'while': {
                const top = c.newLabel();
                const end = c.newLabel();
                c.place(top);
                this.jumpIf(s.cond, false, end);
                this.stmt(s.body);
                if (c.isReachable) c.jump('goto', top);
                c.place(end);
                return;
            }
            case 'return':
                this.return_(s.value);
                return;
            case 'throw':
                this.expr(s.expr);
                c.op('athrow');
                return;
            case 'try':
                this.try_(s);
                return;
        }
    }

    private discard(e: LirExpr): void {
        // A call's real JVM return type decides what is on the stack, not its TS-facing type.
        const desc = e.k === 'call' || e.k === 'invoke' ? parseMethodDescriptor(e.descriptor).returns : e.desc;
        const n = slotSize(desc);
        if (n === 2) this.c.op('pop2');
        else if (n === 1) this.c.op('pop');
    }

    private return_(value: LirExpr | null): void {
        const c = this.c;
        const ret = (): void => {
            if (this.returnDesc === 'V') c.op('return');
            else c.op(this.returnDesc === 'D' ? 'dreturn' : kindOf(this.returnDesc) === 'i' ? 'ireturn' : 'areturn');
        };

        if (value) this.expr(value);
        if (this.finallyStack.length === 0) return ret();

        // Run every enclosing finally, innermost first, before leaving. The inlined finally code must not
        // be protected by its own try (or any try inside it), so close those ranges while it is emitted.
        let tmp: number | null = null;
        if (value) {
            tmp = this.temp(kindOf(this.returnDesc));
            c.store(kindOf(this.returnDesc), tmp);
        }
        const saved = this.finallyStack;
        for (let i = saved.length - 1; i >= 0; i--) {
            const ctx = saved[i]!;
            this.closeRange(ctx);
            this.finallyStack = saved.slice(0, i);
            this.stmt(ctx.finally_!);
        }
        this.finallyStack = saved;
        if (c.isReachable) {
            if (tmp !== null) c.load(kindOf(this.returnDesc), tmp);
            ret();
        }
        for (const ctx of saved) this.openRange(ctx);
    }

    private openRange(ctx: TryCtx): void {
        ctx.start = this.c.newLabel();
        this.c.place(ctx.start);
    }

    private closeRange(ctx: TryCtx): void {
        const end = this.c.newLabel();
        this.c.place(end);
        ctx.ranges.push([ctx.start, end]);
    }

    /** Registers each non-empty range with a handler. Nested tries registered theirs first, as the JVM requires. */
    private register(ranges: [Label, Label][], handler: Label, catchType: string | null): void {
        for (const [start, end] of ranges) {
            if (start.pos < end.pos) this.c.tryCatch(start, end, handler, catchType);
        }
    }

    private try_(s: Extract<LirStmt, { k: 'try' }>): void {
        const c = this.c;
        const fin = s.finally_;
        const end = c.newLabel();

        /** Emits the finally body for a normal exit, then jumps past the whole statement. */
        const exitNormally = (): void => {
            if (!c.isReachable) return;
            if (fin) this.stmt(fin);
            if (c.isReachable) c.jump('goto', end);
        };

        // try body
        const bodyCtx: TryCtx = { finally_: fin, ranges: [], start: c.newLabel() };
        if (fin) this.finallyStack.push(bodyCtx);
        this.openRange(bodyCtx);
        this.stmt(s.body);
        this.closeRange(bodyCtx);
        if (fin) this.finallyStack.pop();
        exitNormally();

        // catch (everything is caught as Throwable)
        let catchCtx: TryCtx | null = null;
        if (s.catch_) {
            const handler = c.newLabel();
            c.placeHandler(handler);
            this.register(bodyCtx.ranges, handler, 'java/lang/Throwable');

            catchCtx = { finally_: fin, ranges: [], start: c.newLabel() };
            if (fin) this.finallyStack.push(catchCtx);
            this.openRange(catchCtx);
            if (s.catch_.slot === null) c.op('pop');
            else c.store('a', s.catch_.slot);
            this.stmt(s.catch_.body);
            this.closeRange(catchCtx);
            if (fin) this.finallyStack.pop();
            exitNormally();
        }

        // catch-all that runs finally and rethrows
        if (fin) {
            const handler = c.newLabel();
            c.placeHandler(handler);
            this.register((catchCtx ?? bodyCtx).ranges, handler, null);
            const exc = this.temp('a');
            c.store('a', exc);
            this.stmt(fin);
            if (c.isReachable) {
                c.load('a', exc);
                c.op('athrow');
            }
        }
        c.place(end);
    }

    // ---- conditions --------------------------------------------------------

    /**
     * Jumps to `target` when `e` evaluates to `when`, otherwise falls through.
     * NaN: a comparison involving NaN is false for everything except `!=`. dcmpg/dcmpl yield 1/-1 for NaN,
     * so `<`/`<=` use dcmpg (NaN looks "greater") and `>`/`>=`/`==`/`!=` use dcmpl (NaN looks "less"),
     * which makes both the jump-if-true and jump-if-false forms below correct.
     */
    private jumpIf(e: LirExpr, when: boolean, target: Label): void {
        const c = this.c;
        switch (e.k) {
            case 'bconst':
                if (e.value === when) c.jump('goto', target);
                return;
            case 'not':
                this.jumpIf(e.operand, !when, target);
                return;
            case 'and':
            case 'or': {
                // `and` short-circuits on false, `or` on true.
                const shortCircuitOn = e.k === 'or';
                if (when === shortCircuitOn) {
                    this.jumpIf(e.left, when, target);
                    this.jumpIf(e.right, when, target);
                } else {
                    const skip = c.newLabel();
                    this.jumpIf(e.left, shortCircuitOn, skip);
                    this.jumpIf(e.right, when, target);
                    c.place(skip);
                }
                return;
            }
            case 'dcmp':
                this.expr(e.left);
                this.expr(e.right);
                c.op(e.op === '<' || e.op === '<=' ? 'dcmpg' : 'dcmpl');
                c.jump((when ? JUMP_IF_TRUE : JUMP_IF_FALSE)[e.op], target);
                return;
            case 'scmp':
                this.expr(e.left);
                this.expr(e.right);
                c.invokevirtual('java/lang/String', 'equals', '(Ljava/lang/Object;)Z');
                // equals==true <=> comparison is true, flipped for `!=`.
                c.jump(when !== e.negate ? 'ifne' : 'ifeq', target);
                return;
            default:
                this.expr(e);
                c.jump(when ? 'ifne' : 'ifeq', target);
        }
    }

    // ---- expressions -------------------------------------------------------

    private expr(e: LirExpr): void {
        const c = this.c;
        switch (e.k) {
            case 'dconst':
                c.pushDouble(e.value);
                return;
            case 'bconst':
                c.pushInt(e.value ? 1 : 0);
                return;
            case 'sconst':
                c.pushString(e.value);
                return;
            case 'null':
                c.pushNull();
                return;
            case 'load':
                c.load(kindOf(e.desc), e.slot);
                return;
            case 'store':
                this.expr(e.value);
                c.op(e.desc === 'D' ? 'dup2' : 'dup');
                c.store(kindOf(e.desc), e.slot);
                return;
            case 'dbin':
                this.expr(e.left);
                this.expr(e.right);
                c.op(({ add: 'dadd', sub: 'dsub', mul: 'dmul', div: 'ddiv', rem: 'drem' } as const)[e.op]);
                return;
            case 'dneg':
                this.expr(e.operand);
                c.op('dneg');
                return;
            case 'dcmp':
            case 'not':
            case 'and':
            case 'or':
                this.materializeBoolean(e);
                return;
            case 'scmp':
                if (e.negate) {
                    this.materializeBoolean(e);
                } else {
                    this.expr(e.left);
                    this.expr(e.right);
                    c.invokevirtual('java/lang/String', 'equals', '(Ljava/lang/Object;)Z');
                }
                return;
            case 'cond': {
                const elseL = c.newLabel();
                const endL = c.newLabel();
                this.jumpIf(e.cond, false, elseL);
                this.expr(e.then);
                c.jump('goto', endL);
                c.place(elseL);
                this.expr(e.else_);
                c.place(endL);
                return;
            }
            case 'concat':
                c.newObject(SB);
                c.op('dup');
                c.invokespecial(SB, '<init>', '()V');
                for (const part of e.parts) {
                    this.expr(part);
                    if (part.desc === 'D') {
                        // JS prints 2 as "2", Java would print "2.0"; go through a small helper.
                        this.usage.numToString = true;
                        c.invokestatic(this.className, NUM_TO_STRING, '(D)Ljava/lang/String;');
                        c.invokevirtual(SB, 'append', `(Ljava/lang/String;)${SB_DESC}`);
                        continue;
                    }
                    const arg =
                        part.desc === 'Z' ? 'Z' : part.desc === 'Ljava/lang/String;' ? part.desc : 'Ljava/lang/Object;';
                    c.invokevirtual(SB, 'append', `(${arg})${SB_DESC}`);
                }
                c.invokevirtual(SB, 'toString', '()Ljava/lang/String;');
                return;
            case 'call':
                for (const a of e.args) this.expr(a);
                c.invokestatic(e.owner, e.name, e.descriptor);
                return;
            case 'box':
                this.expr(e.operand);
                if (e.operand.desc === 'D') c.invokestatic('java/lang/Double', 'valueOf', '(D)Ljava/lang/Double;');
                else c.invokestatic('java/lang/Boolean', 'valueOf', '(Z)Ljava/lang/Boolean;');
                return;
            case 'new':
                c.newObject(e.cls);
                c.op('dup');
                for (const a of e.args) this.expr(a);
                c.invokespecial(e.cls, '<init>', e.descriptor);
                return;
            case 'getfield':
                this.expr(e.object);
                c.getfield(e.owner, e.name, e.desc);
                return;
            case 'putfield':
                this.expr(e.object);
                this.expr(e.value);
                // Copy the value under the object so one copy is left after the store.
                c.op(e.desc === 'D' ? 'dup2_x1' : 'dup_x1');
                c.putfield(e.owner, e.name, e.desc);
                return;
            case 'invoke':
                this.expr(e.object);
                for (const a of e.args) this.expr(a);
                if (e.kind === 'special') c.invokespecial(e.owner, e.name, e.descriptor);
                else c.invokevirtual(e.owner, e.name, e.descriptor);
                return;
            case 'checkcast':
                this.expr(e.operand);
                c.checkcast(e.cls);
                return;
            case 'new-exception':
                c.newObject('java/lang/RuntimeException');
                c.op('dup');
                this.expr(e.message);
                c.invokespecial('java/lang/RuntimeException', '<init>', '(Ljava/lang/String;)V');
                return;
        }
    }

    /** Produces 0/1 on the stack from a condition that is naturally expressed as jumps. */
    private materializeBoolean(e: LirExpr): void {
        const c = this.c;
        const falseL = c.newLabel();
        const endL = c.newLabel();
        this.jumpIf(e, false, falseL);
        c.pushInt(1);
        c.jump('goto', endL);
        c.place(falseL);
        c.pushInt(0);
        c.place(endL);
    }
}
