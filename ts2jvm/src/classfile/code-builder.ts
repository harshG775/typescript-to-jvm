import { ByteWriter } from './byte-writer.ts';
import type { ConstantPool } from './constant-pool.ts';
import { parseMethodDescriptor, slotSize } from './descriptors.ts';
import {
    JUMP_OPS,
    NEWARRAY_TYPES,
    SIMPLE_OPS,
    TERMINATORS,
    type JumpOp,
    type NewArrayType,
    type SimpleOp,
} from './opcodes.ts';

/** Value kind for local loads/stores: int (also boolean/byte/char/short), long, float, double, reference. */
export type Kind = 'i' | 'l' | 'f' | 'd' | 'a';

const KIND_INDEX = { i: 0, l: 1, f: 2, d: 3, a: 4 } as const;
const KIND_SLOTS = { i: 1, l: 2, f: 1, d: 2, a: 1 } as const;

const OP_LOAD = 0x15;
const OP_LOAD_0 = 0x1a;
const OP_STORE = 0x36;
const OP_STORE_0 = 0x3b;
const OP_IINC = 0x84;
const OP_WIDE = 0xc4;

/** A jump target. Create with `code.newLabel()`, place exactly once with `code.place(label)`. */
export class Label {
    pos = -1;
    /** Operand stack depth (in slots) on entry, learned from the first jump or placement. */
    depth: number | undefined = undefined;
}

interface Fixup {
    /** Where the offset is written. */
    at: number;
    /** Address of the owning instruction; offsets are relative to it. */
    base: number;
    label: Label;
    wide: boolean;
}

interface HandlerEntry {
    start: Label;
    end: Label;
    handler: Label;
    catchType: number;
}

export interface CodeData {
    maxStack: number;
    maxLocals: number;
    code: Uint8Array;
    exceptions: { start: number; end: number; handler: number; catchType: number }[];
    lines: { pc: number; line: number }[];
}

/**
 * Assembles the bytecode of one method: resolves labels to offsets, picks short/wide
 * instruction forms, and tracks operand-stack depth so max_stack is computed and
 * stack bugs surface as exceptions here instead of VerifyErrors later.
 *
 * Emits no StackMapTable, so it is only valid for class-file version 50 and below.
 */
export class CodeBuilder {
    private readonly cp: ConstantPool;
    private readonly out = new ByteWriter();
    private readonly fixups: Fixup[] = [];
    private readonly handlers: HandlerEntry[] = [];
    private readonly lines: { pc: number; line: number }[] = [];
    private depth = 0;
    private maxStack = 0;
    private maxLocals: number;
    private nextLocal: number;
    private reachable = true;

    constructor(cp: ConstantPool, isStatic: boolean, descriptor: string) {
        this.cp = cp;
        this.nextLocal = (isStatic ? 0 : 1) + parseMethodDescriptor(descriptor).argSlots;
        this.maxLocals = this.nextLocal;
    }

    /** False right after a return/throw/goto, until a jumped-to label is placed. */
    get isReachable(): boolean {
        return this.reachable;
    }

    /** Current offset into the method's code. */
    get pc(): number {
        return this.out.length;
    }

    // ---- bookkeeping -------------------------------------------------------

    private stack(pops: number, pushes: number): void {
        if (this.reachable) {
            if (this.depth < pops) {
                throw new Error(`Operand stack underflow at pc ${this.pc}: needs ${pops} slots, has ${this.depth}`);
            }
            this.depth -= pops;
        } else {
            this.depth = Math.max(0, this.depth - pops);
        }
        this.depth += pushes;
        if (this.depth > this.maxStack) this.maxStack = this.depth;
    }

    private endFlow(): void {
        this.reachable = false;
        this.depth = 0;
    }

    private useLocal(index: number, slots: number): void {
        if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new RangeError(`Bad local index ${index}`);
        if (index + slots > this.maxLocals) this.maxLocals = index + slots;
    }

    /** Reserves a fresh local variable slot (two for long/double) and returns its index. */
    newLocal(kind: Kind): number {
        const index = this.nextLocal;
        this.nextLocal += KIND_SLOTS[kind];
        this.useLocal(index, KIND_SLOTS[kind]);
        return index;
    }

