import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { compileFileToHir, compileSourceToHir } from '../../src/frontend/compile-file.ts';
import { FrontendError } from '../../src/frontend/errors.ts';
import type { HirFunction, HirProgram, HirStmt } from '../../src/frontend/hir.ts';
import { builtinResolver } from '../../src/frontend/builtin-classes.ts';

const F64 = { kind: 'f64' };
const STRING = { kind: 'string' };
const BOOLEAN = { kind: 'boolean' };
const OBJECT = { kind: 'object', className: 'java/lang/Object' };

function compile(source: string): HirProgram {
    return compileSourceToHir(source, { classes: builtinResolver(), fileName: 'test.ts' });
}

function only(source: string): HirFunction {
    const { functions } = compile(source);
    expect(functions).toHaveLength(1);
    return functions[0]!;
}

function stmts(fn: HirFunction): HirStmt[] {
    if (fn.body.k !== 'block') throw new Error('function body is not a block');
    return fn.body.stmts;
}

describe('HIR front end', () => {
    it('1. lowers simple arithmetic', () => {
        const fn = only('function add(a:number,b:number):number{return a+b;}');
        expect(fn.name).toBe('add');
        expect(fn.params).toEqual([
            { name: 'a', type: F64, slot: 0 },
            { name: 'b', type: F64, slot: 2 },
        ]);
        expect(fn.returnType).toEqual(F64);
        expect(stmts(fn)).toEqual([
            {
                k: 'return',
                expr: {
                    k: 'binary',
                    op: '+',
                    left: { k: 'local', slot: 0, type: F64 },
                    right: { k: 'local', slot: 2, type: F64 },
                    resultType: F64,
                },
            },
        ]);
    });

    it('2. lowers string concatenation', () => {
        const fn = only('function f(s:string):string{return s+"!";}');
        expect(stmts(fn)).toEqual([
            {
                k: 'return',
                expr: {
                    k: 'binary',
                    op: '+',
                    left: { k: 'local', slot: 0, type: STRING },
                    right: { k: 'str', value: '!' },
                    resultType: STRING,
                },
            },
        ]);
    });

    it('3. lowers if/else', () => {
        const fn = only('function f(x:number):number{if(x>0)return 1;else return -1;}');
        const [stmt] = stmts(fn);
        expect(stmt).toMatchObject({
            k: 'if',
            cond: { k: 'binary', op: '>', resultType: BOOLEAN },
            then: { k: 'return', expr: { k: 'num', value: 1 } },
            else_: { k: 'return', expr: { k: 'unary', op: '-', operand: { k: 'num', value: 1 } } },
        });
    });

    it('4. lowers while and counts f64 as two slots', () => {
        const fn = only('function f():void{let i=0;while(i<10){i=i+1;}let j=0;}');
        expect(fn.locals).toEqual([
            { name: 'i', type: F64, slot: 0 },
            { name: 'j', type: F64, slot: 2 },
        ]);
        const [, loop] = stmts(fn);
        expect(loop).toMatchObject({
            k: 'while',
            body: { k: 'block', stmts: [{ k: 'expr', expr: { k: 'assign', slot: 0, type: F64 } }] },
        });
    });

    it('5. lowers a foreign call', () => {
        const fn = only('function f(x:number):number{return Math.abs(x);}');
        expect(stmts(fn)).toMatchObject([
            {
                k: 'return',
                expr: {
                    k: 'call',
                    calleeName: 'Math.abs',
                    args: [{ k: 'local', slot: 0, type: F64 }],
                    resultType: F64,
                    foreign: { owner: 'java/lang/Math', method: { name: 'abs' } },
                },
            },
        ]);
    });

    it('6. rejects an unknown foreign method', () => {
        const run = () => compile('function f(x:number):number{return Math.nope(x);}');
        expect(run).toThrow(FrontendError);
        expect(run).toThrow(/Math\.nope/);
        expect(run).toThrow(/test\.ts:1:/);
    });

    it('7. rejects arrow functions at top level and inside bodies', () => {
        expect(() => compile('const f = ()=>{ };')).toThrow(FrontendError);
        expect(() => compile('const f = ()=>{ };')).toThrow(/unsupported top-level statement/);
        expect(() => compile('function g():void{ const f = ()=>{ }; }')).toThrow(/closures/);
        expect(() => compile('function g():void{ function h():void{} }')).toThrow(/closures/);
    });

    it('8. rejects async functions', () => {
        const run = () => compile('async function f(){ await g(); }');
        expect(run).toThrow(FrontendError);
        expect(run).toThrow(/async/);
    });

    it('9. maps any to java/lang/Object', () => {
        const fn = only('function f(x:any):void{ }');
        expect(fn.params).toEqual([{ name: 'x', type: OBJECT, slot: 0 }]);
        expect(fn.returnType).toEqual({ kind: 'void' });
    });

    it('10. lowers try/catch/finally', () => {
        const fn = only('function f():void{ try { let a = 1; } catch (e) { let b = 2; } finally { let c = 3; } }');
        const [stmt] = stmts(fn);
        expect(stmt).toMatchObject({
            k: 'try',
            try_: { k: 'block' },
            catchVar: { name: 'e', slot: 2, type: OBJECT },
            catch_: { k: 'block' },
            finally_: { k: 'block' },
        });
        expect(fn.locals.map((l) => l.name)).toEqual(['a', 'e', 'b', 'c']);
    });

    it('11. lowers throw', () => {
        const fn = only('function f():void{ throw "boom"; }');
        expect(stmts(fn)).toEqual([{ k: 'throw', expr: { k: 'str', value: 'boom' } }]);
    });

    it('12. rejects multiple declarators', () => {
        expect(() => compile('function f():void{ let a=0, b=0; }')).toThrow(FrontendError);
    });

    it('13. assigns slots with params first and two slots per number', () => {
        const fn = only('function f(a:number,b:number,c:number, d:string):void{ let x=0; }');
        expect(fn.params.map((p) => p.slot)).toEqual([0, 2, 4, 6]);
        expect(fn.locals).toEqual([{ name: 'x', type: F64, slot: 7 }]);
    });

    it('14. compiles a fixture from disk', () => {
        const file = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello.ts');
        const { functions } = compileFileToHir(file, builtinResolver());
        expect(functions).toHaveLength(1);
        expect(stmts(functions[0]!)).toMatchObject([
            {
                k: 'expr',
                expr: {
                    k: 'call',
                    calleeName: 'Log.d',
                    args: [
                        { k: 'str', value: 'ts2jvm' },
                        { k: 'str', value: 'hi' },
                    ],
                    resultType: F64,
                },
            },
        ]);
    });
});

