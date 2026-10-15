// Mobile-viewport e2e tests (phone portrait / landscape, touch emulation, English and Turkish) for the game-mode screens.
// Imported by e2e.mjs. CDP mouse clicks never settle on a touch-emulated page: every click here goes through the DOM (`.click()`) or CDP touch events.
import { sleep } from './lib/browser.mjs';

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const noErrors = (page, label) => {
  const bad = page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  if (bad.length) throw new Error(`${label}: ${bad.length} page error(s): ${bad[0]}`);
};
const MODES = ['classic', 'hill', 'vip', 'ctf', 'siege', 'horde', 'lanes'];
const HUD_MODES = ['hill', 'vip', 'ctf', 'siege', 'horde', 'lanes'];

/** In-page helpers (as source text, installed once per page as `window.__q`): rects, intersections, clipping, tap targets. */
const PROBE = `(() => {
  const vis = (e) => { for (let n = e; n && n !== document.documentElement; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rect = (s) => { const e = typeof s === 'string' ? document.querySelector(s) : s; if (!e || !vis(e)) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const hit = (a, b) => !!a && !!b && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
  /** Text of \`root\` that sticks out of a clipping ancestor (overflow hidden/clip) or runs past the viewport outside a scroller. */
  const clipped = (root) => {
    const bad = [];
    for (const e of [root, ...root.querySelectorAll('*')]) {
      if (!vis(e)) continue;
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const range = document.createRange(); range.selectNodeContents(e); const tr = range.getBoundingClientRect();
      if (getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) bad.push('ellipsis:' + e.textContent.trim().slice(0, 30));
      let scroller = false;
      for (let n = e; n && n !== document.body; n = n.parentElement) {
        const c = getComputedStyle(n), nr = n.getBoundingClientRect();
        if (c.overflowX === 'auto' || c.overflowX === 'scroll') scroller = true;
        const hid = (v) => v === 'hidden' || v === 'clip';
        if ((hid(c.overflowX) && (tr.right > nr.right + 1.5 || tr.left < nr.left - 1.5)) || (hid(c.overflowY) && (tr.bottom > nr.bottom + 1.5 || tr.top < nr.top - 1.5))) { bad.push('clipped:' + e.textContent.trim().slice(0, 30)); break; }
      }
      if (!scroller && (tr.right > innerWidth + 1 || tr.left < -1)) bad.push('outside:' + e.textContent.trim().slice(0, 30));
    }
    return bad;
  };
  const small = (root, min = 39.5) => [...root.querySelectorAll('button, select, input:not([type=hidden]):not([role=switch]):not([type=range])')].filter((e) => vis(e) && (e.getBoundingClientRect().height < min)).map((e) => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height));
  return { vis, rect, hit, clipped, small, overflow: () => document.documentElement.scrollWidth - innerWidth };
})()`;
const install = (page) => page.eval(`window.__q = ${PROBE}; true`);

async function phoneStudio(stack, w, h, lang) {
  const page = await stack.page({ width: w, height: h, mobile: true });
  await page.nav(`${stack.base}?lang=${lang}&view=2d&debug=1&tour=off`);
  await page.eval(`document.querySelector('#m-own').click()`);
  await page.waitFor(`!!document.querySelector('#start')`, 'studio');
  await sleep(800);
  await install(page);
  return page;
}
const openLeftPanel = async (page) => {
  await page.eval(`(() => { if (!document.querySelector('#panel-left').classList.contains('open')) document.querySelector('#tgl-left').click(); })()`);
  await sleep(450);
};