    /** Records a source line for the instructions emitted from here on (shown in stack traces). */
    line(line: number): void {
        const last = this.lines[this.lines.length - 1];
        if (last && last.pc === this.pc) last.line = line;
        else this.lines.push({ pc: this.pc, line });
    }

    // ---- labels and control flow ------------------------------------------

    newLabel(): Label {
        return new Label();
    }

    private recordDepth(label: Label): void {
        if (!this.reachable) return;
        if (label.depth === undefined) label.depth = this.depth;
        else if (label.depth !== this.depth) {
            throw new Error(`Stack depth mismatch at jump to label: expected ${label.depth}, have ${this.depth}`);
        }
    }

    /**
     * Binds a label to the current offset. After a terminator, a label that no earlier jump
     * targeted leaves the code unreachable: it can only be a range marker or a loop head
     * that nothing enters, since any backward jump to it would itself be dead code.
     */
    place(label: Label): void {
        if (label.pos >= 0) throw new Error('Label placed twice');
        label.pos = this.pc;
        if (this.reachable) {
            if (label.depth === undefined) label.depth = this.depth;
            else if (label.depth !== this.depth) {
                throw new Error(`Stack depth mismatch entering label: expected ${label.depth}, have ${this.depth}`);
            }
        } else if (label.depth !== undefined) {
            this.depth = label.depth;
            this.reachable = true;
        }
    }

    /** Binds a label as an exception handler entry; the JVM pushes the exception, so depth is 1. */
    placeHandler(label: Label): void {
        if (this.reachable)
            throw new Error('Control falls through into an exception handler; end the previous block first');
        label.depth = 1;
        this.place(label);
    }

    jump(op: JumpOp, label: Label): void {
        const [opcode, pops] = JUMP_OPS[op];
        this.stack(pops, 0);
        const base = this.pc;
        this.out.u1(opcode);
        this.fixups.push({ at: this.pc, base, label, wide: false });
        this.out.i2(0);
        this.recordDepth(label);
        if (op === 'goto') this.endFlow();
    }

    /** Covers [start, end) with a handler. `catchType` is an internal class name, or null for catch-all (finally). Inner ranges must be added first. */
    tryCatch(start: Label, end: Label, handler: Label, catchType: string | null): void {
        this.handlers.push({ start, end, handler, catchType: catchType === null ? 0 : this.cp.cls(catchType) });
    }

    tableswitch(low: number, targets: Label[], dflt: Label): void {
        if (targets.length === 0) throw new Error('tableswitch needs at least one target');
        this.stack(1, 0);
        const base = this.pc;
        this.out.u1(0xaa);
        while (this.pc % 4 !== 0) this.out.u1(0);
        this.wideFixup(base, dflt);
        this.out.i4(low);
        this.out.i4(low + targets.length - 1);
        for (const t of targets) this.wideFixup(base, t);
        this.endSwitch([dflt, ...targets]);
    }