describe('HIR front end: extra checks', () => {
    it('calls between top-level functions, including forward references', () => {
        const { functions } = compile('function a():number{return b(1);} function b(x:number):number{return x;}');
        expect(stmts(functions[0]!)).toMatchObject([
            { k: 'return', expr: { k: 'call', calleeName: 'b', resultType: F64 } },
        ]);
    });

    it('rejects argument type mismatches instead of coercing', () => {
        expect(() => compile('function f():number{return Math.abs("x");}')).toThrow(/Math\.abs/);
        expect(() => compile('function g(x:number):void{} function f():void{g("x");}')).toThrow(/argument 1/);
    });

    it('does not treat a shadowed registry name as the registry class', () => {
        expect(() => compile('function f(Math:number):number{return Math.abs(1);}')).toThrow(FrontendError);
    });

    it('checks return statements against the declared return type', () => {
        expect(() => compile('function f():void{ return 1; }')).toThrow(/void/);
        expect(() => compile('function f():number{ return; }')).toThrow(/missing return value/);
        expect(() => compile('function f():number{ return "x"; }')).toThrow(/cannot return/);
    });

    it('maps unions and unknown to Object and widens into them', () => {
        const fn = only('function f(x:string|number, y:unknown):any{ return x; }');
        expect(fn.params.map((p) => p.type)).toEqual([OBJECT, OBJECT]);
        expect(fn.returnType).toEqual(OBJECT);
    });

    it('rejects unsupported statements and operators with a source position', () => {
        expect(() => compile('function f():void{ for (;;) {} }')).toThrow(/test\.ts:1:/);
        expect(() => compile('function f(x:number):number{ return x ** 2; }')).toThrow(/unsupported operator/);
        expect(() => compile('function f(x:number):void{ x += 1; }')).toThrow(/unsupported operator/);
    });

    it('only allows throwing strings or caught errors', () => {
        expect(() => compile('function f():void{ throw 1; }')).toThrow(/can only throw/);
    });

    it('reports syntax errors as FrontendError', () => {
        expect(() => compile('function f( {')).toThrow(FrontendError);
    });
});

