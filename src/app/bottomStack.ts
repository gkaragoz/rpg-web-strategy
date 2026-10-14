/**
 * Keeps the fixed bottom-right widgets (language picker, online connection badge) clear of the bottom bars.
 * On phones the studio dock / battle HUD / online dock are full-width bars; on desktop they float in the middle.
 * A light poll measures the bars that cover the bottom-right area and publishes CSS variables on <html>:
 *   --bar-h     height from the viewport bottom to the top of the covering bar (0 when none)
 *   --lp-w/--lp-h  size of the whole bottom-right picker bar (version, 2D|3D, full screen, language)
 *   --lp-lift   extra bottom offset for the badge (picker height) when a bar forces both to stack vertically
 *   --lp-side   extra right offset for the badge (picker width) when both sit side by side on the bottom edge
 *   --hint-b    bottom offset for the battle key hint: above the battle bar and, when stacked, the picker and badge
 *   --cam-lift  bottom offset (above the bars) for the 3D rotate/tilt buttons: clear of the picker and of a stacked badge
 */
const BARS = ['.dock', '.hud-bottom'];

export function startBottomStack(): () => void {
  const root = document.documentElement;
  const set = (k: string, v: number): void => root.style.setProperty(k, `${Math.round(v)}px`);
  let last = '';
  const measure = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const lp = document.querySelector<HTMLElement>('.lang-picker');
    const lw = lp?.offsetWidth ?? 0;
    const lh = lp?.offsetHeight ?? 0;
    const badge = document.querySelector<HTMLElement>('.on-badge');
    const bh = badge && badge.getClientRects().length > 0 ? badge.offsetHeight : 0;
    const bw = bh > 0 ? (badge?.offsetWidth ?? 0) : 0;
    // How far from the right edge the picker (and the badge beside it) reach when they share the bottom edge.
    const reach = lw + 18 + (bw > 0 ? bw + 8 : 0);
    let bar = 0;
    for (const sel of BARS) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (el.getClientRects().length === 0) continue;
        const r = el.getBoundingClientRect();
        // Only bars that reach the bottom-right area matter (a floating desktop bar centered on a wide screen stays clear of it).
        if (r.right > w - reach && r.bottom > h - 4 - lh) bar = Math.max(bar, h - r.top);
      }
    }
    // The battle bar (floating on desktop, full width on phones): the key hint sits just above it.
    const hud = document.querySelector<HTMLElement>('.hud-bottom');
    const hb = hud && hud.getClientRects().length > 0 ? Math.max(0, h - hud.getBoundingClientRect().top) : 0;
    const key = `${bar}|${lw}|${lh}|${bh}|${bw}|${hb}`;
    if (key === last) return;
    last = key;
    set('--bar-h', bar);
    set('--lp-w', lw);
    set('--lp-h', lh);
    set('--lp-lift', bar > 0 ? lh + 6 : 0);
    set('--lp-side', bar > 0 ? 0 : lw + 8);
    set('--cam-lift', lh + 14 + (bar > 0 && bh > 0 ? bh + 6 : 0));
    set('--hint-b', (hb > 0 ? hb : 66) + 6 + (bar > 0 ? lh + 14 + (bh > 0 ? bh + 6 : 0) - 8 : 0));
  };
  measure();
  const timer = setInterval(measure, 300);
  window.addEventListener('resize', measure);
  return () => {
    clearInterval(timer);
    window.removeEventListener('resize', measure);
  };
}
