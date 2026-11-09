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
node scripts/compile.ts file.ts outDir [ClassName]   # writes outDir/ClassName.class
node scripts/show.ts file.ts [hir|lir]               # dump an IR as JSON
javap -c -cp outDir ClassName                        # disassemble the result
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

### Phase 3: HIR to LIR

- [x] Define the LIR (`src/middle/lir.ts`): JVM-typed tree, descriptors as types, structured control flow
- [x] Lowering pass (`src/middle/lower-hir-to-lir.ts`): boxing to `Object`, string concat chains, `String.equals`, throwable wrapping, call descriptors
- [x] Tests (`test/middle/lir.test.ts`)
- [x] HIR `call` carries the resolved foreign overload; `ForeignMethod.jvmDescriptor` for `Log` (real return is `int`)
- [x] `throw` accepts only strings (wrapped in `RuntimeException`) or a caught error (rethrown)

### Phase 4: Codegen and first end-to-end run

- [x] LIR to `CodeBuilder` (`src/backend/codegen.ts`)
- [x] Compiled output runs on the JVM (`test/backend/e2e.test.ts`, `scripts/compile.ts`)
- [x] String concat, foreign calls, try/catch/finally (finally inlined on normal exit and `return`; catch-all rethrows)
- [x] Number to string matches JS for whole numbers (`2`, not `2.0`); 1e21 and 1e-7 still differ

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