describe('HIR front end: classes', () => {
    const COUNTER =
        'class Counter { count: number = 1; constructor(start: number) { this.count = start; } inc(by: number): number { return this.count + by; } }';

    it('lowers a class: fields, constructor with initializers first, methods with this in slot 0', () => {
        const { classes } = compile(COUNTER);
        expect(classes).toHaveLength(1);
        const [c] = classes;
        expect(c!.name).toBe('Counter');
        expect(c!.fields).toEqual([{ name: 'count', type: F64 }]);

        expect(c!.ctor.name).toBe('<init>');
        expect(c!.ctor.params).toEqual([{ name: 'start', type: F64, slot: 1 }]);
        expect(c!.ctor.body).toMatchObject({
            k: 'block',
            stmts: [
                { k: 'expr', expr: { k: 'set-field', name: 'count', rhs: { k: 'num', value: 1 } } },
                {
                    k: 'block',
                    stmts: [{ k: 'expr', expr: { k: 'set-field', name: 'count', rhs: { k: 'local', slot: 1 } } }],
                },
            ],
        });

        const inc = c!.methods[0]!;
        expect(inc.params).toEqual([{ name: 'by', type: F64, slot: 1 }]);
        expect(stmts(inc)).toMatchObject([
            {
                k: 'return',
                expr: { k: 'binary', left: { k: 'field', object: { k: 'this' }, owner: 'Counter', name: 'count' } },
            },
        ]);
    });

    it('synthesizes a constructor when the class has none', () => {
        const { classes } = compile('class A { x: number = 2; }');
        expect(classes[0]!.ctor.params).toEqual([]);
        expect(classes[0]!.ctor.body).toMatchObject({ k: 'block', stmts: [{ k: 'expr' }, { k: 'block', stmts: [] }] });
    });

    it('lowers new, field access, field assignment and method calls', () => {
        const fn = compile(
            `${COUNTER} function f(): number { const c = new Counter(1); c.count = 5; return c.inc(2); }`,
        ).functions[0]!;
        expect(fn.locals).toEqual([{ name: 'c', type: { kind: 'object', className: 'Counter' }, slot: 0 }]);
        expect(stmts(fn)).toMatchObject([
            { k: 'var-decl', init: { k: 'new', className: 'Counter', args: [{ k: 'num', value: 1 }] } },
            { k: 'expr', expr: { k: 'set-field', owner: 'Counter', name: 'count' } },
            { k: 'return', expr: { k: 'call-method', owner: 'Counter', name: 'inc', resultType: F64 } },
        ]);
    });

    it('allows a class to be used before it is declared', () => {
        expect(() => compile('function f(): number { return new A().x; } class A { x: number = 1; }')).not.toThrow();
    });

    it('widens a class instance to any', () => {
        const fn = compile('class A {} function f(a: A): any { return a; }').functions[0]!;
        expect(fn.returnType).toEqual(OBJECT);
    });

    it('rejects unsupported class features with a source position', () => {
        expect(() => compile('class A extends B {}')).toThrow(/unknown class 'B'/);
        expect(() => compile('class A { private x: number = 0; }')).toThrow(/modifier/);
        expect(() => compile('class A { static x: number = 0; }')).toThrow(/modifier/);
        expect(() => compile('class A { constructor(public x: number) {} }')).toThrow(/parameter properties/);
        expect(() => compile('class A { get x(): number { return 1; } }')).toThrow(/unsupported class member/);
        expect(() => compile('class A { x: number = 0; x: number = 1; }')).toThrow(/duplicate member/);
        expect(() => compile('class A {} class A {}')).toThrow(/duplicate class/);
        expect(() => compile('class A {}\nfunction f(): void { new B(); }')).toThrow(/test\.ts:2:.*unknown class/);
    });

    it('checks field access, method calls and constructor arguments', () => {
        const A = 'class A { x: number = 0; m(): void {} constructor(n: number) {} }';
        expect(() => compile(`${A} function f(a: A): number { return a.nope; }`)).toThrow(/no field 'nope'/);
        expect(() => compile(`${A} function f(a: A): void { a.nope(); }`)).toThrow(/no method 'nope'/);
        expect(() => compile(`${A} function f(a: A): void { a.x(); }`)).toThrow(/no method 'x'/);
        expect(() => compile(`${A} function f(a: A): void { a.m; }`)).toThrow(/methods can only be called/);
        expect(() => compile(`${A} function f(): void { new A(); }`)).toThrow(/expects 1 arguments/);
        expect(() => compile(`${A} function f(): void { new A("s"); }`)).toThrow(/cannot pass string as f64/);
        expect(() => compile(`${A} function f(a: A): void { a.x = "s"; }`)).toThrow(/cannot assign string to f64/);
        expect(() => compile('function f(x: number): number { return x.y; }')).toThrow(/no fields or methods/);
        expect(() => compile('function f(): void { this.x = 1; }')).toThrow(/'this'/);
    });
});

