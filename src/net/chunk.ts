import type { Msg } from './protocol';

/**
 * Buyuk mesajlari WebSocket tek-mesaj sinirinin (Cloudflare ~1 MB) altinda parcalara boler.
 * Parca `{c:{id,i,n,d}}` bicimindedir ve sunucu tarafindan oldugu gibi iletilir; alici birlestirir.
 */
export interface ChunkPart {
  id: number;
  i: number;
  n: number;
  d: string;
}

/** Bir parcanin en cok karakter sayisi (JSON'da kacis payi ve UTF-8 icin 1 MB'in epey altinda). */
export const CHUNK_CHARS = 200_000;
/** Birlestirilen tek mesajin ust siniri (bellek koruma). */
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;
const MAX_PENDING = 8;

/** Mesaji tek parca (kendisi) ya da sirali parcalar olarak dondurur. */
export function splitMsg(msg: Msg, id: number, size = CHUNK_CHARS): Msg[] {
  const s = JSON.stringify(msg);
  if (s.length <= size) return [msg];
  const n = Math.ceil(s.length / size);
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) out.push({ c: { id, i, n, d: s.slice(i * size, (i + 1) * size) } } as unknown as Msg);
  return out;
}

/** Gonderen basina parcalari toplar; tamamlaninca ilk mesaji dondurur. */
export class Reassembler {
  private readonly pending = new Map<number, { n: number; got: number; parts: string[]; chars: number }>();

  /** Parca degilse mesaj aynen doner; parcaysa eksikken null, tamamlaninca birlesmis mesaj. */
  push(m: Msg): Msg | null {
    const c = (m as unknown as { c?: ChunkPart }).c;
    if (!c || typeof c !== 'object') return m;
    if (!Number.isInteger(c.id) || !Number.isInteger(c.i) || !Number.isInteger(c.n) || c.n < 1 || c.i < 0 || c.i >= c.n || typeof c.d !== 'string') return null;
    let p = this.pending.get(c.id);
    if (!p) {
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as number);
      p = { n: c.n, got: 0, parts: new Array<string>(c.n), chars: 0 };
      this.pending.set(c.id, p);
    }
    if (p.n !== c.n || p.parts[c.i] !== undefined) return null;
    p.parts[c.i] = c.d;
    p.got++;
    p.chars += c.d.length;
    if (p.chars > MAX_TOTAL_CHARS) {
      this.pending.delete(c.id);
      return null;
    }
    if (p.got < p.n) return null;
    this.pending.delete(c.id);
    try {
      return JSON.parse(p.parts.join('')) as Msg;
    } catch {
      return null;
    }
  }
}
