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
];

const stack = await startStack();
let failed = 0;
try {
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    const t0 = Date.now();
    try {
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
