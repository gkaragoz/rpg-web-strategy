/** Worker ile ana thread arasinda paylasilan SharedArrayBuffer duzeni. */
export const SNAP_SLOTS = 4;

export interface SnapSlot {
  x: Float32Array;
  y: Float32Array;
  hp: Float32Array;
  swing: Float32Array;
  flash: Float32Array;
  deathT: Float32Array;
  facing: Int8Array;
  moving: Uint8Array;
  alive: Uint8Array;
  pSx: Float32Array;
  pSy: Float32Array;
  pTx: Float32Array;
  pTy: Float32Array;
  pT: Float32Array;
  pDur: Float32Array;
  pH: Float32Array;
}

export interface Shared {
  /** [0]=son yayinlanan adim, [1]=birim sayisi, [2]=reset sayaci, [3..3+SLOTS)=slot basina ok sayisi. */
  ctrlI: Int32Array;
  /** Bkz. F_* indeksleri. */
  ctrlF: Float64Array;
  kind: Uint8Array;
  team: Uint8Array;
  maxHp: Float32Array;
  pActive: Uint8Array;
  slots: SnapSlot[];
}

export const I_LATEST = 0;
export const I_COUNT = 1;
export const I_EPOCH = 2;
export const I_PCOUNT = 3;

export const F_PUBLISH = 0;
export const F_PREV_PUBLISH = 1;
export const F_SIM_TIME = 2;
export const F_WINNER = 3;
export const F_ALIVE_BLUE = 4;
export const F_ALIVE_RED = 5;
export const F_STEPS = 6;
export const F_TOTAL_MS = 7;
export const F_MAX_MS = 8;
export const F_LAST_MS = 9;
export const F_PROF = 10; // prep, grid, units, pick, separate, arrows, steps (7 deger)
export const F_DBG = 17; // DBG_KEYS sirasiyla (7 deger)
export const F_LEN = 24;

export const PROF_KEYS = ['prep', 'grid', 'units', 'pick', 'separate', 'arrows', 'steps'] as const;

type Ctor<T> = new (buf: ArrayBufferLike, off: number, len: number) => T;

/** sab == null ise sadece toplam boyutu hesaplar. */
function build(sab: SharedArrayBuffer | null, cap: number, pcap: number): { shared: Shared; size: number } {
  let off = 0;
  const alloc = <T>(C: Ctor<T>, bytes: number, len: number): T => {
    const o = off;
    off += (len * bytes + 7) & ~7;
    return sab ? new C(sab, o, len) : (undefined as unknown as T);
  };
  const f32 = (n: number) => alloc(Float32Array as unknown as Ctor<Float32Array>, 4, n);
  const u8 = (n: number) => alloc(Uint8Array as unknown as Ctor<Uint8Array>, 1, n);
  const i8 = (n: number) => alloc(Int8Array as unknown as Ctor<Int8Array>, 1, n);

  const ctrlI = alloc(Int32Array as unknown as Ctor<Int32Array>, 4, 16);
  const ctrlF = alloc(Float64Array as unknown as Ctor<Float64Array>, 8, F_LEN);
  const kind = u8(cap);
  const team = u8(cap);
  const maxHp = f32(cap);
  const pActive = u8(pcap);
  const slots: SnapSlot[] = [];
  for (let s = 0; s < SNAP_SLOTS; s++) {
    slots.push({
      x: f32(cap),
      y: f32(cap),
      hp: f32(cap),
      swing: f32(cap),
      flash: f32(cap),
      deathT: f32(cap),
      facing: i8(cap),
      moving: u8(cap),
      alive: u8(cap),
      pSx: f32(pcap),
      pSy: f32(pcap),
      pTx: f32(pcap),
      pTy: f32(pcap),
      pT: f32(pcap),
      pDur: f32(pcap),
      pH: f32(pcap),
    });
  }
  return { shared: { ctrlI, ctrlF, kind, team, maxHp, pActive, slots }, size: off };
}

export function allocShared(cap: number, pcap: number): SharedArrayBuffer {
  return new SharedArrayBuffer(build(null, cap, pcap).size);
}

export function bindShared(sab: SharedArrayBuffer, cap: number, pcap: number): Shared {
  return build(sab, cap, pcap).shared;
}
