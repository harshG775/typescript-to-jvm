import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { findAndroidSdk } from '../../src/android/sdk.ts';
import { compileSourceToClasses, writeClassFiles } from '../../src/compile.ts';

/**
 * Compiles TypeScript to Main.class, then runs a small Java driver against it with the real JVM
 * (`java Driver.java` compiles and runs the driver in one step) and returns its stdout lines.
 */
function run(tsSource: string, javaMainBody: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'ts2jvm-e2e-'));
    writeClassFiles(compileSourceToClasses(tsSource, { fileName: 'test.ts' }), dir);
    writeFileSync(
        join(dir, 'Driver.java'),
        `public class Driver { public static void main(String[] args) throws Exception { ${javaMainBody} } }`,
    );
    const out = execFileSync('java', ['-cp', dir, join(dir, 'Driver.java')], { encoding: 'utf8' });
    return out.trim().split(/\r?\n/);
}

describe('TypeScript -> JVM end to end', () => {
    it('arithmetic, calls, loops, strings and booleans', () => {
        const ts = `
      function add(a: number, b: number): number { return a + b; }
      function fib(n: number): number { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
      function sumTo(n: number): number { let s = 0; let i = 1; while (i <= n) { s = s + i; i = i + 1; } return s; }
      function mod(a: number, b: number): number { return a % b; }
      function neg(a: number): number { return -a; }
      function greet(name: string, n: number): string { return "hi " + name + " x" + n + "!" ; }
      function cmp(a: number, b: number): string {
        if (a < b && b < 10) return "lt";
        else if (a == b || a > 100) return "eq";
        return "gt";
      }
      function nan(): boolean { const n = 0 / 0; return n < 1 || n >= 1 || n == n; }
      function nanNe(): boolean { const n = 0 / 0; return n != n; }
      function streq(a: string, b: string): boolean { return a == b; }
      function strne(a: string, b: string): boolean { return a != b; }
      function notTrue(): boolean { return !(1 < 2); }
      function pick(c: boolean): any { return c ? 1 : "s"; }
      function anyBool(): any { return true; }
      function chain(x: number): number { let y = 0; let z = 0; z = y = x * 2; return y + z; }
      function mathy(x: number): number { return Math.max(Math.abs(x), Math.sqrt(16)); }
      function unusedCall(): void { Math.abs(1); }
      function later(): number { return earlier(2); }
      function earlier(x: number): number { return x * 10; }
    `;
        const java = `
      System.out.println(Main.add(1.5, 2));
      System.out.println(Main.fib(10));
      System.out.println(Main.sumTo(100));
      System.out.println(Main.mod(7.5, 2));
      System.out.println(Main.neg(3));
      System.out.println(Main.greet("bob", 2.5) + " " + Main.greet("bob", 2) + " " + Main.greet("bob", -0.0) + " " + Main.greet("bob", 1.0 / 0));
      System.out.println(Main.cmp(1, 2) + Main.cmp(3, 3) + Main.cmp(5, 1) + Main.cmp(200, 1));
      System.out.println(Main.nan());
      System.out.println(Main.nanNe());
      System.out.println(Main.streq("a", new String("a")) + " " + Main.streq("a", "b"));
      System.out.println(Main.strne("a", "b") + " " + Main.strne("a", "a"));
      System.out.println(Main.notTrue());
      System.out.println(Main.pick(true) + " " + Main.pick(false));
      System.out.println(Main.anyBool());
      System.out.println(Main.chain(4));
      System.out.println(Main.mathy(-9));
      Main.unusedCall();
      System.out.println(Main.later());
    `;
        expect(run(ts, java)).toEqual([
            '3.5',
            '55.0',
            '5050.0',
            '1.5',
            '-3.0',
            'hi bob x2.5! hi bob x2! hi bob x0! hi bob xInfinity!',
            'lteqgteq',
            'false',
            'true',
            'true false',
            'true false',
            'false',
            '1.0 s',
            'true',
            '16.0',
            '9.0',
            '20.0',
        ]);
    });

    it('try / catch / finally, including return and rethrow through finally', () => {
        const ts = `
      function f1(n: number): string {
        let r = "";
        try { if (n > 0) throw "boom"; r = r + "ok"; } catch (e) { r = r + "caught"; } finally { r = r + "+fin"; }
        return r;
      }
      function noVar(): string { try { throw "x"; } catch { return "c"; } }
      function rethrow(): string {
        try { try { throw "inner"; } catch (e) { throw e; } } catch (e2) { return "outer"; }
      }
      function inLoop(n: number): string {
        let s = ""; let i = 0;
        while (i < n) { try { if (i == 1) throw "x"; s = s + i; } catch (e) { s = s + "c"; } i = i + 1; }
        return s;
      }
      function finallyOverridesReturn(): number { try { return 1; } finally { throw "from finally"; } }
      function returnInTry(): number { try { return 7; } finally { let z = 1; } }
      function returnInCatch(): string { try { throw "a"; } catch (e) { return "in catch"; } finally { let z = 1; } }
      function uncaught(): number { try { throw "up"; } finally { let z = 1; } }
      function nestedFinally(): number {
        try { try { return 1; } finally { let a = 1; } } finally { throw "outer fin"; }
      }
    `;
        const java = `
      System.out.println(Main.f1(0) + " " + Main.f1(1));
      System.out.println(Main.noVar());
      System.out.println(Main.rethrow());
      System.out.println(Main.inLoop(3));
      try { Main.finallyOverridesReturn(); } catch (RuntimeException e) { System.out.println(e.getMessage()); }
      System.out.println(Main.returnInTry());
      System.out.println(Main.returnInCatch());
      try { Main.uncaught(); } catch (RuntimeException e) { System.out.println(e.getMessage()); }
      try { Main.nestedFinally(); } catch (RuntimeException e) { System.out.println(e.getMessage()); }
    `;
        expect(run(ts, java)).toEqual([
            'ok+fin caught+fin',
            'c',
            'outer',
            '0c2',
            'from finally',
            '7.0',
            'in catch',
            'up',
            'outer fin',
        ]);
    });

    it('rejects a function that can fall off the end without returning', () => {
        expect(() =>
            compileSourceToClasses('function f(x: number): number { if (x > 0) return 1; }', { fileName: 't.ts' }),
        ).toThrow(/without returning/);
    });
});

