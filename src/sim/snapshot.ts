/** Sim state snapshot made of typed arrays plus JSON-compatible extra state (structured-clone friendly and packable for the network). */
export interface BattleSnapshot {
  v: 1;
  scalars: Record<string, number>;
  units: Record<string, ArrayBufferView>;
  projectiles: Record<string, ArrayBufferView>;
  extra: {
    zones: unknown[];
    links: Array<[number, number[]]>;
    pools: Array<[number, number[]]>;
    paths: Array<[number, { pts: number[]; k: number; gx: number; gy: number; t: number }]>;
  };
}

export type Typed = Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array | Int8Array | Int16Array;

export function isTyped(v: unknown): v is Typed {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** Copies the first n elements of the object's typed-array fields. */
export function copyTyped(obj: object, n: number): Record<string, ArrayBufferView> {
  const out: Record<string, ArrayBufferView> = {};
  for (const [k, v] of Object.entries(obj)) if (isTyped(v)) out[k] = (v as Typed).slice(0, n);
  return out;
}

/** Inverse of copyTyped: writes the snapshot arrays back into the object's arrays. */
export function pasteTyped(obj: object, snap: Record<string, ArrayBufferView>): void {
  const o = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(snap)) {
    const dst = o[k];
    if (isTyped(dst)) (dst as Typed).set(v as unknown as Typed);
  }
}

/** FNV-1a (32-bit) over the bytes of typed arrays. */
export function fnv(h: number, arr: ArrayBufferView, n: number, bytesPer: number): number {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, Math.min(arr.byteLength, n * bytesPer));
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Packs the snapshot into a single Uint8Array (JSON header + raw buffer) and unpacks it again. */
export function packSnapshot(s: BattleSnapshot): Uint8Array {
  const meta: { name: string; section: 'units' | 'projectiles'; type: string; len: number }[] = [];
  const bufs: Uint8Array[] = [];
  for (const section of ['units', 'projectiles'] as const) {
    for (const [name, v] of Object.entries(s[section])) {
      meta.push({ name, section, type: (v as object).constructor.name, len: (v as Typed).length });
      bufs.push(new Uint8Array((v as Typed).buffer, (v as Typed).byteOffset, (v as Typed).byteLength));
    }
  }
  const head = new TextEncoder().encode(JSON.stringify({ v: s.v, scalars: s.scalars, extra: s.extra, meta }));
  let total = 4 + head.length;
  for (const b of bufs) total += b.length;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let off = 4 + head.length;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

const CTORS: Record<string, { new (buf: ArrayBuffer, off: number, len: number): Typed }> = {
  Float32Array,
  Int32Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Int8Array,
  Int16Array,
};

export function unpackSnapshot(data: Uint8Array): BattleSnapshot {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + hl)));
  const snap: BattleSnapshot = { v: head.v, scalars: head.scalars, extra: head.extra, units: {}, projectiles: {} };
  let off = 4 + hl;
  for (const m of head.meta as { name: string; section: 'units' | 'projectiles'; type: string; len: number }[]) {
    const C = CTORS[m.type];
    const bytes = m.len * C.prototype.constructor.BYTES_PER_ELEMENT;
    // Copy for alignment (the offset of data may not be a multiple of 4).
    const copy = data.slice(off, off + bytes).buffer;
    snap[m.section][m.name] = new C(copy, 0, m.len);
    off += bytes;
  }
  return snap;
}