    lookupswitch(cases: [key: number, target: Label][], dflt: Label): void {
        const sorted = [...cases].sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i]![0] === sorted[i - 1]![0]) throw new Error(`Duplicate switch key ${sorted[i]![0]}`);
        }
        this.stack(1, 0);
        const base = this.pc;
        this.out.u1(0xab);
        while (this.pc % 4 !== 0) this.out.u1(0);
        this.wideFixup(base, dflt);
        this.out.i4(sorted.length);
        for (const [key, target] of sorted) {
            this.out.i4(key);
            this.wideFixup(base, target);
        }
        this.endSwitch([dflt, ...sorted.map((c) => c[1])]);
    }

    private wideFixup(base: number, label: Label): void {
        this.fixups.push({ at: this.pc, base, label, wide: true });
        this.out.i4(0);
    }

    private endSwitch(labels: Label[]): void {
        for (const l of labels) this.recordDepth(l);
        this.endFlow();
    }

    // ---- simple instructions ----------------------------------------------

    op(name: SimpleOp): void {
        const [opcode, pops, pushes] = SIMPLE_OPS[name];
        this.stack(pops, pushes);
        this.out.u1(opcode);
        if (TERMINATORS.has(name)) this.endFlow();
    }

    // ---- constants ---------------------------------------------------------

    pushInt(v: number): void {
        if (v >= -1 && v <= 5) this.op(`iconst_${v === -1 ? 'm1' : v}` as SimpleOp);
        else if (v >= -128 && v <= 127) {
            this.stack(0, 1);
            this.out.u1(0x10);
            this.out.i1(v);
        } else if (v >= -32768 && v <= 32767) {
            this.stack(0, 1);
            this.out.u1(0x11);
            this.out.i2(v);
        } else this.ldc(this.cp.integer(v), false);
    }

    pushLong(v: bigint): void {
        if (v === 0n) this.op('lconst_0');
        else if (v === 1n) this.op('lconst_1');
        else this.ldc(this.cp.long(v), true);
    }

    pushFloat(v: number): void {
        if (v === 0 && !Object.is(v, -0)) this.op('fconst_0');
        else if (v === 1) this.op('fconst_1');
        else if (v === 2) this.op('fconst_2');
        else this.ldc(this.cp.float(v), false);
    }

    pushDouble(v: number): void {
        if (v === 0 && !Object.is(v, -0)) this.op('dconst_0');
        else if (v === 1) this.op('dconst_1');
        else this.ldc(this.cp.double(v), true);
    }

    pushString(s: string): void {
        this.ldc(this.cp.string(s), false);
    }

    pushNull(): void {
        this.op('aconst_null');
    }

    private ldc(index: number, twoSlot: boolean): void {
        if (twoSlot) {
            this.stack(0, 2);
            this.out.u1(0x14);
            this.out.u2(index);
        } else {
            this.stack(0, 1);
            if (index <= 0xff) {
                this.out.u1(0x12);
                this.out.u1(index);
            } else {
                this.out.u1(0x13);
                this.out.u2(index);
            }
        }
    }

    // ---- locals ------------------------------------------------------------

    private localOp(base: number, shortBase: number, kind: Kind, index: number): void {
        const k = KIND_INDEX[kind];
        if (index <= 3) this.out.u1(shortBase + k * 4 + index);
        else if (index <= 0xff) {
            this.out.u1(base + k);
            this.out.u1(index);
        } else {
            this.out.u1(OP_WIDE);
            this.out.u1(base + k);
            this.out.u2(index);
        }
    }

    load(kind: Kind, index: number): void {
        this.useLocal(index, KIND_SLOTS[kind]);
        this.stack(0, KIND_SLOTS[kind]);
        this.localOp(OP_LOAD, OP_LOAD_0, kind, index);
    }

    store(kind: Kind, index: number): void {
        this.useLocal(index, KIND_SLOTS[kind]);
        this.stack(KIND_SLOTS[kind], 0);
        this.localOp(OP_STORE, OP_STORE_0, kind, index);
    }

    iinc(index: number, delta: number): void {
        this.useLocal(index, 1);
        if (index <= 0xff && delta >= -128 && delta <= 127) {
            this.out.u1(OP_IINC);
            this.out.u1(index);
            this.out.i1(delta);
        } else {
            this.out.u1(OP_WIDE);
            this.out.u1(OP_IINC);
            this.out.u2(index);
            this.out.i2(delta);
        }
    }

    // ---- fields and methods ------------------------------------------------

    getstatic(owner: string, name: string, desc: string): void {
        this.stack(0, slotSize(desc));
        this.out.u1(0xb2);
        this.out.u2(this.cp.fieldRef(owner, name, desc));
    }

    putstatic(owner: string, name: string, desc: string): void {
        this.stack(slotSize(desc), 0);
        this.out.u1(0xb3);
        this.out.u2(this.cp.fieldRef(owner, name, desc));
    }

    getfield(owner: string, name: string, desc: string): void {
        this.stack(1, slotSize(desc));
        this.out.u1(0xb4);
        this.out.u2(this.cp.fieldRef(owner, name, desc));
    }

    putfield(owner: string, name: string, desc: string): void {
        this.stack(1 + slotSize(desc), 0);
        this.out.u1(0xb5);
        this.out.u2(this.cp.fieldRef(owner, name, desc));
    }

    invokevirtual(owner: string, name: string, desc: string): void {
        this.invoke(0xb6, owner, name, desc, true);
    }

    invokespecial(owner: string, name: string, desc: string): void {
        this.invoke(0xb7, owner, name, desc, true);
    }

    invokestatic(owner: string, name: string, desc: string): void {
        this.invoke(0xb8, owner, name, desc, false);
    }

    invokeinterface(owner: string, name: string, desc: string): void {
        const m = parseMethodDescriptor(desc);
        this.stack(m.argSlots + 1, m.retSlots);
        this.out.u1(0xb9);
        this.out.u2(this.cp.interfaceMethodRef(owner, name, desc));
        this.out.u1(m.argSlots + 1);
        this.out.u1(0);
    }

    private invoke(opcode: number, owner: string, name: string, desc: string, hasReceiver: boolean): void {
        const m = parseMethodDescriptor(desc);
        this.stack(m.argSlots + (hasReceiver ? 1 : 0), m.retSlots);
        this.out.u1(opcode);
        this.out.u2(this.cp.methodRef(owner, name, desc));
    }

    // ---- objects and arrays ------------------------------------------------

    /** `new`: allocates an uninitialized instance; follow with dup + invokespecial `<init>`. */
    newObject(internalName: string): void {
        this.stack(0, 1);
        this.out.u1(0xbb);
        this.out.u2(this.cp.cls(internalName));
    }

    newarray(type: NewArrayType): void {
        this.stack(1, 1);
        this.out.u1(0xbc);
        this.out.u1(NEWARRAY_TYPES[type]);
    }

    anewarray(elementInternalName: string): void {
        this.stack(1, 1);
        this.out.u1(0xbd);
        this.out.u2(this.cp.cls(elementInternalName));
    }

    /** `arrayDescriptor` is the full array type, e.g. `[[I`. */
    multianewarray(arrayDescriptor: string, dimensions: number): void {
        this.stack(dimensions, 1);
        this.out.u1(0xc5);
        this.out.u2(this.cp.cls(arrayDescriptor));
        this.out.u1(dimensions);
    }

    checkcast(internalName: string): void {
        this.stack(1, 1);
        this.out.u1(0xc0);
        this.out.u2(this.cp.cls(internalName));
    }

    instanceOf(internalName: string): void {
        this.stack(1, 1);
        this.out.u1(0xc1);
        this.out.u2(this.cp.cls(internalName));
    }

    // ---- finish ------------------------------------------------------------

    build(): CodeData {
        if (this.pc === 0) throw new Error('Method body is empty');
        if (this.pc > 0xffff) throw new Error(`Method code is ${this.pc} bytes; the JVM limit is 65535`);
        if (this.reachable) throw new Error('Control falls off the end of the method (missing return?)');

        for (const f of this.fixups) {
            if (f.label.pos < 0) throw new Error('Jump to a label that was never placed');
            const offset = f.label.pos - f.base;
            if (f.wide) this.out.patchI4(f.at, offset);
            else if (offset < -0x8000 || offset > 0x7fff) {
                throw new Error(
                    `Branch offset ${offset} exceeds the 16-bit range; the method is too large to branch across`,
                );
            } else this.out.patchI2(f.at, offset);
        }

        const exceptions = this.handlers.map((h) => {
            for (const l of [h.start, h.end, h.handler]) {
                if (l.pos < 0) throw new Error('Exception table refers to a label that was never placed');
            }
            if (h.start.pos >= h.end.pos) throw new Error('Exception range is empty or inverted');
            return { start: h.start.pos, end: h.end.pos, handler: h.handler.pos, catchType: h.catchType };
        });

        return {
            maxStack: this.maxStack,
            maxLocals: this.maxLocals,
            code: this.out.toBytes(),
            exceptions,
            lines: this.lines,
        };
    }
}
