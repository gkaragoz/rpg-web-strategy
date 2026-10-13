import { t } from '../i18n';

/**
 * Bottom sheet: adds a handle to the dock. On narrow/touch screens CSS shrinks the dock to a thin bar
 * (only primary items are visible); tapping the handle opens all the content. The height is published as `--dock-h`.
 */
export function initSheet(dock: HTMLElement): { destroy(): void; close(): void } {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'sheet-handle';
  handle.setAttribute('aria-label', t('studio.sheet.toggle'));
  handle.setAttribute('aria-expanded', 'false');
  // The content lives in a scrollable wrapper so the handle stays in place. On desktop the wrapper is `display: contents` (no effect).
  const scroll = document.createElement('div');
  scroll.className = 'dock-scroll';
  while (dock.firstChild) scroll.appendChild(dock.firstChild);
  dock.append(handle, scroll);
  const set = (open: boolean): void => {
    dock.classList.toggle('open', open);
    handle.setAttribute('aria-expanded', String(open));
  };
  handle.addEventListener('click', () => set(!dock.classList.contains('open')));
  // Drag up/down: a small movement is enough.
  let y0 = 0;
  let drag = false;
  let pid = -1;
  handle.addEventListener('pointerdown', (e) => {
    drag = true;
    pid = e.pointerId;
    y0 = e.clientY;
  });
  // The browser may cancel the touch (iOS does): never leave the drag armed, or the next paint stroke would toggle the sheet.
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId === pid) drag = false;
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== pid) return;
    drag = false;
    const dy = e.clientY - y0;
    if (Math.abs(dy) > 24) {
      set(dy < 0);
      suppress = true;
      setTimeout(() => (suppress = false), 0);
    }
  });
  let suppress = false;
  handle.addEventListener(
    'click',
    (e) => {
      if (suppress) e.stopImmediatePropagation();
    },
    true,
  );
  const publish = (): void => document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
  const ro = new ResizeObserver(publish);
  ro.observe(dock);
  publish();
  return {
    close: () => set(false),
    destroy() {
      ro.disconnect();
      document.documentElement.style.removeProperty('--dock-h');
      handle.remove();
      while (scroll.firstChild) dock.appendChild(scroll.firstChild);
      scroll.remove();
    },
  };
}