/** Studio settings panel on a phone: all seven mode cards fit and are tappable, rule text and the siege chooser are not clipped, the panel ends above the dock. */
function studioCardsTest(name, w, h, lang) {
  return {
    name,
    async run({ stack }) {
      const page = await phoneStudio(stack, w, h, lang);
      await openLeftPanel(page);
      assert((await page.eval(`document.querySelectorAll('.mode-card').length`)) === MODES.length, 'one card per mode');
      for (const mode of MODES) {
        await page.eval(`document.querySelector('.mode-card[data-mode="${mode}"]').click()`);
        await page.waitFor(`document.querySelector('.mode-card[data-mode="${mode}"]').getAttribute('aria-checked') === 'true'`, `${mode} selected`);
        await sleep(250);
        const r = await page.eval(`(() => {
          const q = window.__q, out = [];
          for (const c of document.querySelectorAll('.mode-card')) {
            const b = q.rect(c);
            if (!b) { out.push('card hidden ' + c.dataset.mode); continue; }
            if (b.l < 0 || b.r > innerWidth + 0.5) out.push('card outside viewport ' + c.dataset.mode);
            if (b.b - b.t < 39.5) out.push('card too small ' + c.dataset.mode + ' ' + Math.round(b.b - b.t));
          }
          const cards = document.querySelector('.mode-cards');
          out.push(...q.clipped(document.querySelector('.mode-picker')));
          const rule = document.querySelector('.mode-rule');
          if (rule.scrollHeight > rule.clientHeight + 1) out.push('rule text clipped');
          const siege = document.querySelector('#siege-opts');
          // the hidden attribute alone is not enough: an author display rule used to keep the chooser label visible in every mode
          if (q.vis(siege) !== (${JSON.stringify(mode)} === 'siege') || siege.hidden !== (${JSON.stringify(mode)} !== 'siege')) out.push('siege chooser visibility');
          if (!siege.hidden) { out.push(...q.small(siege).map((s) => 'siege button ' + s)); out.push(...q.clipped(siege)); }
          if (q.overflow() > 1) out.push('page overflows by ' + q.overflow());
          const panel = q.rect('#panel-left'), dock = q.rect('.dock');
          if (panel && (panel.l < 0 || panel.r > innerWidth + 0.5)) out.push('settings panel outside the viewport ' + JSON.stringify(panel));
          if (panel && dock && panel.b > dock.t + 1) out.push('panel reaches under the dock by ' + Math.round(panel.b - dock.t));
          return out;
        })()`);
        assert(r.length === 0, `${name} mode=${mode}: ${r.join('; ')}`);
      }
      noErrors(page, name);
    },
  };
}

/** VIP tool in the dock's sheet is a proper touch target; a real touch tap on a soldier marks it as the team's VIP. */
function vipTapTest(name, lang) {
  return {
    name,
    async run({ stack }) {
      const page = await phoneStudio(stack, 390, 844, lang);
      await openLeftPanel(page);
      await page.eval(`document.querySelector('.mode-card[data-mode="vip"]').click()`);
      await page.waitFor(`!!document.querySelector('#tool button[data-id="vip"]')`, 'VIP tool button');
      await page.eval(`document.querySelector('#panel-left .panel-close').click()`);
      await sleep(500);
      // The collapsed dock keeps the tool group on its scrolling row; the open sheet shows it whole.
      await page.eval(`document.querySelector('.sheet-handle').click()`);
      await sleep(500);
      const r = await page.eval(`(() => { const q = window.__q, b = q.rect('#tool button[data-id="vip"]'); return { b, small: q.small(document.querySelector('.dock')), clipped: q.clipped(document.querySelector('.dock')), over: q.overflow() }; })()`);
      assert(r.b && r.b.b - r.b.t >= 39.5 && r.b.r <= 391 && r.b.l >= 0, 'VIP tool button must be visible and >= 40 px tall in the open sheet: ' + JSON.stringify(r.b));
      assert(r.small.length === 0 && r.clipped.length === 0 && r.over <= 1, `dock in VIP mode: ${JSON.stringify(r)}`);
      await page.eval(`document.querySelector('#tool button[data-id="vip"]').click()`);
      await page.eval(`document.querySelector('.sheet-handle').click()`);
      await sleep(500);
      // Tap (touch events) on the team's front soldier.
      const pos = await page.eval(`(() => {
        const s = JSON.parse(localStorage.getItem('rpgweb.studio.v1'));
        const u = s.units.filter((x) => x.team === 0).sort((a, b) => a.x + a.y - (b.x + b.y))[0];
        const c = window.__studioWorld.toClient(u.x, u.y);
        return [c.x, c.y];
      })()`);
      const touch = (type, pts) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      await touch('touchStart', [{ x: pos[0], y: pos[1], id: 1 }]);
      await sleep(120);
      await touch('touchEnd', []);
      await page.waitFor(`JSON.parse(localStorage.getItem('rpgweb.studio.v1')).units.filter((u) => u.vip).length === 1`, 'a tap with the VIP tool marks exactly one VIP', 8000);
      noErrors(page, name);
    },
  };
}