describe('HIR front end: inheritance and Android classes', () => {
    const IMPORTS = `import { Activity } from 'android.app';
        import { Bundle } from 'android.os';
        import { TextView } from 'android.widget';`;
    const ACTIVITY = `${IMPORTS}
        class Screen extends Activity {
            onCreate(b: Bundle | null): void {
                super.onCreate(b);
                const tv = new TextView(this);
                tv.setText("hi");
                tv.setTextSize(20);
                this.setContentView(tv);
            }
        }`;

    it('lowers a class that extends an imported class, with super calls and foreign instance calls', () => {
        const [cls] = compile(ACTIVITY).classes;
        expect(cls!.name).toBe('Screen');
        expect(cls!.superName).toBe('android/app/Activity');
        expect(cls!.superCall).toEqual({ descriptor: '()V', args: [] });

        const body = stmts(cls!.methods[0]!);
        expect(body).toMatchObject([
            {
                k: 'expr',
                expr: {
                    k: 'call-method',
                    special: true,
                    owner: 'android/app/Activity',
                    name: 'onCreate',
                    descriptor: '(Landroid/os/Bundle;)V',
                },
            },
            {
                k: 'var-decl',
                type: { kind: 'object', className: 'android/widget/TextView' },
                init: { k: 'new', className: 'android/widget/TextView', descriptor: '(Landroid/content/Context;)V' },
            },
            { k: 'expr', expr: { k: 'call-method', owner: 'android/widget/TextView', name: 'setText' } },
            { k: 'expr', expr: { k: 'call-method', name: 'setTextSize', descriptor: '(F)V' } },
            { k: 'expr', expr: { k: 'call-method', owner: 'Screen', name: 'setContentView' } },
        ]);
    });

    it('picks overloads: a number prefers double over int, and narrows to int/float when it has to', () => {
        const fn = compile('function f(): number { return Math.abs(-3); }').functions[0]!;
        expect(stmts(fn)).toMatchObject([
            { k: 'return', expr: { k: 'call', foreign: { method: { descriptor: '(D)D' } } } },
        ]);
    });

    it('prefixes user classes with the package', () => {
        const { classes } = compileSourceToHir('class A { b: B | null = null; } class B {}', {
            classes: builtinResolver(),
            fileName: 'test.ts',
            classPrefix: 'com/example/',
        });
        expect(classes.map((c) => c.name)).toEqual(['com/example/A', 'com/example/B']);
        expect(classes[0]!.fields).toEqual([{ name: 'b', type: { kind: 'object', className: 'com/example/B' } }]);
    });

    it('supports extends between user classes, explicit super(...) and subtype assignability', () => {
        const src = `class Base { n: number; constructor(n: number) { this.n = n; } }
            class Derived extends Base { constructor() { super(5); } }
            function take(b: Base): number { return b.n; }
            function f(): number { return take(new Derived()); }`;
        const { classes } = compile(src);
        expect(classes[1]!.superName).toBe('Base');
        expect(classes[1]!.superCall).toMatchObject({ descriptor: '(D)V', args: [{ k: 'num', value: 5 }] });
        expect(() => compile(`${src} function g(d: Derived): void {} function h(b: Base): void { g(b); }`)).toThrow(
            /cannot pass Base as Derived/,
        );
    });

    it('rejects bad imports, bad super calls and overrides that would not override', () => {
        expect(() => compile("import { Nope } from 'android.app';")).toThrow(/class 'android.app.Nope' not found/);
        expect(() => compile("import { X } from './x';")).toThrow(/not a Java package/);
        expect(() => compile("import * as a from 'android.app';")).toThrow(/only named imports/);
        expect(() => compile('class A extends A {}')).toThrow(/circular/);
        expect(() => compile('class B { constructor(n: number) {} } class D extends B {}')).toThrow(
            /no constructor without arguments/,
        );
        expect(() => compile('function f(): void { super.x(); }')).toThrow(/'super' is only available/);
        expect(() =>
            compile(
                `${IMPORTS} class S extends Activity { onKeyDown(code: number, e: any): boolean { return true; } }`,
            ),
        ).toThrow(/doesn't match the JVM signature/);
    });
});
