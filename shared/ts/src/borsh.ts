import type { Address, ReadonlyUint8Array } from '@solana/kit';
import { addressBytes, bytesToAddress } from './util.ts';

const U64_MAX = (1n << 64n) - 1n;

/** Minimal Borsh writer for fixed-size little-endian layouts. */
export class BorshWriter {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private off = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`not a u8: ${n}`);
    this.view.setUint8(this.off, n);
    this.off += 1;
    return this;
  }

  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }

  u32(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`not a u32: ${n}`);
    this.view.setUint32(this.off, n, true);
    this.off += 4;
    return this;
  }

  u64(n: bigint | number): this {
    const v = BigInt(n);
    if (v < 0n || v > U64_MAX) throw new Error(`not a u64: ${n}`);
    this.view.setBigUint64(this.off, v, true);
    this.off += 8;
    return this;
  }

  bytes(b: ReadonlyUint8Array, len: number): this {
    if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
    this.buf.set(b, this.off);
    this.off += len;
    return this;
  }

  pubkey(a: Address): this {
    return this.bytes(addressBytes(a), 32);
  }

  finish(): Uint8Array {
    if (this.off !== this.buf.length) throw new Error(`wrote ${this.off} of ${this.buf.length} bytes`);
    return this.buf;
  }
}

export class BorshReader {
  private readonly data: ReadonlyUint8Array;
  private readonly view: DataView;
  off = 0;

  constructor(data: ReadonlyUint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.off++);
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new Error(`invalid bool byte ${v} at ${this.off - 1}`);
    return v === 1;
  }

  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }

  bytes(len: number): Uint8Array {
    if (this.off + len > this.data.length) throw new Error('read past end of data');
    const out = new Uint8Array(this.data.slice(this.off, this.off + len));
    this.off += len;
    return out;
  }

  pubkey(): Address {
    return bytesToAddress(this.bytes(32));
  }
}
