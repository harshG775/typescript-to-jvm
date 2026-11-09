# typescript-to-jvm

Compiles a static subset of TypeScript to JVM bytecode (`.class` files), so it can be converted to DEX with D8 and run on Android with no JavaScript runtime.

Pipeline: TS source → parse/typecheck (`typescript` package) → HIR → LIR → codegen → class writer → `.class` (version 50) → D8 → DEX → APK

## Design decisions

- `number` is always `f64`
- `any`, `unknown` and unions become `java/lang/Object`
- `string` is `java/lang/String`
- Two-level IR (HIR then LIR), generics by erasure
- Android classes come from a hand-written registry for now
- Closures and async are errors in v1

## Setup

```
vp install
pnpm typecheck
vp test
```

## Progress

### Phase 0: Decisions

- [x] Compile TS to JVM bytecode with no JS runtime
- [x] `number` is `f64`; `any`/`unknown`/unions are `Object`
- [x] Two-level IR, erasure for generics
- [x] Hand-written Android registry
- [x] Closures and async are errors in v1

### Phase 1: Class-file backend

- [x] ByteWriter, ConstantPool, ClassWriter
- [x] CodeBuilder (labels, `max_stack`, switches, try/catch, line numbers)
- [x] Tests: output runs on the JVM and D8 accepts it

### Phase 2: TS front end to HIR

- [x] Dependencies, `hir.ts`, `type-registry.ts`, `errors.ts`, `compile-file.ts`
- [x] `lower-ts-to-hir.ts`
- [x] Fixture `hello.ts`
- [x] Classfile tests moved to `test/classfile/`
- [x] `test/frontend/hir.test.ts`
- [x] `tsc --noEmit` clean
- [x] `vp test` passes (30 tests)
- [x] Update the test script for vite-plus

### Phase 3: HIR to LIR to bytecode

- [ ] Not started

### Phase 3: HIR to LIR

- [ ] Define the LIR
- [ ] Lowering pass
- [ ] Tests

### Phase 4: Codegen and first end-to-end run

- [ ] LIR to `CodeBuilder`
- [ ] `add.ts` compiles and runs on the JVM
- [ ] String concat, foreign calls, try/catch/finally

### Phase 5: Android integration

- [ ] D8 on compiler output
- [ ] Gradle task
- [ ] `.d.ts` and registry generated from `android.jar`
- [ ] `Activity` from TS, build and run an APK

### Phase 6: Language growth

- [ ] `int`, arrays, classes and interfaces, `for`/`switch`
- [ ] Generics, closures, async

### Phase 7: Tooling

- [ ] CLI
- [ ] StackMapTable (class version 51+)
- [ ] Source maps, debugging, R8 rules
