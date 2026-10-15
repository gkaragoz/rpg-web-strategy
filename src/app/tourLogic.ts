/** Pure logic of the first-run tour (no DOM): the steps, where the balloon goes and the "already seen" flag. */

export interface TourStep {
  id: string;
  /** CSS selector of the control to highlight; null = no highlight (balloon centred). */
  target: string | null;
  /** i18n keys (literal strings so the unused-key test sees them); the body may use `{key}` / `{brushKey}` placeholders. */
  title: string;
  body: string;
}

const step = (id: string, target: string | null, title: string, body: string): TourStep => ({ id, target, title, body });

/** The studio tour. Touch devices get the gesture wording of the camera step; the other steps are the same. */
export function studioSteps(touch: boolean): TourStep[] {
  return [
    step('place', '#kinds', 'tour.place.title', 'tour.place.body'),
    step('team', '#chips', 'tour.team.title', 'tour.team.body'),
    step('tool', '#tool', 'tour.tool.title', 'tour.tool.body'),
    step('gallery', '#gallery-btn', 'tour.gallery.title', 'tour.gallery.body'),
    step('start', '#start', 'tour.start.title', 'tour.start.body'),
    touch ? step('cameraTouch', null, 'tour.cameraTouch.title', 'tour.cameraTouch.body') : step('camera', null, 'tour.camera.title', 'tour.camera.body'),
  ];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Which side of the balloon touches the target ('up': the balloon is below the target). */
  arrow: 'up' | 'down' | null;
}

const GAP = 12;
const EDGE = 10;

/**
 * Puts a balloon of `size` next to `target` inside the viewport: below it when there is room, otherwise above it, otherwise
 * centred. When `avoid` (a panel containing the target) is given, the balloon prefers the space above that panel. Without a target (or with one outside the viewport) the balloon is centred. The result always stays on screen.
 */
export function placeBalloon(target: Rect | null, size: { width: number; height: number }, vp: { width: number; height: number }, avoid: Rect | null = null): Placement {
  const clampX = (x: number): number => Math.max(EDGE, Math.min(vp.width - size.width - EDGE, x));
  const centre = (): Placement => ({ left: clampX((vp.width - size.width) / 2), top: Math.max(EDGE, (vp.height - size.height) / 2), arrow: null });
  if (!target || target.width <= 0 || target.height <= 0) return centre();
  if (target.x + target.width <= 0 || target.y + target.height <= 0 || target.x >= vp.width || target.y >= vp.height) return centre();
  const left = clampX(target.x + target.width / 2 - size.width / 2);
  // The target sits inside a panel (the dock) that must stay visible: the balloon goes above the whole panel.
  if (avoid && target.y >= avoid.y - 1 && target.y + target.height <= avoid.y + avoid.height + 1) {
    const top = avoid.y - GAP - size.height;
    if (top >= EDGE) return { left, top, arrow: 'down' };
  }
  const below = target.y + target.height + GAP;
  if (below + size.height + EDGE <= vp.height) return { left, top: below, arrow: 'up' };
  const above = target.y - GAP - size.height;
  if (above >= EDGE) return { left, top: above, arrow: 'down' };
  return centre();
}

const KEY = 'rpgweb.tour.studio';

export function tourSeen(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, '1');
  } catch {
    /* storage unavailable: the tour may show again next time */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
