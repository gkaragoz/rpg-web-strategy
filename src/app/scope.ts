/**
 * Owns event listeners, timers and arbitrary cleanup callbacks of one screen or component and releases them together.
 * Replaces hand-written add/removeEventListener + clearTimeout pairs (a missed removal pinned whole DOM trees before).
 */
export class Scope {
  private readonly cleanups: Array<() => void> = [];
  private done = false;

  get disposed(): boolean {
    return this.done;
  }

  /** Adds a listener that is removed on dispose; returns a function that removes it earlier. */
  on<E extends Event = Event>(target: EventTarget, type: string, fn: (e: E) => void, opts?: boolean | AddEventListenerOptions): () => void {
    if (this.done) return () => undefined;
    const listener = fn as unknown as EventListener;
    target.addEventListener(type, listener, opts);
    return this.add(() => target.removeEventListener(type, listener, opts));
  }

  /** Registers a cleanup callback; returns a function that runs it now (once) and forgets it. */
  add(fn: () => void): () => void {
    if (this.done) {
      fn();
      return () => undefined;
    }
    let ran = false;
    const run = (): void => {
      if (ran) return;
      ran = true;
      const i = this.cleanups.indexOf(run);
      if (i >= 0) this.cleanups.splice(i, 1);
      fn();
    };
    this.cleanups.push(run);
    return run;
  }

  /** setInterval that stops on dispose. */
  interval(fn: () => void, ms: number): () => void {
    const id = setInterval(fn, ms);
    return this.add(() => clearInterval(id));
  }

  /** setTimeout that is cancelled on dispose (and forgotten once it has fired). */
  timeout(fn: () => void, ms: number): () => void {
    let cancel: () => void = () => undefined;
    const id = setTimeout(() => {
      cancel();
      fn();
    }, ms);
    cancel = this.add(() => clearTimeout(id));
    return cancel;
  }

  /** Runs every cleanup, newest first; later registrations run immediately. Safe to call twice. */
  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (const run of [...this.cleanups].reverse()) {
      try {
        run();
      } catch (e) {
        console.error('Scope cleanup failed', e);
      }
    }
    this.cleanups.length = 0;
  }
}