/** Battle HUD with each mode's objective strip: it stays inside the screen and clear of the team bar, damage meter, stats panel, bottom bar and hint; the result card fits. */
function hudTest(name, w, h, lang, modes) {
  return {
    name,
    async run({ stack }) {
      for (const mode of modes) {
        const page = await phoneStudio(stack, w, h, lang);
        await openLeftPanel(page);
        await page.eval(`document.querySelector('.mode-card[data-mode="${mode}"]').click()`);
        await page.waitFor(`document.querySelector('.mode-card[data-mode="${mode}"]').getAttribute('aria-checked') === 'true'`, `${mode} selected`);
        await sleep(600);
        await page.eval(`document.querySelector('#panel-left .panel-close').click()`);
        await sleep(400);
        await page.eval(`document.querySelector('#start').click()`);
        await page.waitFor(`!!window.__sim && window.__sim.modeHud.kind === '${mode}' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, `${mode} battle with the strip`, 40000);
        await install(page);
        await page.eval(`document.querySelector('#hud-speed button:last-child').click()`);
        await sleep(1500);
        // open both side panels: the expanded damage meter and the stats panel
        await page.eval(`(() => { document.querySelector('.dps-toggle')?.click(); document.querySelector('#hud-stats')?.click(); })()`);
        await sleep(900);
        const r = await page.eval(`(() => {
          const q = window.__q, out = [];
          const strip = q.rect('.hud-mode');
          if (!strip) return ['no strip'];
          if (strip.l < 0 || strip.r > innerWidth + 0.5) out.push('strip outside the viewport ' + JSON.stringify(strip));
          const el = document.querySelector('.hud-mode');
          if (el.scrollWidth > el.clientWidth + 1) out.push('strip content wider than the strip');
          out.push(...q.clipped(el));
          for (const s of ['#hud-teams', '.dps', '#stats', '.hud-bottom', '.hud-tip']) if (q.hit(strip, q.rect(s))) out.push('strip overlaps ' + s);
          const dps = q.rect('.dps'), bar = q.rect('.hud-bottom');
          if (q.hit(dps, bar)) out.push('damage meter overlaps the bottom bar');
          if (q.hit(dps, q.rect('#hud-teams'))) out.push('damage meter overlaps the team bar');
          if (q.hit(q.rect('#stats'), q.rect('#hud-teams'))) out.push('stats overlap the team bar');
          if (q.hit(q.rect('#stats'), dps)) out.push('stats overlap the damage meter');
          if (q.overflow() > 1) out.push('page overflows by ' + q.overflow());
          return out;
        })()`);
        assert(r.length === 0, `${name} mode=${mode}: ${r.join('; ')}`);
        // result card (forced winner through the debug handle): fits the screen, nothing clipped, scoreboard scrolls instead of overflowing
        await page.eval(`window.__sim.winner = 0`);
        await page.waitFor(`!!document.querySelector('#hud-result') && !document.querySelector('#hud-result').hidden && !!document.querySelector('#hud-result table, #hud-result .res-table, #hud-result li')`, 'result card', 15000);
        await sleep(400);
        const res = await page.eval(`(() => {
          const q = window.__q, out = [], card = document.querySelector('#hud-result > div');
          const b = q.rect(card);
          if (!b || b.l < 0 || b.r > innerWidth + 0.5 || b.t < 0 || b.b > innerHeight + 0.5) out.push('result card outside the viewport ' + JSON.stringify(b));
          const btns = [...card.querySelectorAll('button')].filter(q.vis);
          out.push(...q.small(card).map((s) => 'result button ' + s));
          if (btns.length === 0) out.push('no result buttons');
          if (q.overflow() > 1) out.push('page overflows by ' + q.overflow());
          return out;
        })()`);
        assert(res.length === 0, `${name} result mode=${mode}: ${res.join('; ')}`);
        noErrors(page, name);
        page.close();
      }
    },
  };
}

/** Online lobby on a phone (host): mode cards, rule text, the Siege defender select and the Lane Conquest note appear only for their mode and fit. */
function lobbyTest(name, w, h, lang) {
  return {
    name,
    async run({ stack }) {
      const page = await stack.page({ width: w, height: h, mobile: true });
      await page.nav(`${stack.base}?lang=${lang}&view=2d&debug=1&tour=off`);
      await install(page);
      await page.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await page.eval(`document.querySelector('#m-host').click()`);
      await page.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await sleep(500);
      const tabs = await page.eval(`(() => { const q = window.__q, b = [...document.querySelectorAll('.on-tabs button')]; b[1]?.click(); return { n: b.length, small: b.filter((x) => x.getBoundingClientRect().height < 39.5).length }; })()`);
      assert(tabs.n === 2 && tabs.small === 0, 'Players / Settings tabs: ' + JSON.stringify(tabs));
      await sleep(300);
      for (const mode of MODES) {
        await page.eval(`document.querySelector('#l-mode .mode-card[data-mode="${mode}"]').click()`);
        await page.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="${mode}"]').getAttribute('aria-checked') === 'true'`, `${mode} selected`);
        await sleep(300);
        const r = await page.eval(`(() => {
          const q = window.__q, out = [];
          for (const c of document.querySelectorAll('#l-mode .mode-card')) {
            const b = q.rect(c);
            if (!b || b.l < 0 || b.r > innerWidth + 0.5 || b.b - b.t < 39.5) out.push('card ' + c.dataset.mode + ' ' + JSON.stringify(b));
          }
          out.push(...q.clipped(document.querySelector('#l-mode')));
          const rule = document.querySelector('#l-mode .mode-rule');
          if (rule.scrollHeight > rule.clientHeight + 1) out.push('rule text clipped');
          if (q.vis(document.querySelector('#l-siege')) !== (${JSON.stringify(mode)} === 'siege')) out.push('siege defender select visibility');
          if (q.vis(document.querySelector('#l-lanes-note')) !== (${JSON.stringify(mode)} === 'lanes')) out.push('lanes note visibility');
          for (const s of ['#l-siege', '#l-lanes-note']) { const e = document.querySelector(s); if (q.vis(e)) out.push(...q.clipped(e)); }
          if (q.overflow() > 1) out.push('page overflows by ' + q.overflow());
          return out;
        })()`);
        assert(r.length === 0, `${name} mode=${mode}: ${r.join('; ')}`);
      }
      noErrors(page, name);
    },
  };
}

export const mobileTests = [
  studioCardsTest('mobile-mode-cards-en-360', 360, 640, 'en'),
  studioCardsTest('mobile-mode-cards-tr-320', 320, 568, 'tr'),
  studioCardsTest('mobile-mode-cards-tr-landscape', 667, 360, 'tr'),
  lobbyTest('mobile-lobby-modes-en-360', 360, 640, 'en'),
  lobbyTest('mobile-lobby-modes-tr-320', 320, 568, 'tr'),
  vipTapTest('mobile-vip-tap-en', 'en'),
  vipTapTest('mobile-vip-tap-tr', 'tr'),
  hudTest('mobile-hud-strip-en-a', 390, 844, 'en', HUD_MODES.slice(0, 3)),
  hudTest('mobile-hud-strip-en-b', 390, 844, 'en', HUD_MODES.slice(3)),
  hudTest('mobile-hud-strip-tr-a', 320, 568, 'tr', HUD_MODES.slice(0, 3)),
  hudTest('mobile-hud-strip-tr-b', 320, 568, 'tr', HUD_MODES.slice(3)),
  hudTest('mobile-hud-strip-landscape', 667, 360, 'tr', ['vip', 'lanes']),
];
