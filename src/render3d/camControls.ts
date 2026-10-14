import { t } from '../i18n';
import type { Camera3D } from './camera3d';

/**
 * Small on-screen rotate / tilt buttons (bottom right, above the language bar). Mouse users can also Alt+drag or use Q/E R/F; on a
 * phone these are the way to tilt. Holding a button keeps turning. Sits under the online screens, so menus and lobbies cover it.
 */
export function mountCamControls(cam: Camera3D): () => void {
  const root = document.createElement('div');
  root.className = 'cam3d';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('sys.cam3d.aria'));
  const defs: Array<[string, string, string, number, number]> = [
    ['↺', 'sys.cam3d.left', 'l', 1, 0],
    ['↻', 'sys.cam3d.right', 'r', -1, 0],
    ['⤒', 'sys.cam3d.up', 'u', 0, 1],
    ['⤓', 'sys.cam3d.down', 'd', 0, -1],
  ];
  root.innerHTML = defs.map(([glyph, key, id]) => `<button type="button" data-a="${id}" aria-label="${t(key)}" title="${t(key)}">${glyph}</button>`).join('');
  document.body.appendChild(root);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const step = (yaw: number, tilt: number): void => cam.orbit(yaw * 0.12, tilt * 0.07);
  root.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => {
    const [, , , yaw, tilt] = defs[i];
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      step(yaw, tilt);
      stop();
      timer = setInterval(() => step(yaw, tilt), 60);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
  });
  return () => {
    stop();
    root.remove();
  };
}
