import type { Msg } from './protocol';

/**
 * Splits large messages into pieces below the WebSocket single-message limit (Cloudflare ~1 MB).
 * A piece has the form `{c:{id,i,n,d}}`, is relayed by the server unchanged, and the receiver reassembles it.
 */
export interface ChunkPart {
  id: number;
  i: number;
  n: number;
  d: string;
}

/** Most characters in one piece (well below 1 MB, leaving room for JSON escaping and UTF-8). */
export const CHUNK_CHARS = 200_000;
/** Upper limit for one reassembled message (memory protection). */
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;
const MAX_PENDING = 8;

/** Returns the message as a single piece (itself) or as ordered pieces. */
export function splitMsg(msg: Msg, id: number, size = CHUNK_CHARS): Msg[] {
  const s = JSON.stringify(msg);
  if (s.length <= size) return [msg];
  const n = Math.ceil(s.length / size);
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) out.push({ c: { id, i, n, d: s.slice(i * size, (i + 1) * size) } } as unknown as Msg);
  return out;
}

/** Collects pieces per sender; returns the original message once complete. */
export class Reassembler {
  private readonly pending = new Map<number, { n: number; got: number; parts: string[]; chars: number }>();

  /** A non-piece message is returned unchanged; for a piece, null while incomplete and the reassembled message once complete. */
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
