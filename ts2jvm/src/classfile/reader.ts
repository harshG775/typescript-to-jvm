/** The parts of a `.class` file the compiler needs to call into existing JVM/Android classes. */
export interface ClassInfo {
    name: string;
    superName: string | null;
    interfaces: string[];
    access: number;
    methods: { name: string; descriptor: string; access: number }[];
}

export const ACC_PUBLIC = 0x0001;
export const ACC_PROTECTED = 0x0004;
export const ACC_STATIC = 0x0008;
export const ACC_BRIDGE = 0x0040;
export const ACC_INTERFACE = 0x0200;
export const ACC_SYNTHETIC = 0x1000;

/** Parses a class file: constant pool, class names, and the method table. Attributes are skipped. */
export function readClass(bytes: Uint8Array): ClassInfo {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    const u1 = (): number => buf.readUInt8(pos++);
    const u2 = (): number => {
        const v = buf.readUInt16BE(pos);
        pos += 2;
        return v;
    };
    const u4 = (): number => {
        const v = buf.readUInt32BE(pos);
        pos += 4;
        return v;
    };

    if (u4() !== 0xcafebabe) throw new Error('not a class file');
    pos += 4; // minor + major version

    const count = u2();
    const utf8 = new Map<number, string>();
    const classNameIndex = new Map<number, number>();
    for (let i = 1; i < count; i++) {
        const tag = u1();
        switch (tag) {
            case 1: {
                const len = u2();
                utf8.set(i, buf.toString('utf8', pos, pos + len));
                pos += len;
                break;
            }
            case 7:
                classNameIndex.set(i, u2());
                break;
            case 8:
            case 16:
            case 19:
            case 20:
                pos += 2;
                break;
            case 15:
                pos += 3;
                break;
            case 3:
            case 4:
            case 9:
            case 10:
            case 11:
            case 12:
            case 17:
            case 18:
                pos += 4;
                break;
            case 5:
            case 6:
                pos += 8;
                i++; // long and double take two constant-pool slots
                break;
            default:
                throw new Error(`unknown constant pool tag ${tag}`);
        }
    }

    const str = (i: number): string => utf8.get(i) ?? '';
    const cls = (i: number): string => str(classNameIndex.get(i) ?? 0);

    const access = u2();
    const name = cls(u2());
    const superIndex = u2();
    const interfaces: string[] = [];
    for (let n = u2(); n > 0; n--) interfaces.push(cls(u2()));

    const skipAttributes = (): void => {
        for (let n = u2(); n > 0; n--) {
            pos += 2;
            const len = u4();
            pos += len;
        }
    };
    for (let n = u2(); n > 0; n--) {
        pos += 6; // fields: access, name, descriptor
        skipAttributes();
    }
    const methods: ClassInfo['methods'] = [];
    for (let n = u2(); n > 0; n--) {
        const mAccess = u2();
        const mName = str(u2());
        const descriptor = str(u2());
        skipAttributes();
        methods.push({ name: mName, descriptor, access: mAccess });
    }

    return { name, superName: superIndex === 0 ? null : cls(superIndex), interfaces, access, methods };
}
