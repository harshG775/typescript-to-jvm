import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { compileFileToHir, compileSourceToHir } from '../../src/frontend/compile-file.ts';
import { FrontendError } from '../../src/frontend/errors.ts';
import type { HirFunction, HirProgram, HirStmt } from '../../src/frontend/hir.ts';
import { createDefaultRegistry } from '../../src/frontend/type-registry.ts';

const F64 = { kind: 'f64' };
const STRING = { kind: 'string' };
const BOOLEAN = { kind: 'boolean' };
const OBJECT = { kind: 'object', className: 'java/lang/Object' };

function compile(source: string): HirProgram {
  return compileSourceToHir(source, { registry: createDefaultRegistry(), fileName: 'test.ts' });
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
    const { functions } = compileFileToHir(file, createDefaultRegistry());
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
          resultType: BOOLEAN,
        },
      },
    ]);
  });
});

describe('HIR front end: extra checks', () => {
  it('calls between top-level functions, including forward references', () => {
    const { functions } = compile('function a():number{return b(1);} function b(x:number):number{return x;}');
    expect(stmts(functions[0]!)).toMatchObject([{ k: 'return', expr: { k: 'call', calleeName: 'b', resultType: F64 } }]);
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
