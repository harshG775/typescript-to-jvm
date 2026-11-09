import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import {
    ACC_BRIDGE,
    ACC_INTERFACE,
    ACC_PROTECTED,
    ACC_PUBLIC,
    ACC_STATIC,
    ACC_SYNTHETIC,
    readClass,
    type ClassInfo,
} from '../classfile/reader.ts';
import {
    methodFromDescriptor,
    type ClassResolver,
    type ForeignClass,
    type ForeignMethod,
} from '../frontend/type-registry.ts';

interface Entry {
    method: number;
    compressedSize: number;
    localOffset: number;
}

/** Read-only view of a zip/jar file: just enough of the format to pull class files out of android.jar. */
export class Jar {
    private readonly buf: Buffer;
    private readonly entries = new Map<string, Entry>();

    constructor(path: string) {
        this.buf = readFileSync(path);
        const buf = this.buf;
        let eocd = buf.length - 22;
        while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
        if (eocd < 0) throw new Error(`${path}: not a zip file`);
        const count = buf.readUInt16LE(eocd + 10);
        let pos = buf.readUInt32LE(eocd + 16);
        if (count === 0xffff || pos === 0xffffffff) throw new Error(`${path}: zip64 archives are not supported`);

        for (let i = 0; i < count; i++) {
            if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error(`${path}: corrupt central directory`);
            const nameLen = buf.readUInt16LE(pos + 28);
            const extraLen = buf.readUInt16LE(pos + 30);
            const commentLen = buf.readUInt16LE(pos + 32);
            this.entries.set(buf.toString('utf8', pos + 46, pos + 46 + nameLen), {
                method: buf.readUInt16LE(pos + 10),
                compressedSize: buf.readUInt32LE(pos + 20),
                localOffset: buf.readUInt32LE(pos + 42),
            });
            pos += 46 + nameLen + extraLen + commentLen;
        }
    }

    read(name: string): Uint8Array | undefined {
        const e = this.entries.get(name);
        if (!e) return undefined;
        const nameLen = this.buf.readUInt16LE(e.localOffset + 26);
        const extraLen = this.buf.readUInt16LE(e.localOffset + 28);
        const start = e.localOffset + 30 + nameLen + extraLen;
        const data = this.buf.subarray(start, start + e.compressedSize);
        if (e.method === 0) return data;
        if (e.method === 8) return inflateRawSync(data);
        throw new Error(`${name}: unsupported zip compression method ${e.method}`);
    }
}

/** Turns a parsed class into what the front end needs: public/protected members whose types TS can express. */
export function foreignFromInfo(info: ClassInfo): ForeignClass {
    const ctors: ForeignMethod[] = [];
    const methods: ForeignMethod[] = [];
    for (const m of info.methods) {
        if (!(m.access & (ACC_PUBLIC | ACC_PROTECTED)) || m.access & (ACC_SYNTHETIC | ACC_BRIDGE)) continue;
        if (m.name === '<clinit>') continue;
        const fm = methodFromDescriptor(m.name, m.descriptor, (m.access & ACC_STATIC) !== 0);
        if (!fm) continue;
        (m.name === '<init>' ? ctors : methods).push(fm);
    }
    return {
        name: info.name,
        superName: info.superName,
        interfaces: info.interfaces,
        isInterface: (info.access & ACC_INTERFACE) !== 0,
        ctors,
        methods,
    };
}

/** Resolves classes from a jar (android.jar includes java.* too). Classes are parsed on first use. */
export class JarClassResolver implements ClassResolver {
    private readonly jar: Jar;
    private readonly cache = new Map<string, ForeignClass | null>();

    constructor(jarPath: string) {
        this.jar = new Jar(jarPath);
    }

    lookup(internalName: string): ForeignClass | undefined {
        const cached = this.cache.get(internalName);
        if (cached !== undefined) return cached ?? undefined;
        const bytes = this.jar.read(`${internalName}.class`);
        const cls = bytes ? foreignFromInfo(readClass(bytes)) : null;
        this.cache.set(internalName, cls);
        return cls ?? undefined;
    }
}
