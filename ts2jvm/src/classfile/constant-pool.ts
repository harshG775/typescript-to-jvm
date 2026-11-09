import { ByteWriter } from './byte-writer.ts';

const TAG = {
    Utf8: 1,
    Integer: 3,
    Float: 4,
    Long: 5,
    Double: 6,
    Class: 7,
    String: 8,
    Fieldref: 9,
    Methodref: 10,
    InterfaceMethodref: 11,
    NameAndType: 12,
} as const;

/** The JVM's "modified UTF-8": NUL is two bytes and supplementary characters are encoded as surrogate pairs. */
export function modifiedUtf8(s: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c !== 0 && c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return Uint8Array.from(out);
}

const scratch = new DataView(new ArrayBuffer(8));

/** Deduplicating constant pool. Every add method returns the entry's index. */
export class ConstantPool {
    private readonly out = new ByteWriter();
    private readonly index = new Map<string, number>();
    private next = 1;

    /** Value written as `constant_pool_count`. */
    get count(): number {
        return this.next;
    }

    private intern(key: string, slots: number, write: (w: ByteWriter) => void): number {
        const hit = this.index.get(key);
        if (hit !== undefined) return hit;
        if (this.next + slots > 0xffff) throw new Error('Constant pool overflow (more than 65534 entries)');
        write(this.out);
        const at = this.next;
        this.next += slots;
        this.index.set(key, at);
        return at;
    }

    utf8(s: string): number {
        return this.intern(`U${s}`, 1, (w) => {
            const b = modifiedUtf8(s);
            if (b.length > 0xffff) throw new Error('String constant longer than 65535 bytes in modified UTF-8');
            w.u1(TAG.Utf8);
            w.u2(b.length);
            w.bytes(b);
        });
    }

    integer(v: number): number {
        if ((v | 0) !== v) throw new RangeError(`${v} is not an int32`);
        return this.intern(`I${v}`, 1, (w) => {
            w.u1(TAG.Integer);
            w.i4(v);
        });
    }

    float(v: number): number {
        scratch.setFloat32(0, v);
        return this.intern(`F${scratch.getUint32(0)}`, 1, (w) => {
            w.u1(TAG.Float);
            w.f4(v);
        });
    }

    long(v: bigint): number {
        return this.intern(`J${v}`, 2, (w) => {
            w.u1(TAG.Long);
            w.i8(v);
        });
    }

    double(v: number): number {
        scratch.setFloat64(0, v);
        return this.intern(`D${scratch.getBigUint64(0)}`, 2, (w) => {
            w.u1(TAG.Double);
            w.f8(v);
        });
    }

    /** `internalName` is `java/lang/String`, or an array descriptor such as `[I`. */
    cls(internalName: string): number {
        const name = this.utf8(internalName);
        return this.intern(`C${internalName}`, 1, (w) => {
            w.u1(TAG.Class);
            w.u2(name);
        });
    }

    string(s: string): number {
        const utf = this.utf8(s);
        return this.intern(`S${s}`, 1, (w) => {
            w.u1(TAG.String);
            w.u2(utf);
        });
    }

    nameAndType(name: string, desc: string): number {
        const n = this.utf8(name);
        const d = this.utf8(desc);
        return this.intern(`N${name}\u0000${desc}`, 1, (w) => {
            w.u1(TAG.NameAndType);
            w.u2(n);
            w.u2(d);
        });
    }

    private ref(tag: number, kind: string, owner: string, name: string, desc: string): number {
        const c = this.cls(owner);
        const nt = this.nameAndType(name, desc);
        return this.intern(`${kind}${owner}\u0000${name}\u0000${desc}`, 1, (w) => {
            w.u1(tag);
            w.u2(c);
            w.u2(nt);
        });
    }

    fieldRef(owner: string, name: string, desc: string): number {
        return this.ref(TAG.Fieldref, 'f', owner, name, desc);
    }

    methodRef(owner: string, name: string, desc: string): number {
        return this.ref(TAG.Methodref, 'm', owner, name, desc);
    }

    interfaceMethodRef(owner: string, name: string, desc: string): number {
        return this.ref(TAG.InterfaceMethodref, 'i', owner, name, desc);
    }

    /** The serialized entries, without the leading count. */
    entriesBytes(): Uint8Array {
        return this.out.toBytes();
    }
}
