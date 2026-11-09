import { ByteWriter } from './byte-writer.ts';
import { CodeBuilder, type CodeData } from './code-builder.ts';
import { ConstantPool } from './constant-pool.ts';

export const Acc = {
    PUBLIC: 0x0001,
    PRIVATE: 0x0002,
    PROTECTED: 0x0004,
    STATIC: 0x0008,
    FINAL: 0x0010,
    /** Class: ACC_SUPER. Set automatically on non-interfaces. */
    SUPER: 0x0020,
    SYNCHRONIZED: 0x0020,
    VOLATILE: 0x0040,
    BRIDGE: 0x0040,
    TRANSIENT: 0x0080,
    VARARGS: 0x0080,
    NATIVE: 0x0100,
    INTERFACE: 0x0200,
    ABSTRACT: 0x0400,
    STRICT: 0x0800,
    SYNTHETIC: 0x1000,
    ANNOTATION: 0x2000,
    ENUM: 0x4000,
} as const;

export interface ClassOptions {
    /** Internal name of the superclass. Defaults to java/lang/Object. */
    superName?: string;
    /** Access flags. Defaults to ACC_PUBLIC. */
    access?: number;
    interfaces?: string[];
    sourceFile?: string;
    /**
     * Class-file major version. Defaults to 50 (Java 6), the last version that
     * doesn't require a StackMapTable, which CodeBuilder doesn't emit.
     */
    majorVersion?: number;
}

export type ConstantValue = number | bigint | string;

interface FieldInfo {
    access: number;
    name: string;
    desc: string;
    constantValue?: ConstantValue;
}

interface MethodInfo {
    access: number;
    name: string;
    desc: string;
    code?: CodeData;
}

/** Builds one `.class` file. Add fields and methods, then call `toBytes()`. */
export class ClassWriter {
    readonly name: string;
    readonly cp = new ConstantPool();
    private readonly options: ClassOptions;
    private readonly fields: FieldInfo[] = [];
    private readonly methods: MethodInfo[] = [];

    /** `name` is the internal name, e.g. `com/example/Foo`. */
    constructor(name: string, options: ClassOptions = {}) {
        this.name = name;
        this.options = options;
    }

    addField(access: number, name: string, desc: string, constantValue?: ConstantValue): void {
        this.fields.push({ access, name, desc, constantValue });
    }

    /**
     * Adds a method. Concrete methods must supply `body`, which assembles the code;
     * abstract and native methods must not.
     */
    addMethod(access: number, name: string, desc: string, body?: (code: CodeBuilder) => void): void {
        const hasCode = (access & (Acc.ABSTRACT | Acc.NATIVE)) === 0;
        if (hasCode !== (body !== undefined)) {
            throw new Error(`${this.name}.${name}${desc}: ${hasCode ? 'needs a body' : 'must not have a body'}`);
        }
        let code: CodeData | undefined;
        if (body) {
            const builder = new CodeBuilder(this.cp, (access & Acc.STATIC) !== 0, desc);
            try {
                body(builder);
                code = builder.build();
            } catch (e) {
                throw new Error(`${this.name}.${name}${desc}: ${e instanceof Error ? e.message : String(e)}`, {
                    cause: e,
                });
            }
        }
        this.methods.push({ access, name, desc, code });
    }

    toBytes(): Uint8Array {
        const { cp, options } = this;
        const isInterface = ((options.access ?? Acc.PUBLIC) & Acc.INTERFACE) !== 0;
        const access = (options.access ?? Acc.PUBLIC) | (isInterface ? 0 : Acc.SUPER);

        // The pool must be complete before it is written, so build the body first.
        const body = new ByteWriter();
        body.u2(access);
        body.u2(cp.cls(this.name));
        body.u2(cp.cls(options.superName ?? 'java/lang/Object'));
        const interfaces = options.interfaces ?? [];
        body.u2(interfaces.length);
        for (const i of interfaces) body.u2(cp.cls(i));

        body.u2(this.fields.length);
        for (const f of this.fields) this.writeField(body, f);

        body.u2(this.methods.length);
        for (const m of this.methods) this.writeMethod(body, m);

        if (options.sourceFile === undefined) {
            body.u2(0);
        } else {
            body.u2(1);
            const attr = new ByteWriter();
            attr.u2(cp.utf8(options.sourceFile));
            this.attribute(body, 'SourceFile', attr);
        }

        const out = new ByteWriter();
        out.u4(0xcafebabe);
        out.u2(0);
        out.u2(options.majorVersion ?? 50);
        out.u2(cp.count);
        out.bytes(cp.entriesBytes());
        out.bytes(body.toBytes());
        return out.toBytes();
    }

    private attribute(w: ByteWriter, name: string, content: ByteWriter): void {
        w.u2(this.cp.utf8(name));
        w.u4(content.length);
        w.bytes(content.toBytes());
    }

    private writeField(w: ByteWriter, f: FieldInfo): void {
        w.u2(f.access);
        w.u2(this.cp.utf8(f.name));
        w.u2(this.cp.utf8(f.desc));
        if (f.constantValue === undefined) {
            w.u2(0);
            return;
        }
        w.u2(1);
        const attr = new ByteWriter();
        attr.u2(this.constantIndex(f));
        this.attribute(w, 'ConstantValue', attr);
    }

    private constantIndex(f: FieldInfo): number {
        const v = f.constantValue!;
        switch (f.desc) {
            case 'B':
            case 'C':
            case 'S':
            case 'Z':
            case 'I':
                if (typeof v === 'number') return this.cp.integer(v);
                break;
            case 'J':
                if (typeof v === 'bigint') return this.cp.long(v);
                break;
            case 'F':
                if (typeof v === 'number') return this.cp.float(v);
                break;
            case 'D':
                if (typeof v === 'number') return this.cp.double(v);
                break;
            case 'Ljava/lang/String;':
                if (typeof v === 'string') return this.cp.string(v);
                break;
        }
        throw new Error(`${this.name}.${f.name}: constant ${typeof v} doesn't match field type ${f.desc}`);
    }

    private writeMethod(w: ByteWriter, m: MethodInfo): void {
        w.u2(m.access);
        w.u2(this.cp.utf8(m.name));
        w.u2(this.cp.utf8(m.desc));
        if (!m.code) {
            w.u2(0);
            return;
        }
        w.u2(1);
        this.attribute(w, 'Code', this.codeAttribute(m.code));
    }

    private codeAttribute(c: CodeData): ByteWriter {
        const a = new ByteWriter();
        a.u2(c.maxStack);
        a.u2(c.maxLocals);
        a.u4(c.code.length);
        a.bytes(c.code);
        a.u2(c.exceptions.length);
        for (const e of c.exceptions) {
            a.u2(e.start);
            a.u2(e.end);
            a.u2(e.handler);
            a.u2(e.catchType);
        }
        if (c.lines.length === 0) {
            a.u2(0);
        } else {
            a.u2(1);
            const table = new ByteWriter();
            table.u2(c.lines.length);
            for (const l of c.lines) {
                table.u2(l.pc);
                table.u2(l.line);
            }
            this.attribute(a, 'LineNumberTable', table);
        }
        return a;
    }
}
