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

## Layout

The repo root is an Android app written in TypeScript. The compiler is a workspace package it depends on, like anything in `node_modules`.

```
src/main.ts      your app: TypeScript that ts2jvm compiles (defines main())
tsconfig.json    typechecks src/ against ts2jvm/types
package.json     scripts: build, apk, install:device; depends on ts2jvm
ts2jvm/          the compiler package (CLI: ts2jvm)
  src/             frontend, middle, backend, classfile, android, cli.ts
  test/            compiler tests
  types/           ambient .d.ts for classes the app can call (Log)
  examples/        bytecode-compare: the same code in TS and Kotlin, to compare javap output
```

## Usage

```
pnpm install
pnpm typecheck        # typecheck your app (src/)
pnpm build            # src/main.ts -> build/classes/Main.class
pnpm apk              # src/main.ts -> build/app.apk (needs ANDROID_HOME)
pnpm install:device   # same, then adb install
pnpm test:compiler    # compiler tests (64)
pnpm lint             # oxlint (config: .oxlintrc.json); lint:fix applies safe fixes
pnpm format           # oxfmt (config: .oxfmtrc.json); format:check only verifies
pnpm check            # lint + format:check + both typechecks
javap -c -cp build/classes Main   # read the bytecode
```

Other CLI commands: `pnpm ts2jvm show [file] --stage hir|lir` dumps an IR as JSON; `pnpm ts2jvm` with no command lists everything.

The CLI is a `.ts` file run directly by Node. That works here because the workspace link resolves outside `node_modules`; publishing the package would need a JS build step.

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
- [x] Classfile tests moved to `ts2jvm/test/classfile/`
- [x] `ts2jvm/test/frontend/hir.test.ts`
- [x] `tsc --noEmit` clean
- [x] `vp test` passes (30 tests)
- [x] Update the test script for vite-plus

### Phase 3: HIR to LIR

- [x] Define the LIR (`ts2jvm/src/middle/lir.ts`): JVM-typed tree, descriptors as types, structured control flow
- [x] Lowering pass (`ts2jvm/src/middle/lower-hir-to-lir.ts`): boxing to `Object`, string concat chains, `String.equals`, throwable wrapping, call descriptors
- [x] Tests (`ts2jvm/test/middle/lir.test.ts`)
- [x] HIR `call` carries the resolved foreign overload; `ForeignMethod.jvmDescriptor` for `Log` (real return is `int`)
- [x] `throw` accepts only strings (wrapped in `RuntimeException`) or a caught error (rethrown)

### Phase 4: Codegen and first end-to-end run

- [x] LIR to `CodeBuilder` (`ts2jvm/src/backend/codegen.ts`)
- [x] Compiled output runs on the JVM (`ts2jvm/test/backend/e2e.test.ts`, `ts2jvm compile`)
- [x] String concat, foreign calls, try/catch/finally (finally inlined on normal exit and `return`; catch-all rethrows)
- [x] Number to string matches JS for whole numbers (`2`, not `2.0`); 1e21 and 1e-7 still differ

### Phase 5: Android integration

- [x] D8 on compiler output (`ts2jvm/src/android/sdk.ts`)
- [x] Signed debug APK without Gradle: `pnpm apk` (D8, aapt2, zipalign, apksigner; test in `ts2jvm/test/android/`)
- [x] Activity stub generated with our own `ClassWriter`; its `onCreate` calls the TS `main()`
- [x] Run the APK on a device: `Log.d` from TS shows in logcat (`adb logcat -s ts2jvm`) and the Activity renders
- [ ] Gradle task (only if the script approach stops being enough)
- [ ] `.d.ts` and registry generated from `android.jar`
- [ ] `Activity` written in TS (needs classes, Phase 6)

### Phase 6: Language growth

- [x] User classes: fields (with initializers), constructor, methods, `this`, `new`, field access/assignment, method calls; one `.class` per TS class
- [ ] Classes that `extends` a foreign class (`Activity`), `super` calls, overriding
- [ ] Calling instance methods and `new` on foreign (Android) classes, with subtype-aware assignability
- [ ] `int`: foreign `int` params/returns convert from/to `number` (d2i / i2d) instead of adding a TS-level int type
- [ ] Arrays, interfaces, user-class inheritance, `for`/`switch`
- [ ] Generics, closures, async

### Phase 7: Tooling

- [ ] CLI
- [ ] StackMapTable (class version 51+)
- [ ] Source maps, debugging, R8 rules
