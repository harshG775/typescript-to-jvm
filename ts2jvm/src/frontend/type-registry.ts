import { parseMethodDescriptor } from '../classfile/descriptors.ts';
import type { ValueType } from './hir.ts';

/**
 * A method or constructor of a class that already exists on the JVM (java.*, android.*).
 * `params`/`returnType` are what TypeScript sees: every JVM numeric type (int, long, float, ...) is `f64`.
 * `descriptor` is the real JVM signature; the middle end converts between the two at each call.
 */
export interface ForeignMethod {
    name: string;
    params: ValueType[];
    returnType: ValueType;
    isStatic: boolean;
    descriptor: string;
}

export interface ForeignClass {
    /** JVM internal name, e.g. `android/app/Activity`. */
    name: string;
    superName: string | null;
    interfaces: string[];
    isInterface: boolean;
    ctors: ForeignMethod[];
    methods: ForeignMethod[];
}

/** Looks up classes by JVM internal name. Implemented by android.jar (real) and a small built-in table (tests). */
export interface ClassResolver {
    lookup(internalName: string): ForeignClass | undefined;
}

const NUMERIC = 'BCDFIJS';

/** Descriptor -> the TS-facing type, or undefined for types the language can't express yet (arrays). */
export function typeFromDescriptor(desc: string): ValueType | undefined {
    if (desc === 'V') return { kind: 'void' };
    if (desc === 'Z') return { kind: 'boolean' };
    if (desc.length === 1 && NUMERIC.includes(desc)) return { kind: 'f64' };
    if (desc === 'Ljava/lang/String;') return { kind: 'string' };
    if (desc.startsWith('L') && desc.endsWith(';')) return { kind: 'object', className: desc.slice(1, -1) };
    return undefined;
}

/** Builds a ForeignMethod from a JVM descriptor, or undefined if it uses a type TS can't express (arrays). */
export function methodFromDescriptor(name: string, descriptor: string, isStatic: boolean): ForeignMethod | undefined {
    const d = parseMethodDescriptor(descriptor);
    const params = d.params.map(typeFromDescriptor);
    const returnType = typeFromDescriptor(d.returns);
    if (!returnType || params.some((p) => p === undefined)) return undefined;
    return { name, params: params as ValueType[], returnType, isStatic, descriptor };
}
