import { afterEach, describe, expect, it, vi } from 'vitest';

/** Tiny DOM stand-in for `ChatOverlay` (the project tests run in Node without a DOM). */
class FakeEl {
  className = '';
  innerHTML = '';
  hidden = false;
  style: Record<string, string> = {};
  value = '';
  children: FakeEl[] = [];
  private readonly made = new Map<string, FakeEl>();
  addEventListener(): void {}
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  querySelector(sel: string): FakeEl {
    let e = this.made.get(sel);
    if (!e) this.made.set(sel, (e = new FakeEl()));
    return e;
  }
  remove(): void {}
  focus(): void {}
  blur(): void {}
  getClientRects(): unknown[] {
    return [];
  }
}

describe('in-game chat teardown', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = { window: g.window, document: g.document };
  afterEach(() => {
    g.window = prev.window;
    g.document = prev.document;
    vi.useRealTimers();
  });

  it('removes its keydown and visual-viewport listeners in destroy() (they outlive the overlay and pinned the whole session)', async () => {
    vi.useFakeTimers();
    const live = new Set<unknown>();
    const track = () => ({
      addEventListener: (_type: string, fn: unknown) => void live.add(fn),
      removeEventListener: (_type: string, fn: unknown) => void live.delete(fn),
    });
    const vv = track();
    g.window = { ...track(), visualViewport: { ...vv, offsetTop: 0, height: 600 }, innerHeight: 600 };
    g.document = { createElement: () => new FakeEl(), querySelector: () => null, activeElement: null };
    const { ChatOverlay } = await import('../../app/online/chat');
    const root = new FakeEl();
    const session = { model: { chat: [], state: null }, send() {} };
    const fns = (): number => live.size;
    for (let i = 0; i < 4; i++) {
      const chat = new ChatOverlay(root as unknown as HTMLElement, session as never);
      expect(fns()).toBeGreaterThanOrEqual(2); // keydown + viewport resize
      chat.destroy();
      expect(fns()).toBe(0);
    }
  });
});
