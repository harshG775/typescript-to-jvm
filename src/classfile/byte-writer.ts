/** Growable big-endian byte buffer, the primitive every class-file structure is serialized with. */
export class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  get length(): number {
    return this.len;
  }

  private reserve(extra: number): number {
    const at = this.len;
    const need = at + extra;
    if (need > this.buf.length) {
      let size = this.buf.length;
      while (size < need) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.len = need;
    return at;
  }

  u1(v: number): void {
    check(v, 0, 0xff, 'u1');
    const at = this.reserve(1);
    this.view.setUint8(at, v);
  }

  i1(v: number): void {
    check(v, -0x80, 0x7f, 'i1');
    const at = this.reserve(1);
    this.view.setInt8(at, v);
  }

  u2(v: number): void {
    check(v, 0, 0xffff, 'u2');
    const at = this.reserve(2);
    this.view.setUint16(at, v);
  }

  i2(v: number): void {
    check(v, -0x8000, 0x7fff, 'i2');
    const at = this.reserve(2);
    this.view.setInt16(at, v);
  }

  u4(v: number): void {
    check(v, 0, 0xffff_ffff, 'u4');
    const at = this.reserve(4);
    this.view.setUint32(at, v);
  }

  i4(v: number): void {
    check(v, -0x8000_0000, 0x7fff_ffff, 'i4');
    const at = this.reserve(4);
    this.view.setInt32(at, v);
  }

  i8(v: bigint): void {
    if (BigInt.asIntN(64, v) !== v) throw new RangeError(`${v} does not fit in a 64-bit long`);
    const at = this.reserve(8);
    this.view.setBigInt64(at, v);
  }

  f4(v: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, v);
  }

  f8(v: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, v);
  }

  bytes(data: Uint8Array): void {
    const at = this.reserve(data.length);
    this.buf.set(data, at);
  }

  patchI2(at: number, v: number): void {
    check(v, -0x8000, 0x7fff, 'i2');
    this.view.setInt16(at, v);
  }

  patchI4(at: number, v: number): void {
    check(v, -0x8000_0000, 0x7fff_ffff, 'i4');
    this.view.setInt32(at, v);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function check(v: number, min: number, max: number, type: string): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${v} does not fit in ${type}`);
  }
}
