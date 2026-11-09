/**
 * LIR: a typed tree in JVM terms. Every decision that depends on the JVM is already made here
 * (descriptors, boxing, string concat, comparison shape, throwable wrapping), so codegen is a
 * mechanical walk. Control flow is still structured (no labels yet).
 *
 * Types are JVM field descriptors: 'D', 'Z', 'V', 'Ljava/lang/String;', ...
 * Slots are JVM local indices; all functions are static, so slot 0 is the first parameter.
 */

export type Desc = string;

export const D_DOUBLE = 'D' as const;
export const D_BOOLEAN = 'Z' as const;
export const D_VOID: Desc = 'V';
export const D_STRING: Desc = 'Ljava/lang/String;';
export const D_OBJECT: Desc = 'Ljava/lang/Object;';
export const D_RUNTIME_EXCEPTION: Desc = 'Ljava/lang/RuntimeException;';

export interface LirProgram {
  /** JVM internal name of the class that holds every function as a static method. */
  className: string;
  functions: LirFunction[];
}

export interface LirVar {
  name: string;
  desc: Desc;
  slot: number;
}

export interface LirFunction {
  name: string;
  descriptor: string;
  params: LirVar[];
  /** Locals declared in the body, in source order. Slots continue after the params. */
  locals: LirVar[];
  body: LirStmt;
}

export type DoubleOp = 'add' | 'sub' | 'mul' | 'div' | 'rem';
export type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type LirStmt =
  | { k: 'block'; stmts: LirStmt[] }
  | { k: 'store'; slot: number; desc: Desc; value: LirExpr }
  | { k: 'expr'; expr: LirExpr } // value (if any) is popped
  | { k: 'if'; cond: LirExpr; then: LirStmt; else_: LirStmt | null }
  | { k: 'while'; cond: LirExpr; body: LirStmt }
  | { k: 'return'; value: LirExpr | null }
  | { k: 'throw'; expr: LirExpr } // expr is a Throwable
  | {
      k: 'try';
      body: LirStmt;
      /** Catches java/lang/Throwable. `slot` is null when the exception is unused (it is popped). */
      catch_: { slot: number | null; body: LirStmt } | null;
      /** Runs on every exit: codegen inlines it on normal exit, `return` and the catch-all handler. */
      finally_: LirStmt | null;
    };

/** Every node carries `desc`, the descriptor of the value it leaves on the stack ('V' for nothing). */
export type LirExpr =
  | { k: 'dconst'; value: number; desc: 'D' }
  | { k: 'bconst'; value: boolean; desc: 'Z' }
  | { k: 'sconst'; value: string; desc: Desc }
  | { k: 'null'; desc: Desc }
  | { k: 'load'; slot: number; desc: Desc }
  /** Assignment used as a value: leaves the stored value on the stack. */
  | { k: 'store'; slot: number; desc: Desc; value: LirExpr }
  | { k: 'dbin'; op: DoubleOp; left: LirExpr; right: LirExpr; desc: 'D' }
  | { k: 'dneg'; operand: LirExpr; desc: 'D' }
  /** Double comparison; codegen picks dcmpl/dcmpg so NaN makes every comparison false. */
  | { k: 'dcmp'; op: CompareOp; left: LirExpr; right: LirExpr; desc: 'Z' }
  /** String value equality (`String.equals`), negated for `!=`. */
  | { k: 'scmp'; negate: boolean; left: LirExpr; right: LirExpr; desc: 'Z' }
  | { k: 'not'; operand: LirExpr; desc: 'Z' }
  | { k: 'and' | 'or'; left: LirExpr; right: LirExpr; desc: 'Z' } // short-circuit
  | { k: 'cond'; cond: LirExpr; then: LirExpr; else_: LirExpr; desc: Desc }
  /** StringBuilder chain. Parts may be D, Z, String or Object; codegen picks the append overload. */
  | { k: 'concat'; parts: LirExpr[]; desc: Desc }
  /** Static call. `desc` is the TS-visible result type, which may differ from `descriptor`'s return (Log.d returns int). */
  | { k: 'call'; owner: string; name: string; descriptor: string; args: LirExpr[]; desc: Desc }
  /** Double -> java/lang/Double or boolean -> java/lang/Boolean, typed as Object. */
  | { k: 'box'; operand: LirExpr; desc: Desc }
  | { k: 'checkcast'; cls: string; operand: LirExpr; desc: Desc }
  /** `new RuntimeException(message)`. */
  | { k: 'new-exception'; message: LirExpr; desc: Desc };
