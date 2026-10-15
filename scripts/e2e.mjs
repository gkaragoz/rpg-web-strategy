#!/usr/bin/env node
// End-to-end tests in a real (headless) Chrome against the production build.
// Usage: npm run build && npm run e2e [name-filter]
// Starts `vite preview` (ports 4310 / debug 9360) and Chrome itself and stops only those. Needs Chrome/Edge (CHROME=/path to override).
import { startStack, sleep, until } from './lib/browser.mjs';

const only = process.argv[2];
const results = [];

const unitsSaved = (page) => page.eval(`(() => { try { return JSON.parse(localStorage.getItem('rpgweb.studio.v1')).units.length; } catch { return -1; } })()`);
const noErrors = (page, label) => {
  const bad = page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  if (bad.length) throw new Error(`${label}: ${bad.length} page error(s): ${bad[0]}`);
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const tests = [
  {
    name: 'home-2d',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      assert(await page.eval(`!!document.querySelector('#m-own') && !!document.querySelector('#m-host') && !!document.querySelector('#m-join')`), 'home menu buttons missing');
      assert(await page.eval(`document.title.length > 0`), 'no title');
      noErrors(page, 'home');
    },
  },
  {
    name: 'studio-gallery-key-en',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      const open = () => page.eval(`document.querySelectorAll('dialog[open]').length`);
      await page.key('b', 'KeyB'); // brush key in English, not the gallery
      assert((await open()) === 0, 'B must not open the gallery in English');
      await page.key('u', 'KeyU');
      await until(async () => (await open()) === 1, 'gallery opens with U');
      await page.key('u', 'KeyU');
      await until(async () => (await open()) === 0, 'gallery closes with U');
      noErrors(page, 'studio');
    },
  },
  {
    name: 'studio-gallery-key-tr',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=tr&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      const open = () => page.eval(`document.querySelectorAll('dialog[open]').length`);
      await page.key('u', 'KeyU');
      assert((await open()) === 0, 'U must not open the gallery in Turkish');
      await page.key('b', 'KeyB');
      await until(async () => (await open()) === 1, 'gallery opens with B');
      // typing in the search box must not toggle it
      await page.clickSel('#ug-search');
      for (const [k, c] of [['b', 'KeyB'], ['b', 'KeyB']]) await page.key(k, c);
      assert((await open()) === 1, 'typing B in the search box closed the gallery');
      noErrors(page, 'studio-tr');
    },
  },
  {
    name: 'studio-paint-undo',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await sleep(1200);
      const before = await unitsSaved(page);
      assert(before > 0, `fresh state should have a quick formation (units=${before})`);
      let after = before;
      for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45], [0.4, 0.5], [0.6, 0.5]]) {
        await page.click(1280 * fx, 800 * fy);
        await sleep(700);
        after = await unitsSaved(page);
        if (after > before) break;
      }
      assert(after > before, `painting should add units (${before} -> ${after})`);
      await page.key('z', 'KeyZ', 2); // Ctrl+Z
      await until(async () => (await unitsSaved(page)) < after, 'undo removes the painted units');
      noErrors(page, 'paint');
    },
  },
  {
    name: 'atlas-fits-gpu-with-every-unit',
    async run({ stack }) {
      // Six teams with one soldier of every kind: the single atlas texture must stay inside the GPU limit with all frames inside it
      // (an oversized sheet lost its lower rows, so some units were invisible while still fighting).
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.waitFor(`!!localStorage.getItem('rpgweb.studio.v1')`, 'the studio state to be saved', 15000);
      await page.eval(`(() => {
        const KEY = 'rpgweb.studio.v1';
        const s = JSON.parse(localStorage.getItem(KEY));
        s.teamCount = 6;
        s.fresh = false;
        const size = s.mapSize || 56;
        s.units = [];
        for (let k = 0; k < 60; k++) for (let t = 0; t < 6; t++) s.units.push({ team: t, kind: k, x: 3 + (k % 10) * 4 + t * 0.5, y: 3 + Math.floor(k / 10) * 4 + t * 0.5 });
        s.units = s.units.filter((u) => u.x < size && u.y < size);
        localStorage.setItem(KEY, JSON.stringify(s));
      })()`);
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      const r = await page.waitFor(`(() => {
        const a = window.__atlas, gl = window.__app && window.__app.renderer.gl;
        if (!a || !gl) return null;
        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const first = a.unitTex.find(Boolean);
        const src = first.source;
        let outside = 0, missing = 0, count = 0;
        for (let i = 0; i < a.unitTex.length; i++) {
          const t = a.unitTex[i];
          if (!t) { missing++; continue; }
          count++;
          if (t.frame.x < 0 || t.frame.y < 0 || t.frame.x + t.frame.width > src.width + 0.5 || t.frame.y + t.frame.height > src.height + 0.5) outside++;
        }
        return { max, pw: src.pixelWidth, ph: src.pixelHeight, kinds: a.kinds.size, outside, count };
      })()`, 'atlas to exist', 30000);
      assert(r.kinds >= 40, `expected an atlas with (nearly) every kind, got ${r.kinds}`);
      assert(r.pw <= r.max && r.ph <= r.max, `atlas ${r.pw}x${r.ph} exceeds the GPU limit ${r.max}`);
      assert(r.outside === 0, `${r.outside} unit frames lie outside the atlas texture`);
      noErrors(page, 'atlas');
    },
  },
  {
    name: 'battle-2d',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.clickSel('#start');
      await page.waitFor(`!!window.__sim && !!document.querySelector('#hud-teams')`, 'battle to start', 30000);
      await sleep(3000);
      assert(await page.eval(`document.querySelector('#hud-teams').children.length > 0`), 'team bar empty');
      await page.clickSel('#hud-edit');
      await page.waitFor(`!!document.querySelector('#start') && document.querySelector('#start').offsetParent !== null`, 'back in the studio');
      noErrors(page, 'battle-2d');
    },
  },
  {
    name: 'mode-hill-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      assert(await page.eval(`document.querySelectorAll('.mode-card').length >= 2`), 'mode cards missing in the studio');
      await page.clickSel('.mode-card[data-mode="hill"]');
      await page.waitFor(`document.querySelector('.mode-card[data-mode="hill"]').getAttribute('aria-checked') === 'true'`, 'hill selected');
      assert(await page.eval(`document.querySelector('.mode-rule').textContent.includes('100')`), 'rule text should mention the goal');
      await page.clickSel('#start');
      await page.waitFor(`!!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'objective strip', 30000);
      await sleep(4000);
      const strip = await page.eval(`document.querySelector('.hud-mode').textContent`);
      assert(/100/.test(strip) && /3/.test(strip), 'strip should show the goal and the three points: ' + strip);
      assert((await page.eval(`window.__sim.modeHud.kind`)) === 'hill', 'sim should run hill rules');
      noErrors(page, 'hill');
    },
  },
  {
    name: 'mode-vip-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.clickSel('.mode-card[data-mode="vip"]');
      await page.waitFor(`!!document.querySelector('#tool button[data-id="vip"]')`, 'VIP tool button');
      await page.clickSel('#tool button[data-id="vip"]');
      await sleep(500);
      // Click one of team 1's soldiers: its screen position comes from the debug handle of the studio world.
      const pos = await page.eval(`(() => {
        const s = JSON.parse(localStorage.getItem('rpgweb.studio.v1'));
        const u = s.units.filter((x) => x.team === 0).sort((a, b) => a.x + a.y - (b.x + b.y))[0];
        const c = window.__studioWorld.toClient(u.x, u.y);
        return [c.x, c.y];
      })()`);
      await page.click(pos[0], pos[1]);
      await page.waitFor(`JSON.parse(localStorage.getItem('rpgweb.studio.v1')).units.filter((u) => u.vip).length === 1`, 'exactly one VIP saved', 10000);
      await page.clickSel('#start');
      await page.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'vip' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'VIP battle with the strip', 30000);
      const teams = await page.eval(`window.__sim.modeHud.teams.filter((t) => t.unit >= 0).length`);
      assert(teams === 2, 'both teams should have a VIP, got ' + teams);
      noErrors(page, 'vip');
    },
  },
  {
    name: 'battle-3d',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=3d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.waitFor(`!!window.__v3`, '3D view to exist', 30000);
      await page.clickSel('#start');
      await page.waitFor(`!!window.__sim && !!document.querySelector('#hud-teams')`, 'battle to start', 30000);
      await sleep(3000);
      assert(await page.eval(`document.querySelectorAll('canvas').length >= 2`), 'expected the Three.js canvas next to the hidden Pixi one');
      noErrors(page, 'battle-3d');
    },
  },
  {
    name: 'mobile-no-overflow',
    async run({ stack }) {
      const page = await stack.page({ width: 390, height: 844, mobile: true });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      const overflow = () => page.eval(`document.documentElement.scrollWidth - window.innerWidth`);
      assert((await overflow()) <= 1, `home overflows horizontally by ${await overflow()} px`);
      // CDP mouse events never settle on a touch-emulated page: click through the DOM instead
      await page.eval(`document.querySelector('#m-own').click()`);
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await sleep(800);
      assert((await overflow()) <= 1, `studio overflows horizontally by ${await overflow()} px`);
      noErrors(page, 'mobile');
    },
  },
  {
    name: 'online-lan-pair',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      assert(/^[A-Z0-9]{4,8}$/.test(code), `bad lobby code: ${code}`);
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-players')`, 'guest in lobby', 20000);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'host sees two players', 20000);
      await guest.eval(`(() => { const i = document.querySelector('#l-chat'); i.value = 'hello e2e'; i.closest('form').requestSubmit(); })()`);
      await host.waitFor(`document.querySelector('#l-log')?.textContent.includes('hello e2e')`, 'chat reaches the host');
      await guest.clickSel('#l-ready');
      await host.clickSel('#l-start');
      await host.waitFor(`!!document.querySelector('.on-dock')`, 'host placement screen', 30000);
      await guest.waitFor(`!!document.querySelector('.on-dock')`, 'guest placement screen', 30000);
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    name: 'mode-hill-online',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.clickSel('#l-mode .mode-card[data-mode="hill"]');
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-mode')`, 'guest in lobby', 20000);
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="hill"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees hill');
      assert(await guest.eval(`document.querySelector('#l-mode .mode-card[data-mode="classic"]').disabled`), 'guests must not change the mode');
      await guest.clickSel('#l-ready');
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.clickSel('#l-start');
      for (const p of [host, guest]) await p.waitFor(`!!window.__placement && !!document.querySelector('.on-dock')`, 'placement', 30000);
      // One soldier group per player inside its own team zone (found through the debug handle), then READY on both.
      for (const p of [host, guest]) {
        const n = await p.eval(`(() => {
          const pl = window.__placement;
          const z = pl.zones.find((q) => q.team === pl.myTeam);
          const t = pl.env.world.terrain;
          const items = [];
          for (let y = 0; y < pl.init.size && items.length < 6; y++) for (let x = 0; x < pl.init.size && items.length < 6; x++) {
            const px = x + 0.5, py = y + 0.5;
            if (z.contains(px, py) && (!t || (t.walkable(px, py) && t.reachable(px, py))) && items.every((o) => Math.hypot(o.x - px, o.y - py) > 2)) items.push({ cid: 9000 + items.length, kind: 0, x: px, y: py });
          }
          window.__session.send({ t: 'place', items });
          return items.length;
        })()`);
        assert(n >= 3, 'found no place to put soldiers');
      }
      await sleep(1500);
      for (const p of [host, guest]) await p.clickSel('#pg-ready');
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'hill' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'hill battle with the objective strip', 60000);
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    name: 'mode-vip-online',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.clickSel('#l-mode .mode-card[data-mode="vip"]');
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-mode')`, 'guest in lobby', 20000);
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="vip"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees vip');
      assert(await guest.eval(`document.querySelector('#l-mode .mode-card[data-mode="classic"]').disabled`), 'guests must not change the mode');
      await guest.clickSel('#l-ready');
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.clickSel('#l-start');
      for (const p of [host, guest]) await p.waitFor(`!!window.__placement && !!document.querySelector('.on-dock')`, 'placement', 30000);
      // One soldier group per player inside its own team zone (found through the debug handle), then READY on both.
      for (const p of [host, guest]) {
        const n = await p.eval(`(() => {
          const pl = window.__placement;
          const z = pl.zones.find((q) => q.team === pl.myTeam);
          const t = pl.env.world.terrain;
          const items = [];
          for (let y = 0; y < pl.init.size && items.length < 6; y++) for (let x = 0; x < pl.init.size && items.length < 6; x++) {
            const px = x + 0.5, py = y + 0.5;
            if (z.contains(px, py) && (!t || (t.walkable(px, py) && t.reachable(px, py))) && items.every((o) => Math.hypot(o.x - px, o.y - py) > 2)) items.push({ cid: 9000 + items.length, kind: 0, x: px, y: py });
          }
          window.__session.send({ t: 'place', items });
          return items.length;
        })()`);
        assert(n >= 3, 'found no place to put soldiers');
      }
      await sleep(1500);
      // Each player makes one of their placed soldiers the VIP (through the VIP tool of the dock and a click on it).
      for (const p of [host, guest]) {
        await p.clickSel('#pg-tool button[data-id="vip"]');
        // The soldiers may lie outside the visible map area, so the tool is applied through the editor (the real click path is covered by the studio test).
        await p.eval(`(() => {
          const pl = window.__placement;
          const u = pl.state.units.find((x) => x.id !== undefined);
          const c = pl.env.world.toClient(u.x, u.y);
          pl.editor.vipPick(c.x, c.y);
        })()`);
        await p.waitFor(`window.__placement.state.units.some((u) => u.vip)`, 'VIP marked locally', 10000);
        await p.waitFor(`window.__session.model.vip >= 0`, 'host confirmed the VIP', 10000);
      }
      for (const p of [host, guest]) await p.clickSel('#pg-ready');
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'vip' && window.__sim.modeHud.teams.filter((q) => q.unit >= 0).length === 2 && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'VIP battle with the objective strip', 60000);
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
];

const stack = await startStack();
let failed = 0;
try {
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    const t0 = Date.now();
    try {
      // Every test starts like a first visit: the profile (and so localStorage) is shared by all pages of the run.
      const clean = await stack.page();
      await clean.nav(`${stack.base}?lang=en&tour=off`);
      await clean.eval('localStorage.clear(); sessionStorage.clear()');
      clean.close();
      await Promise.race([t.run({ stack }), new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out after 120 s')), 120000))]);
      results.push(`PASS ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      results.push(`FAIL ${t.name}: ${e.message}`);
    }
    console.log(results.at(-1));
  }
} finally {
  stack.stop();
}
console.log(failed ? `\n${failed} e2e test(s) failed` : '\nall e2e tests passed');
process.exit(failed ? 1 : 0);
