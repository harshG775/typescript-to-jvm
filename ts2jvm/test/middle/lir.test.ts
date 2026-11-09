import { describe, expect, it } from 'vite-plus/test';
import { compileSourceToHir } from '../../src/frontend/compile-file.ts';
import { createDefaultRegistry } from '../../src/frontend/type-registry.ts';
import type { LirFunction, LirProgram, LirStmt } from '../../src/middle/lir.ts';
import { lowerHirToLir } from '../../src/middle/lower-hir-to-lir.ts';

const OBJECT = 'Ljava/lang/Object;';
const STRING = 'Ljava/lang/String;';

function lower(source: string): LirProgram {
    const hir = compileSourceToHir(source, { registry: createDefaultRegistry(), fileName: 'test.ts' });
    return lowerHirToLir(hir, { className: 'app/Main' });
}

function only(source: string): LirFunction {
    const { functions } = lower(source);
    expect(functions).toHaveLength(1);
    return functions[0]!;
}

function stmts(fn: LirFunction): LirStmt[] {
    if (fn.body.k !== 'block') throw new Error('body is not a block');
    return fn.body.stmts;
}

describe('HIR -> LIR', () => {
    it('computes descriptors and lowers arithmetic', () => {
        const fn = only('function add(a:number,b:number):number{return a+b;}');
        expect(fn.descriptor).toBe('(DD)D');
        expect(fn.params).toEqual([
            { name: 'a', desc: 'D', slot: 0 },
            { name: 'b', desc: 'D', slot: 2 },
        ]);
        expect(stmts(fn)).toEqual([
            {
                k: 'return',
                value: {
                    k: 'dbin',
                    op: 'add',
                    left: { k: 'load', slot: 0, desc: 'D' },
                    right: { k: 'load', slot: 2, desc: 'D' },
                    desc: 'D',
                },
            },
        ]);
    });

    it('maps string, boolean, void and Object in descriptors', () => {
        expect(only('function f(s:string,b:boolean,x:any):void{}').descriptor).toBe(`(${STRING}Z${OBJECT})V`);
    });

    it('flattens string concatenation into one chain', () => {
        const fn = only('function f(s:string,n:number):string{return s+n+"!";}');
        expect(stmts(fn)).toMatchObject([
            {
                k: 'return',
                value: {
                    k: 'concat',
                    parts: [
                        { k: 'load', slot: 0, desc: STRING },
                        { k: 'load', slot: 1, desc: 'D' },
                        { k: 'sconst', value: '!' },
                    ],
                },
            },
        ]);
    });

    it('does not treat number + number as concat', () => {
        const fn = only('function f(a:number):string{return 1+2+"x"+a;}');
        const [ret] = stmts(fn);
        expect(ret).toMatchObject({
            value: { k: 'concat', parts: [{ k: 'dbin', op: 'add' }, { k: 'sconst' }, { k: 'load' }] },
        });
    });

    it('boxes primitives when widening to Object', () => {
        const ret = stmts(only('function f(x:number):any{return x;}'))[0];
        expect(ret).toMatchObject({
            k: 'return',
            value: { k: 'box', operand: { k: 'load', desc: 'D' }, desc: OBJECT },
        });

        const decl = stmts(only('function f():void{ let x:any = true; }'))[0];
        expect(decl).toMatchObject({ k: 'store', desc: OBJECT, value: { k: 'box', operand: { k: 'bconst' } } });
    });

    it('does not box strings widened to Object', () => {
        const ret = stmts(only('function f(s:string):any{return s;}'))[0];
        expect(ret).toMatchObject({ k: 'return', value: { k: 'load', desc: STRING } });
    });

    it('boxes call arguments and conditional branches', () => {
        const { functions } = lower(
            'function g(x:any):void{} function f(c:boolean):void{ g(1); const v = c ? 1 : "s"; }',
        );
        const body = stmts(functions[1]!);
        expect(body[0]).toMatchObject({
            k: 'expr',
            expr: { k: 'call', owner: 'app/Main', name: 'g', descriptor: `(${OBJECT})V`, args: [{ k: 'box' }] },
        });
        expect(body[1]).toMatchObject({
            k: 'store',
            value: { k: 'cond', desc: OBJECT, then: { k: 'box' }, else_: { k: 'sconst' } },
        });
    });

    it('resolves foreign calls with owner and descriptor', () => {
        const fn = only('function f(x:number):number{return Math.max(x, 1);}');
        expect(stmts(fn)).toMatchObject([
            { k: 'return', value: { k: 'call', owner: 'java/lang/Math', name: 'max', descriptor: '(DD)D', desc: 'D' } },
        ]);
    });

    it('keeps the real JVM descriptor for Log (int) while exposing boolean', () => {
        const fn = only('function f():void{ Log.d("t", "m"); }');
        expect(stmts(fn)).toMatchObject([
            {
                k: 'expr',
                expr: {
                    k: 'call',
                    owner: 'android/util/Log',
                    name: 'd',
                    descriptor: `(${STRING}${STRING})I`,
                    desc: 'Z',
                },
            },
        ]);
    });

    it('supports forward references between functions', () => {
        const { functions } = lower('function a():number{return b(1);} function b(x:number):number{return x;}');
        expect(stmts(functions[0]!)).toMatchObject([
            { k: 'return', value: { k: 'call', owner: 'app/Main', name: 'b', descriptor: '(D)D' } },
        ]);
    });

    it('lowers comparisons, string equality and short-circuit operators', () => {
        const fn = only('function f(a:number,s:string,t:string):boolean{ return (a<1 && s==t) || s!==t; }');
        expect(stmts(fn)).toMatchObject([
            {
                k: 'return',
                value: {
                    k: 'or',
                    left: { k: 'and', left: { k: 'dcmp', op: '<' }, right: { k: 'scmp', negate: false } },
                    right: { k: 'scmp', negate: true },
                },
            },
        ]);
    });

    it('turns assignment statements into stores but keeps assignment values', () => {
        const fn = only('function f():number{ let x = 0; let y = 0; x = 1; y = x = 2; return y; }');
        const body = stmts(fn);
        expect(body[2]).toMatchObject({ k: 'store', slot: 0, value: { k: 'dconst', value: 1 } });
        expect(body[3]).toMatchObject({ k: 'store', slot: 2, value: { k: 'store', slot: 0, desc: 'D' } });
    });

    it('default-initializes declarations without an initializer', () => {
        const fn = only('function f():void{ let a:number; let b:boolean; let s:string; }');
        expect(stmts(fn)).toMatchObject([
            { k: 'store', slot: 0, value: { k: 'dconst', value: 0 } },
            { k: 'store', slot: 2, value: { k: 'bconst', value: false } },
            { k: 'store', slot: 3, value: { k: 'null' } },
        ]);
    });

    it('wraps thrown strings in an exception and casts rethrown errors', () => {
        expect(stmts(only('function f():void{ throw "boom"; }'))).toMatchObject([
            { k: 'throw', expr: { k: 'new-exception', message: { k: 'sconst', value: 'boom' } } },
        ]);
        const tryStmt = stmts(only('function f():void{ try { } catch (e) { throw e; } }'))[0];
        expect(tryStmt).toMatchObject({
            k: 'try',
            catch_: {
                slot: 0,
                body: { k: 'block', stmts: [{ k: 'throw', expr: { k: 'checkcast', cls: 'java/lang/Throwable' } }] },
            },
        });
    });

    it('lowers try/catch/finally, with an unused catch variable as a null slot', () => {
        const fn = only('function f():void{ try { } catch { } finally { } }');
        expect(stmts(fn)).toMatchObject([{ k: 'try', catch_: { slot: null }, finally_: { k: 'block' } }]);
    });

    it('lowers if/while and void returns', () => {
        const fn = only('function f(n:number):void{ while (n > 0) { n = n - 1; } if (n == 0) return; }');
        expect(stmts(fn)).toMatchObject([
            { k: 'while', cond: { k: 'dcmp', op: '>' }, body: { k: 'block', stmts: [{ k: 'store', slot: 0 }] } },
            { k: 'if', cond: { k: 'dcmp', op: '==' }, then: { k: 'return', value: null }, else_: null },
        ]);
    });
});
