/**
 * Alt cekmece (bottom sheet): dock'a bir tutamac ekler. Dar/dokunmatik ekranda CSS dock'u ince bir cubuga indirir
 * (yalniz birincil ogeler gorunur); tutamaga dokununca tum icerik acilir. Yukseklik `--dock-h` olarak yayinlanir.
 */
export function initSheet(dock: HTMLElement): { destroy(): void; close(): void } {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'sheet-handle';
  handle.setAttribute('aria-label', 'Araçları aç/kapat');
  handle.setAttribute('aria-expanded', 'false');
  // Icerik kaydirilabilir bir sarmalayicida: tutamac yerinde kalir. Masaustunde sarmalayici `display: contents` (etkisiz).
  const scroll = document.createElement('div');
  scroll.className = 'dock-scroll';
  while (dock.firstChild) scroll.appendChild(dock.firstChild);
  dock.append(handle, scroll);
  const set = (open: boolean): void => {
    dock.classList.toggle('open', open);
    handle.setAttribute('aria-expanded', String(open));
  };
  handle.addEventListener('click', () => set(!dock.classList.contains('open')));
  // Yukari/asagi surukleme: kucuk bir hareket yeterli.
  let y0 = 0;
  let drag = false;
  handle.addEventListener('pointerdown', (e) => {
    drag = true;
    y0 = e.clientY;
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
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
