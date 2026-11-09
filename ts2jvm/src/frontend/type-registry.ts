import type { ValueType } from './hir.ts';

export interface ForeignMethod {
    name: string;
    params: ValueType[];
    returnType: ValueType;
    isStatic: boolean;
    /** Real JVM descriptor when it can't be derived from the TS-facing types (e.g. Log.d returns int). */
    jvmDescriptor?: string;
}

export interface ForeignClassInfo {
    tsName: string;
    jvmInternalName: string;
    methods: ForeignMethod[];
}

const F64: ValueType = { kind: 'f64' };
const STRING: ValueType = { kind: 'string' };
const BOOLEAN: ValueType = { kind: 'boolean' };

function staticMethod(name: string, params: ValueType[], returnType: ValueType, jvmDescriptor?: string): ForeignMethod {
    return jvmDescriptor === undefined
        ? { name, params, returnType, isStatic: true }
        : { name, params, returnType, isStatic: true, jvmDescriptor };
}

const LOG_DESC = '(Ljava/lang/String;Ljava/lang/String;)I';

/** Hand-written foreign-class table, consulted at call sites by identifier text (not by TS type). */
export function createDefaultRegistry(): Map<string, ForeignClassInfo> {
    const registry = new Map<string, ForeignClassInfo>();

    registry.set('Math', {
        tsName: 'Math',
        jvmInternalName: 'java/lang/Math',
        methods: [
            staticMethod('abs', [F64], F64),
            staticMethod('floor', [F64], F64),
            staticMethod('ceil', [F64], F64),
            staticMethod('sqrt', [F64], F64),
            staticMethod('random', [], F64),
            staticMethod('min', [F64, F64], F64),
            staticMethod('max', [F64, F64], F64),
        ],
    });

    // NOTE: the real android.util.Log methods return `int`. v1 has no i32 type, so they are
    // declared as returning boolean. Callers MUST discard the result; codegen can't use it.
    registry.set('Log', {
        tsName: 'Log',
        jvmInternalName: 'android/util/Log',
        methods: [
            staticMethod('d', [STRING, STRING], BOOLEAN, LOG_DESC),
            staticMethod('e', [STRING, STRING], BOOLEAN, LOG_DESC),
            staticMethod('i', [STRING, STRING], BOOLEAN, LOG_DESC),
            staticMethod('w', [STRING, STRING], BOOLEAN, LOG_DESC),
        ],
    });

    return registry;
}
