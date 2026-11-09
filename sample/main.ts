function add(a: number, b: number): number {
  return a + b;
}

function abs2(x: number): number {
  if (x < 0) return -x;
  return x;
}

function sumTo(n: number): number {
  let s = 0;
  let i = 1;
  while (i <= n) {
    s = s + i;
    i = i + 1;
  }
  return s;
}