describe('TypeScript classes on the JVM', () => {
    it('fields, constructors, methods, this, new and field assignment', () => {
        const ts = `
            class Counter {
                count: number = 10;
                label: string = "n";
                constructor(start: number) { this.count = this.count + start; }
                inc(): number { this.count = this.count + 1; return this.count; }
                describe(): string { return this.label + ":" + this.count; }
                twice(): number { this.inc(); return this.inc(); }
            }
            class Point {
                x: number;
                y: number;
                constructor(x: number, y: number) { this.x = x; this.y = y; }
                dist2(o: Point): number {
                    const dx = this.x - o.x;
                    const dy = this.y - o.y;
                    return dx * dx + dy * dy;
                }
            }
            class Wrapper { inner: Counter = new Counter(1); }
            function make(n: number): Counter { return new Counter(n); }
            function run(): string { const c = make(5); c.inc(); c.inc(); return c.describe(); }
            function dist(): number { return new Point(0, 0).dist2(new Point(3, 4)); }
            function chain(): number { const w = new Wrapper(); w.inner.count = 100; w.inner.inc(); return w.inner.count; }
            function asAny(): any { return new Counter(0); }
            function assignValue(): number { const c = new Counter(0); let n = 0; n = c.count = 7; return n + c.count; }
            function twiceViaNew(): number { return make(0).twice(); }
            function later(): number { return new Late().v; }
            class Late { v: number = 42; }
        `;
        const java = `
            System.out.println(Main.run());
            System.out.println(Main.dist());
            System.out.println(Main.chain());
            System.out.println(Main.asAny() instanceof Counter);
            System.out.println(Main.assignValue());
            System.out.println(Main.twiceViaNew());
            System.out.println(Main.later());
            Counter c = new Counter(1.5);
            System.out.println(c.count + " " + c.label + " " + c.describe());
        `;
        expect(run(ts, java)).toEqual(['n:17', '25.0', '101.0', 'true', '14.0', '12.0', '42.0', '11.5 n n:11.5']);
    });

    it('rejects a class that collides with the top-level functions class', () => {
        expect(() => compileSourceToClasses('class Main {}', { fileName: 't.ts' })).toThrow(/collides/);
    });
});

describe('inheritance on the JVM', () => {
    it('extends, super(...), super.method(), overriding, polymorphism and inherited fields', () => {
        const ts = `
            class Animal {
                name: string;
                constructor(name: string) { this.name = name; }
                speak(): string { return this.name + " makes a sound"; }
            }
            class Dog extends Animal {
                tricks: number = 3;
                constructor(name: string) { super(name + "!"); }
                speak(): string { return super.speak() + " (woof)"; }
                label(): string { return this.name + "/" + this.tricks; }
            }
            function describe(a: Animal): string { return a.speak(); }
            function run(): string { return describe(new Dog("rex")); }
            function plain(): string { return describe(new Animal("cat")); }
            function label(): string { return new Dog("d").label(); }
        `;
        const java = `
            System.out.println(Main.run());
            System.out.println(Main.plain());
            System.out.println(Main.label());
            Animal a = new Dog("x");
            System.out.println(a.speak() + " " + (a instanceof Dog));
        `;
        expect(run(ts, java)).toEqual([
            'rex! makes a sound (woof)',
            'cat makes a sound',
            'd!/3',
            'x! makes a sound (woof) true',
        ]);
    });
});

describe.skipIf(!findAndroidSdk())('calling real Java classes (types read from android.jar)', () => {
    it('static and instance calls, int and interface parameters, overload choice', () => {
        const ts = `
            import { Integer, StringBuilder, CharSequence } from 'java.lang';
            function hex(n: number): string { return Integer.toHexString(n); }
            function parse(s: string): number { return Integer.parseInt(s) + 1; }
            function build(): string {
                const sb = new StringBuilder();
                sb.append("a").append(1).append("b").append(true);
                return sb.toString();
            }
            function len(c: CharSequence): number { return c.length(); }
            function smallest(a: number, b: number): number { return Math.min(a, b); }
        `;
        const java = `
            System.out.println(Main.hex(255));
            System.out.println(Main.parse("41"));
            System.out.println(Main.build());
            System.out.println(Main.len("abcd"));
            System.out.println(Main.smallest(3, 2));
        `;
        expect(run(ts, java)).toEqual(['ff', '42.0', 'a1.0btrue', '4.0', '2.0']);
    });
});
