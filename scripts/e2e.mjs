#!/usr/bin/env node
// End-to-end tests in a real (headless) Chrome against the production build.
// Usage: npm run build && npm run e2e [name-filter]
// Starts `vite preview` (ports 4310 / debug 9360, override with E2E_PORT / E2E_DEBUG_PORT) and Chrome itself and stops only those. Needs Chrome/Edge (CHROME=/path to override).
import { startStack, sleep, until } from './lib/browser.mjs';
import { mobileTests } from './e2e-mobile.mjs';
import { onlineTests } from './e2e-online.mjs';

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

/** Opens the solo studio in the 3D view (optionally with a game mode selected). */
async function studio3d(stack, mode) {
  const page = await stack.page({ width: 1280, height: 800 });
  await page.nav(`${stack.base}?lang=en&view=3d&debug=1&tour=off`);
  await page.clickSel('#m-own');
  await page.waitFor(`!!document.querySelector('#start') && !!window.__v3`, 'studio and 3D view', 30000);
  if (mode) {
    await page.clickSel(`.mode-card[data-mode="${mode}"]`);
    await page.waitFor(`document.querySelector('.mode-card[data-mode="${mode}"]').getAttribute('aria-checked') === 'true'`, `${mode} selected`);
    await sleep(600);
  }
  return page;
}
const startStudioBattle = async (page, kind) => {
  await page.clickSel('#start');
  await page.waitFor(`!!window.__sim && window.__sim.modeHud.kind === '${kind}' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, `${kind} battle with the strip`, 40000);
  await sleep(1500);
};
/** Every alive unit (structures and horde monsters included) must have a sprite in the 3D atlas, or it fights invisibly. */
const drawable3d = (page) =>
  page.eval(`(() => {
    const g = window.__v3.view.atlas, u = window.__sim.units;
    let alive = 0, missing = 0;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      alive++;
      if (!g.units.has[(u.kind[i] * 6 + u.team[i]) * 5]) missing++;
    }
    return { alive, missing };
  })()`);
const markers3d = (page) => page.eval(`window.__v3.view.markers.filter((m) => m.group.visible).map((m) => ({ ring: m.ring.visible, pin: m.pin.visible, flag: m.pole.visible && m.cloth.visible, sc: window.__v3.view.project(m.group.position.x, m.group.position.y, m.group.position.z) }))`);
const cornersInView3d = (page) =>
  page.eval(`(() => {
    const v = window.__v3.view, s = v.size, w = v.renderer.domElement.clientWidth, h = v.renderer.domElement.clientHeight;
    return [[0, 0], [0, s], [s, 0], [s, s]].every(([x, z]) => { const p = v.project(x, 0, z); return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h; });
  })()`);

/** Hosts a LAN room in `hostView`, joins it from `guestView`, plays the lobby and placement (one soldier group each) and returns both pages in battle. */
async function onlineBattle(stack, mode, hostView, guestView) {
  const host = await stack.page({ width: 1280, height: 800 });
  const guest = await stack.page({ width: 1280, height: 800 });
  await host.nav(`${stack.base}?lang=en&view=${hostView}&debug=1&tour=off`);
  await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
  await host.clickSel('#m-host');
  const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
  await host.clickSel(`#l-mode .mode-card[data-mode="${mode}"]`);
  await guest.nav(`${stack.base}?lang=en&view=${guestView}&debug=1&tour=off`);
  await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await guest.clickSel('#m-join');
  await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="${mode}"]')?.getAttribute('aria-checked') === 'true'`, `guest sees ${mode}`, 20000);
  await guest.eval(`document.querySelector('#l-ready').click()`);
  await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
  await host.eval(`document.querySelector('#l-start').click()`);
  for (const p of [host, guest]) await p.waitFor(`!!window.__placement && !!document.querySelector('.on-dock')`, 'placement', 30000);
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
  for (const p of [host, guest]) await p.waitFor(`!!window.__sim && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, `${mode} battle with the objective strip`, 60000);
  await sleep(1500);
  return { host, guest };
}

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
      // Every unit cell must really contain pixels (a render target the GPU could not allocate comes out blank without an error).
      const blank = await page.eval(`(() => { const a = window.__atlas, r = window.__app.renderer; let blank = 0, n = 0; for (let i = 0; i < a.unitTex.length; i += 7) { const t = a.unitTex[i]; if (!t) continue; n++; const px = r.extract.pixels({ target: t }).pixels; let any = false; for (let k = 3; k < px.length; k += 4) if (px[k] > 0) { any = true; break; } if (!any) blank++; } return { blank, n }; })()`);
      assert(blank.n > 20 && blank.blank === 0, `blank unit cells in the atlas: ${JSON.stringify(blank)}`);
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
    name: 'mode-ctf-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      assert(await page.eval(`document.querySelectorAll('.mode-card').length >= 2`), 'mode cards missing in the studio');
      await page.clickSel('.mode-card[data-mode="ctf"]');
      await page.waitFor(`document.querySelector('.mode-card[data-mode="ctf"]').getAttribute('aria-checked') === 'true'`, 'ctf selected');
      assert(await page.eval(`document.querySelector('.mode-rule').textContent.includes('3')`), 'rule text should mention the goal');
      await page.clickSel('#start');
      await page.waitFor(`!!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'objective strip', 30000);
      await sleep(4000);
      const strip = await page.eval(`document.querySelector('.hud-mode').textContent`);
      assert(/3/.test(strip), 'strip should show the capture goal: ' + strip);
      assert((await page.eval(`window.__sim.modeHud.kind`)) === 'ctf', 'sim should run ctf rules');
      noErrors(page, 'ctf');
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
    name: 'mode-siege-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.clickSel('.mode-card[data-mode="siege"]');
      await page.waitFor(`!document.querySelector('#siege-opts').hidden`, 'defender chooser');
      await page.clickSel('#siege-def button[data-id="1"]');
      await page.waitFor(`document.querySelector('#siege-def button[data-id="1"]').getAttribute('aria-pressed') === 'true'`, 'team 2 defends');
      await page.clickSel('#start');
      await page.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'siege' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'siege battle with the strip', 30000);
      const hud = await page.eval(`window.__sim.modeHud`);
      assert(hud.defender === 1, 'team 2 should defend, got ' + hud.defender);
      assert(hud.coreMaxHp === 3000 && hud.coreUnit >= 0, 'the core should exist');
      noErrors(page, 'siege');
    },
  },
  {
    name: 'mode-horde-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.clickSel('.mode-card[data-mode="horde"]');
      await page.waitFor(`document.querySelector('.mode-card[data-mode="horde"]').getAttribute('aria-checked') === 'true'`, 'horde selected');
      await sleep(600);
      await page.clickSel('#start');
      await page.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'horde' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'horde battle with the strip', 30000);
      await page.eval(`document.querySelector('#hud-speed button:last-child').click()`);
      await page.waitFor(`window.__sim.modeHud.wave >= 1`, 'the first wave to spawn', 60000);
      const hud = await page.eval(`window.__sim.modeHud`);
      assert(hud.waves === 12 && hud.hordeAlive > 0, 'wave 1 should have monsters: ' + JSON.stringify(hud));
      assert((await page.eval(`window.__sim.alivePerTeam.length`)) >= 3, 'the horde is its own team index');
      noErrors(page, 'horde');
    },
  },
  {
    name: 'mode-lanes-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.clickSel('.mode-card[data-mode="lanes"]');
      await page.waitFor(`document.querySelector('.mode-card[data-mode="lanes"]').getAttribute('aria-checked') === 'true'`, 'lanes selected');
      await page.waitFor(`window.__studioWorld.mapSize >= 80`, 'the studio world to switch to the lanes map (size 80+)', 15000);
      await sleep(800);
      await page.clickSel('#start');
      await page.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'lanes' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'lanes battle with the strip', 40000);
      const hud = await page.eval(`window.__sim.modeHud`);
      assert(hud.castles.length === 2 && hud.castles.every((c) => c.hp === 1 && c.unit >= 0), 'both castles should stand: ' + JSON.stringify(hud.castles));
      assert(hud.towers[0] === 6 && hud.towers[1] === 6, 'six towers per team: ' + hud.towers);
      await page.eval(`document.querySelector('#hud-speed button:last-child').click()`);
      await page.waitFor(`window.__sim.modeHud.wave >= 1`, 'the first wave', 60000);
      noErrors(page, 'lanes');
    },
  },
  {
    name: 'maps-follow-the-mode-studio',
    async run({ stack }) {
      const page = await stack.page({ width: 1280, height: 800 });
      await page.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await page.waitFor(`!!localStorage.getItem('rpgweb.studio.v1')`, 'saved studio state', 15000);
      const preset = () => page.eval(`JSON.parse(localStorage.getItem('rpgweb.studio.v1')).mapPreset`);
      assert((await preset()) === 'pine-valley', 'default map expected');
      // Siege only supports citadel/forts/plateau maps: the first of them replaces the current map and the user is told.
      await page.clickSel('.mode-card[data-mode="siege"]');
      await page.waitFor(`JSON.parse(localStorage.getItem('rpgweb.studio.v1')).mapPreset === 'citadel-hill'`, 'fallback to the first siege map', 10000);
      assert(await page.eval(`!!document.querySelector('.toast') && /siege/i.test(document.querySelector('.toast').textContent)`), 'a toast should explain the switch');
      // The picker only lists maps of the mode; "Show all maps" lists the others disabled.
      await page.clickSel('#map-btn');
      await page.waitFor(`!!document.querySelector('.map-grid')`, 'map picker');
      const fit = await page.eval(`[...document.querySelectorAll('.map-card[data-id]')].filter((c) => c.dataset.id !== 'random').length`);
      const total = await page.eval(`(() => { document.querySelector('#mp-showall').click(); return [...document.querySelectorAll('.map-card[data-id]')].filter((c) => c.dataset.id !== 'random').length; })()`);
      const off = await page.eval(`document.querySelectorAll('.map-card.off[disabled]').length`);
      assert(fit > 0 && fit < total && off === total - fit, 'filter counts: ' + [fit, total, off]);
      // A disabled card does nothing.
      await page.eval(`document.querySelector('.map-card.off').click()`);
      assert((await preset()) === 'citadel-hill', 'incompatible map must not be selectable');
      // Back to classic keeps the siege map (every map fits classic); lanes keeps the stored map (own fixed map).
      await page.eval(`document.querySelector('.map-dialog form footer button').click()`);
      await page.clickSel('.mode-card[data-mode="lanes"]');
      await sleep(600);
      assert((await preset()) === 'citadel-hill', 'lanes must not overwrite the stored map');
      await page.clickSel('#map-btn');
      await page.waitFor(`!!document.querySelector('.map-dialog')?.open`, 'map dialog');
      assert(await page.eval(`/own map/i.test(document.querySelector('.map-dialog').textContent) && !document.querySelector('.map-grid')`), 'lanes shows the fixed-map note instead of the grid');
      noErrors(page, 'maps');
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
    name: 'mode-hill-3d',
    async run({ stack }) {
      const page = await studio3d(stack, 'hill');
      await startStudioBattle(page, 'hill');
      // The control points are drawn as ground tiles (on the bridge decks too) and the camera frames the whole map.
      const zone = await page.eval(`(() => { const z = window.__v3.view.zoneMesh; return z ? z.geometry.index.count / 6 : 0; })()`);
      assert(zone >= 60, `the three control points should be drawn as ground tiles, got ${zone}`);
      assert(await cornersInView3d(page), 'the whole map should be inside the view at the start of the battle');
      assert((await drawable3d(page)).missing === 0, 'every unit needs a sprite in the 3D atlas');
      noErrors(page, 'hill-3d');
    },
  },
  {
    name: 'mode-vip-3d',
    async run({ stack }) {
      const page = await studio3d(stack, 'vip');
      await page.waitFor(`!!document.querySelector('#tool button[data-id="vip"]')`, 'VIP tool button');
      await page.clickSel('#tool button[data-id="vip"]');
      await sleep(500);
      // Own the soldier closest to the click through the real pointer path: aim at the standing point of one soldier of team 1.
      const pos = await page.eval(`(() => {
        const s = JSON.parse(localStorage.getItem('rpgweb.studio.v1'));
        const u = s.units.filter((x) => x.team === 0).sort((a, b) => a.x + a.y - (b.x + b.y))[0];
        const c = window.__studioWorld.toClient(u.x, u.y);
        return [c.x, c.y];
      })()`);
      await page.click(pos[0], pos[1] - 12);
      await page.waitFor(`JSON.parse(localStorage.getItem('rpgweb.studio.v1')).units.filter((u) => u.vip).length === 1`, 'exactly one VIP saved', 10000);
      await page.waitFor(`window.__v3.view.markers.some((m) => m.group.visible && m.pin.visible)`, 'a crown marker over the VIP while placing');
      await startStudioBattle(page, 'vip');
      const m = await markers3d(page);
      assert(m.length === 2 && m.every((x) => x.ring && x.pin && !x.flag), 'both VIPs need a ring and a crown pin: ' + JSON.stringify(m));
      // Zoomed out the markers grow with the camera distance (they stay readable).
      const scales = await page.eval(`(() => { const v = window.__v3.view; const s = () => v.markers[0].group.scale.x; v.rig.dist = 40; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { const near = s(); v.rig.dist = 200; requestAnimationFrame(() => requestAnimationFrame(() => r([near, s()]))); }))); })()`);
      assert(scales[1] > scales[0] * 2, 'markers should be larger when zoomed out: ' + scales);
      noErrors(page, 'vip-3d');
    },
  },
  {
    name: 'mode-ctf-3d',
    async run({ stack }) {
      const page = await studio3d(stack, 'ctf');
      await startStudioBattle(page, 'ctf');
      const m = await markers3d(page);
      assert(m.length === 2 && m.every((x) => x.ring && x.flag && !x.pin), 'both flags need a ring and a pole with a pennant: ' + JSON.stringify(m));
      // The flags stand on the map and inside the view.
      const inside = await page.eval(`window.__v3.view.renderer.domElement.clientWidth`);
      assert(m.every((x) => x.sc.x > 0 && x.sc.x < inside), 'flags should be on screen: ' + JSON.stringify(m));
      noErrors(page, 'ctf-3d');
    },
  },
  {
    name: 'mode-siege-3d',
    async run({ stack }) {
      const page = await studio3d(stack, 'siege');
      await startStudioBattle(page, 'siege');
      const d = await drawable3d(page);
      assert(d.alive > 0 && d.missing === 0, `the core needs a sprite in the 3D atlas: ${JSON.stringify(d)}`);
      assert(await cornersInView3d(page), 'the whole map (and so the core) should be inside the view at the start of the battle');
      noErrors(page, 'siege-3d');
    },
  },
  {
    name: 'mode-horde-3d',
    async run({ stack }) {
      const page = await studio3d(stack, 'horde');
      await startStudioBattle(page, 'horde');
      await page.eval(`document.querySelector('#hud-speed button:last-child').click()`);
      await page.waitFor(`window.__sim.modeHud.hordeAlive > 0`, 'the first wave to spawn', 60000);
      const d = await drawable3d(page);
      assert(d.missing === 0, `the horde monsters need sprites in the 3D atlas: ${JSON.stringify(d)}`);
      noErrors(page, 'horde-3d');
    },
  },
  {
    name: 'mode-lanes-3d',
    async run({ stack }) {
      const page = await studio3d(stack, 'lanes');
      await page.waitFor(`window.__v3.view.size >= 80`, 'the 3D map to switch to the lanes map (size 80+)', 15000);
      await startStudioBattle(page, 'lanes');
      const d = await drawable3d(page);
      assert(d.alive > 0 && d.missing === 0, `castles and towers need sprites in the 3D atlas: ${JSON.stringify(d)}`);
      // Decor stands on the ground: every billboard of the map was built from terrain data (none dropped for a missing frame).
      const decor = await page.eval(`(() => { const v = window.__v3.view; return [v.terrain.decor.length, v.decorGeo.instanceCount]; })()`);
      assert(decor[0] > 0 && decor[1] === decor[0], 'all decor of the lanes map should be drawn: ' + decor);
      assert(await cornersInView3d(page), 'the whole lanes map should be inside the view at the start of the battle');
      // Back to the studio: the classic map returns.
      await page.eval(`document.querySelector('#hud-edit').click()`);
      await page.waitFor(`!!document.querySelector('#start') && document.querySelector('#start').offsetParent !== null`, 'back in the studio');
      await page.clickSel('.mode-card[data-mode="classic"]');
      await page.waitFor(`window.__v3.view.size < 80`, 'the classic map to come back');
      noErrors(page, 'lanes-3d');
    },
  },
  {
    name: 'mode-switch-view-keeps-mode',
    async run({ stack }) {
      const page = await studio3d(stack, 'ctf');
      const loaded = page.once('Page.loadEventFired');
      await page.clickSel('.view-seg button[data-view="2d"]');
      await loaded;
      await page.waitFor(`!!document.querySelector('#start') && !window.__v3`, 'the 2D studio', 30000);
      assert(await page.eval(`document.querySelector('.mode-card[data-mode="ctf"]').getAttribute('aria-checked') === 'true'`), 'the mode must survive the switch to 2D');
      await startStudioBattle(page, 'ctf');
      await page.eval(`document.querySelector('#hud-edit').click()`);
      await page.waitFor(`!!document.querySelector('#start') && document.querySelector('#start').offsetParent !== null`, 'back in the studio');
      const loaded3 = page.once('Page.loadEventFired');
      await page.clickSel('.view-seg button[data-view="3d"]');
      await loaded3;
      await page.waitFor(`!!document.querySelector('#start') && !!window.__v3`, 'the 3D studio', 30000);
      assert(await page.eval(`document.querySelector('.mode-card[data-mode="ctf"]').getAttribute('aria-checked') === 'true'`), 'the mode must survive the switch to 3D');
      await startStudioBattle(page, 'ctf');
      assert((await markers3d(page)).length === 2, 'the flags should be drawn after switching back to 3D');
      noErrors(page, 'switch');
    },
  },
  {
    name: 'mode-ctf-online-3d',
    async run({ stack }) {
      const { host, guest } = await onlineBattle(stack, 'ctf', '3d', '3d');
      for (const p of [host, guest]) {
        await p.send('Page.bringToFront'); // a background tab gets no animation frames, and the markers follow the units per frame
        await p.waitFor(`window.__v3.view.markers.filter((q) => q.group.visible).length === 2`, 'both flags to be drawn', 20000);
        const m = await markers3d(p);
        assert(m.every((x) => x.flag), 'both markers should be flags: ' + JSON.stringify(m));
        assert((await drawable3d(p)).missing === 0, 'every unit needs a sprite in the 3D atlas');
        assert(await cornersInView3d(p), 'the whole map should be inside the view');
      }
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    name: 'mode-lanes-online-3d',
    async run({ stack }) {
      // A 2D host and a 3D guest: the guest's atlas must contain the castles and towers it never placed, and its map must be the lanes map.
      const { host, guest } = await onlineBattle(stack, 'lanes', '2d', '3d');
      const d = await drawable3d(guest);
      assert(d.alive > 0 && d.missing === 0, `castles and towers need sprites in the guest's 3D atlas: ${JSON.stringify(d)}`);
      assert((await guest.eval(`window.__v3.view.size`)) >= 80, 'the 3D guest should show the lanes map');
      noErrors(host, 'host');
      noErrors(guest, 'guest');
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
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.eval(`document.querySelector('#l-start').click()`);
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
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
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
    name: 'mode-ctf-online',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.clickSel('#l-mode .mode-card[data-mode="ctf"]');
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-mode')`, 'guest in lobby', 20000);
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="ctf"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees ctf');
      assert(await guest.eval(`document.querySelector('#l-mode .mode-card[data-mode="classic"]').disabled`), 'guests must not change the mode');
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
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
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'ctf' && window.__sim.modeHud.flags.length === 2 && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'CTF battle with the objective strip', 60000);
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    name: 'mode-siege-online',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.clickSel('#l-mode .mode-card[data-mode="siege"]');
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-mode')`, 'guest in lobby', 20000);
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="siege"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees siege');
      assert(await guest.eval(`document.querySelector('#l-mode .mode-card[data-mode="classic"]').disabled`), 'guests must not change the mode');
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
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
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'siege' && window.__sim.modeHud.coreUnit >= 0 && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'siege battle with the objective strip', 60000);
      const layout = await host.eval(`window.__session.model.start.init.spec.layout`);
      assert(['citadel', 'forts', 'plateau'].includes(layout), 'siege must be played on a siege map, got ' + layout);
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    name: 'mode-horde-online',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.clickSel('#l-mode .mode-card[data-mode="horde"]');
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-mode')`, 'guest in lobby', 20000);
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="horde"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees horde');
      assert(await guest.eval(`document.querySelector('#l-mode .mode-card[data-mode="classic"]').disabled`), 'guests must not change the mode');
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
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
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'horde' && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'horde battle with the objective strip', 60000);
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    name: 'mode-lanes-online',
    async run({ stack }) {
      const host = await stack.page({ width: 1280, height: 800 });
      const guest = await stack.page({ width: 1280, height: 800 });
      await host.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.clickSel('#l-mode .mode-card[data-mode="lanes"]');
      await guest.nav(`${stack.base}?lang=en&view=2d&debug=1&tour=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`!!document.querySelector('#l-mode')`, 'guest in lobby', 20000);
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="lanes"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees lanes');
      assert(await guest.eval(`document.querySelector('#l-mode .mode-card[data-mode="classic"]').disabled`), 'guests must not change the mode');
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
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
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && window.__sim.modeHud.kind === 'lanes' && window.__sim.modeHud.castles.length === 2 && !!document.querySelector('.hud-mode') && !document.querySelector('.hud-mode').hidden`, 'lanes battle with the objective strip', 60000);
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
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
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
        await p.waitFor(`window.__placement.state.units.some((x) => x.id !== undefined)`, 'own soldiers confirmed by the host', 15000);
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
  ...onlineTests,
  ...mobileTests,
];

// E2E_PORT / E2E_DEBUG_PORT let several runs share one machine.
const stack = await startStack({ port: Number(process.env.E2E_PORT) || 4310, debugPort: Number(process.env.E2E_DEBUG_PORT) || 9360 });
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
