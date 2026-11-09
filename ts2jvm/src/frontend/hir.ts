import type { ForeignMethod } from './type-registry.ts';

export type ValueType =
    | { kind: 'f64' }
    | { kind: 'boolean' }
    | { kind: 'string' }
    | { kind: 'null' }
    | { kind: 'object'; className: string } // JVM internal name, "java/lang/Object" for any/unknown/union
    | { kind: 'void' };

export interface HirProgram {
    functions: HirFunction[];
}

export interface HirParam {
    name: string;
    type: ValueType;
    slot: number;
}

export interface HirLocal {
    name: string;
    type: ValueType;
    slot: number;
}

export interface HirFunction {
    name: string;
    params: HirParam[];
    returnType: ValueType;
    /**
     * Every local declared inside the function body (including catch variables), in source order.
     * Params are not repeated here, but slots share one numbering space: params first, then locals.
     */
    locals: HirLocal[];
    body: HirStmt;
}

export type HirStmt =
    | { k: 'block'; stmts: HirStmt[] }
    | { k: 'var-decl'; name: string; slot: number; type: ValueType; init: HirExpr | null }
    | { k: 'expr'; expr: HirExpr }
    | { k: 'if'; cond: HirExpr; then: HirStmt; else_: HirStmt | null }
    | { k: 'while'; cond: HirExpr; body: HirStmt }
    | { k: 'return'; expr: HirExpr | null }
    | { k: 'throw'; expr: HirExpr }
    | {
          k: 'try';
          try_: HirStmt;
          catchVar: { name: string; slot: number; type: ValueType } | null;
          catch_: HirStmt | null;
          finally_: HirStmt | null;
      };

export type HirBinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export type HirExpr =
    | { k: 'num'; value: number }
    | { k: 'str'; value: string }
    | { k: 'bool'; value: boolean }
    | { k: 'null' }
    | { k: 'undefined' }
    | { k: 'local'; slot: number; type: ValueType }
    | { k: 'assign'; slot: number; type: ValueType; rhs: HirExpr }
    | { k: 'binary'; op: HirBinaryOp; left: HirExpr; right: HirExpr; resultType: ValueType }
    | { k: 'unary'; op: '-' | '!'; operand: HirExpr; resultType: ValueType }
    /** `foreign` is set for registry calls (Math.abs, Log.d): the resolved overload and its JVM owner. */
    | {
          k: 'call';
          calleeName: string;
          args: HirExpr[];
          resultType: ValueType;
          foreign?: { owner: string; method: ForeignMethod };
      }
    | { k: 'cond'; cond: HirExpr; then: HirExpr; else_: HirExpr; resultType: ValueType };
