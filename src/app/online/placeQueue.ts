import type { ClientMsg, PlaceItem } from '../../net/protocol';

/** Largest number of entries one `place` / `unplace` message carries (the host accepts at most this many per message). */
export const PLACE_BATCH = 80;
/**
 * Pace of the outbox: one message per tick. The host allows a guest about 40 messages per second (burst 80) and refuses the rest, so
 * the sustained rate stays below that.
 */
export const OUTBOX_MS = 28;

type Op = { kind: 'place'; items: PlaceItem[] } | { kind: 'unplace'; ids: number[] };

/**
 * Outgoing placement edits. Brush strokes produce one tiny edit per stamp; sending each as its own message goes over the host's rate
 * limit when painting fast (the refused units then vanished from the player's own view). The queue merges neighbouring edits of the
 * same kind into batches and keeps the order between placements and removals, so the host sees the same sequence.
 */
export class PlaceQueue {
  private readonly ops: Op[] = [];

  get size(): number {
    return this.ops.length;
  }

  add(items: PlaceItem[]): void {
    for (const it of items) {
      const last = this.ops[this.ops.length - 1];
      if (last && last.kind === 'place' && last.items.length < PLACE_BATCH) last.items.push(it);
      else this.ops.push({ kind: 'place', items: [it] });
    }
  }

  remove(ids: number[]): void {
    for (const id of ids) {
      const last = this.ops[this.ops.length - 1];
      if (last && last.kind === 'unplace' && last.ids.length < PLACE_BATCH) last.ids.push(id);
      else this.ops.push({ kind: 'unplace', ids: [id] });
    }
  }

  /** The next message to send, or null when the queue is empty. */
  next(): ClientMsg | null {
    const op = this.ops.shift();
    if (!op) return null;
    return op.kind === 'place' ? { t: 'place', items: op.items } : { t: 'unplace', ids: op.ids };
  }

  clear(): void {
    this.ops.length = 0;
  }
}
