import type { ValueType } from './hir.ts';

export interface ForeignMethod {
  name: string;
  params: ValueType[];
  returnType: ValueType;
  isStatic: boolean;
}

export interface ForeignClassInfo {
  tsName: string;
  jvmInternalName: string;
  methods: ForeignMethod[];
}

const F64: ValueType = { kind: 'f64' };
const STRING: ValueType = { kind: 'string' };
const BOOLEAN: ValueType = { kind: 'boolean' };

function staticMethod(name: string, params: ValueType[], returnType: ValueType): ForeignMethod {
  return { name, params, returnType, isStatic: true };
}

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
      staticMethod('d', [STRING, STRING], BOOLEAN),
      staticMethod('e', [STRING, STRING], BOOLEAN),
      staticMethod('i', [STRING, STRING], BOOLEAN),
      staticMethod('w', [STRING, STRING], BOOLEAN),
    ],
  });

  return registry;
}
