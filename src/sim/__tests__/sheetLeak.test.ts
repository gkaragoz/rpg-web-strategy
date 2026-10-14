import { afterEach, describe, expect, it } from 'vitest';

/** Tiny DOM stand-in: just enough surface for `initSheet` (the project tests run in Node without a DOM). */
class FakeEl {
  className = '';
  type = '';
  offsetHeight = 40;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly cls = new Set<string>();
  classList = {
    toggle: (c: string, on: boolean) => void (on ? this.cls.add(c) : this.cls.delete(c)),
    contains: (c: string) => this.cls.has(c),
  };
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  setAttribute(): void {}
  addEventListener(): void {}
  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
}

describe('bottom sheet teardown', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = { window: g.window, document: g.document, ResizeObserver: g.ResizeObserver };
  afterEach(() => {
    g.window = prev.window;
    g.document = prev.document;
    g.ResizeObserver = prev.ResizeObserver;
  });

  it('removes its window listeners in destroy() (they would keep the whole dock subtree alive)', async () => {
    const live = new Map<string, Set<unknown>>();
    g.window = {
      addEventListener: (type: string, fn: unknown) => void (live.get(type) ?? live.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type: string, fn: unknown) => void live.get(type)?.delete(fn),
    };
    g.document = { createElement: () => new FakeEl(), documentElement: { style: { setProperty() {}, removeProperty() {} } } };
    g.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
    const { initSheet } = await import('../../app/sheet');
    const dock = new FakeEl();
    dock.appendChild(new FakeEl());
    const count = (): number => [...live.values()].reduce((n, s) => n + s.size, 0);
    for (let i = 0; i < 5; i++) {
      const sheet = initSheet(dock as unknown as HTMLElement);
      expect(count()).toBeGreaterThan(0);
      sheet.destroy();
      expect(count()).toBe(0);
    }
    expect(dock.children.length).toBe(1); // content moved back out of the scroll wrapper
  });
});
