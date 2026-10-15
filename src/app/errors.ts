import { Texture, type Container } from 'pixi.js';
import { t } from '../i18n';

/** Unexpected error: a short, self-dismissing notice for the user; details go to the console. */
let lastErr = '';
let lastErrAt = 0;
export function showError(msg: string): void {
  // A failure that repeats every frame must not pile up hundreds of notices.
  const now = performance.now();
  if (msg === lastErr && now - lastErrAt < 5000) return;
  lastErr = msg;
  lastErrAt = now;
  const el = document.createElement('div');
  el.className = 'err-toast';
  el.textContent = t('sys.error.unexpected', { msg: msg.slice(0, 160) });
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 6000);
}

/**
 * Replaces textures whose GPU source was destroyed (an atlas freed while something still drew from it) with an empty texture, so the next
 * frame renders instead of throwing "reading 'addressModeU' of null" every frame. Returns how many were replaced.
 */
export function healTextures(node: Container & { particleChildren?: Array<{ texture?: Texture }> }): number {
  let healed = 0;
  const bad = (tx: Texture | undefined): boolean => !!tx && !!tx.source && (tx.destroyed || tx.source.destroyed || !tx.source.style);
  const holder = node as unknown as { texture?: Texture };
  if (bad(holder.texture)) {
    holder.texture = Texture.EMPTY;
    healed++;
  }
  if (node.particleChildren) for (const p of node.particleChildren) if (bad(p.texture)) {
    p.texture = Texture.EMPTY;
    healed++;
  }
  for (const c of node.children ?? []) healed += healTextures(c as Container);
  return healed;
}

export const looksLikeDeadTexture = (msg: string): boolean => /addressMode|reading 'style'|texture.*destroyed/i.test(msg);

/** Global error handlers: log, repair dead textures in place (`heal` returns how many were fixed), otherwise show a short notice. */
export function installErrorHandlers(heal: () => number): void {
  window.addEventListener('error', (e) => {
    console.error(e.error ?? e.message);
    // A render error caused by a destroyed texture is repaired in place; nothing worth a notice for the player.
    if (looksLikeDeadTexture(String(e.message)) && heal() > 0) return;
    showError(e.message || t('sys.error.unknown'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    showError(String((e.reason as Error)?.message ?? e.reason));
  });
}

/** WebGL context loss: offer a reload; if the browser restores the context by itself the dialog goes away (dead textures are replaced first). */
export function watchGlContext(canvas: HTMLCanvasElement, heal: () => number): void {
  canvas.addEventListener('webglcontextlost', (e: Event) => {
    e.preventDefault();
    if (document.querySelector('.fatal')) return;
    const el = document.createElement('div');
    el.className = 'fatal';
    el.innerHTML = `<div>${t('sys.gl.lost')}<br /><button type="button" id="reload-btn">${t('sys.gl.reload')}</button></div>`;
    document.body.appendChild(el);
    el.querySelector('#reload-btn')!.addEventListener('click', () => location.reload());
  });
  canvas.addEventListener('webglcontextrestored', () => {
    heal();
    document.querySelector('.fatal')?.remove();
  });
}
