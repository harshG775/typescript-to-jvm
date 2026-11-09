/** Operand-stack / local-variable slots a value of this field descriptor occupies. */
export function slotSize(desc: string): number {
  if (desc === 'J' || desc === 'D') return 2;
  if (desc === 'V') return 0;
  return 1;
}

export interface MethodDescriptor {
  params: string[];
  returns: string;
  argSlots: number;
  retSlots: number;
}

const PRIMITIVES = 'BCDFIJSZ';

/** Reads one field descriptor starting at `i`; returns the index just past it. */
function skipType(desc: string, i: number): number {
  let j = i;
  while (desc[j] === '[') j++;
  const c = desc[j];
  if (c === undefined) throw new Error(`Truncated descriptor: ${desc}`);
  if (c === 'L') {
    const end = desc.indexOf(';', j);
    if (end < 0) throw new Error(`Unterminated class type in descriptor: ${desc}`);
    return end + 1;
  }
  if (PRIMITIVES.includes(c)) return j + 1;
  throw new Error(`Bad type '${c}' in descriptor: ${desc}`);
}

/** Splits a method descriptor like `(IDLjava/lang/String;)V` into its parts. */
export function parseMethodDescriptor(desc: string): MethodDescriptor {
  if (desc[0] !== '(') throw new Error(`Not a method descriptor: ${desc}`);
  const params: string[] = [];
  let i = 1;
  let argSlots = 0;
  while (desc[i] !== ')') {
    if (i >= desc.length) throw new Error(`Missing ')' in descriptor: ${desc}`);
    const end = skipType(desc, i);
    const p = desc.slice(i, end);
    params.push(p);
    argSlots += slotSize(p);
    i = end;
  }
  const returns = desc.slice(i + 1);
  if (returns !== 'V' && skipType(returns, 0) !== returns.length) {
    throw new Error(`Bad return type in descriptor: ${desc}`);
  }
  return { params, returns, argSlots, retSlots: slotSize(returns) };
}
