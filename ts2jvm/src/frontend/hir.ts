import type { ForeignMethod } from './type-registry.ts';

export type ValueType =
    | { kind: 'f64' }
    | { kind: 'boolean' }
    | { kind: 'string' }
    | { kind: 'null' }
    | { kind: 'object'; className: string } // JVM internal name, "java/lang/Object" for any/unknown/union
    | { kind: 'void' };

/** JVM field descriptor for a value type (`null` has no type of its own and is an Object). */
export function descriptorOf(t: ValueType): string {
    switch (t.kind) {
        case 'f64':
            return 'D';
        case 'boolean':
            return 'Z';
        case 'string':
            return 'Ljava/lang/String;';
        case 'null':
            return 'Ljava/lang/Object;';
        case 'void':
            return 'V';
        case 'object':
            return `L${t.className};`;
    }
}

export interface HirProgram {
    functions: HirFunction[];
    classes: HirClass[];
}

export interface HirField {
    name: string;
    type: ValueType;
}

/**
 * A user class. Methods and the constructor are HirFunctions whose slot 0 is `this` (params start at 1).
 * The constructor's body already starts with the field initializers (but not the super call, see `superCall`);
 * it is synthesized when the source has none.
 */
export interface HirClass {
    /** JVM internal name (the TS name plus the package prefix). */
    name: string;
    /** JVM internal name of the superclass; `java/lang/Object` when there is no `extends`. */
    superName: string;
    /** The super constructor call that runs before the field initializers. */
    superCall: { descriptor: string; args: HirExpr[] };
    fields: HirField[];
    ctor: HirFunction;
    methods: HirFunction[];
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
    /** `foreign` is set for static calls into existing classes (Math.abs, Log.d): the chosen overload and its owner. */
    | {
          k: 'call';
          calleeName: string;
          args: HirExpr[];
          resultType: ValueType;
          foreign?: { owner: string; method: ForeignMethod };
      }
    | { k: 'cond'; cond: HirExpr; then: HirExpr; else_: HirExpr; resultType: ValueType }
    | { k: 'this'; type: ValueType }
    /** `descriptor` is the chosen constructor's JVM signature. */
    | { k: 'new'; className: string; descriptor: string; args: HirExpr[]; resultType: ValueType }
    | { k: 'field'; object: HirExpr; owner: string; name: string; type: ValueType }
    | { k: 'set-field'; object: HirExpr; owner: string; name: string; type: ValueType; rhs: HirExpr }
    /**
     * Instance method call. `owner` is the receiver's static class; `descriptor` the chosen overload's JVM signature.
     * `special` is a `super.m()` call; `iface` means the receiver's class is an interface.
     */
    | {
          k: 'call-method';
          object: HirExpr;
          owner: string;
          name: string;
          descriptor: string;
          args: HirExpr[];
          resultType: ValueType;
          special?: true;
          iface?: true;
      };
