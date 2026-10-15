#!/usr/bin/env node
// Generates the README showcase screenshots (docs/screenshots/*.jpg) and rewrites the marked README block.
// Usage: npm run screenshots            (builds first, then serves dist with `vite preview`, drives headless Chrome over CDP)
//        node scripts/screenshots.mjs [scene ...]   (only the listed scenes; default: all)
// Needs Chrome/Edge (set CHROME=/path/to/chrome if it is not found). Always renders the English UI.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PORT = 4173;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}/`;
const STATE_KEY = 'rpgweb.studio.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scene catalogue: file name, README alt text feature name, README layout slot. */
const SCENES = [
  { id: 'battle', title: 'Crowded battle', hero: true },
  { id: 'home', title: 'Home page' },
  { id: 'comedy', title: 'Comedy physics' },
  { id: 'maps', title: 'Map gallery' },
  { id: 'units', title: 'Unit gallery with attack previews' },
  { id: 'studio', title: 'Army studio' },
  { id: 'lobby', title: 'Online lobby' },
  { id: 'placement', title: 'Online placement' },
  { id: 'mobile-studio', title: 'Mobile bottom sheet', mobile: true },
  { id: 'mobile-battle', title: 'Mobile battle HUD', mobile: true },
];

// ---------------------------------------------------------------------------------------------- helpers
function findChrome() {
  const c = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = c.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found; set the CHROME environment variable');
  return found;
}

async function waitHttp(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) this.waiters = this.waiters.filter((w) => !(w.method === m.method && (w.res(m.params), true)));
    };
  }
  static async open() {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const t = await r.json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
    });
    const p = new Page(ws);
    await p.send('Page.enable');
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  once(method) {
    return new Promise((res) => this.waiters.push({ method, res }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async viewport(w, h, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await this.send('Emulation.setEmitTouchEventsForMouse', { enabled: mobile });
  }
  /** Opens `url`; the game starts on the home page, so by default "Your own simulation" is clicked to reach the studio. */
  async nav(url, toStudio = true) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(2500);
    if (toStudio) {
      await this.eval(`document.getElementById('m-own')?.click()`);
      await sleep(1200);
    }
  }
  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(60);
  }
  async move(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }
  async shot(id) {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 84 });
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${id}.jpg`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  saved ${path.relative(ROOT, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

/** Reads the saved studio state, multiplies every unit into a crowd (k copies on a spiral) and writes it back. */
const AMPLIFY = (k, extra) => `(() => {
  const KEY = ${JSON.stringify(STATE_KEY)};
  const s = JSON.parse(localStorage.getItem(KEY));
  const size = s.mapSize;
  const out = [];
  for (const u of s.units) {
    for (let i = 0; i < ${k}; i++) {
      if (i === 0) { out.push(u); continue; }
      const a = i * 2.399963, r = 0.95 * Math.sqrt(i);
      const x = Math.min(size - 1, Math.max(1, u.x + Math.cos(a) * r)), y = Math.min(size - 1, Math.max(1, u.y + Math.sin(a) * r));
      out.push({ team: u.team, kind: u.kind, x, y });
    }
  }
  s.units = out;
  Object.assign(s, ${JSON.stringify(extra.state ?? {})});
  s.options = Object.assign(s.options || {}, ${JSON.stringify(extra.options ?? {})});
  s.map = Object.assign(s.map || {}, ${JSON.stringify(extra.map ?? {})});
  localStorage.setItem(KEY, JSON.stringify(s));
  return out.length;
})()`;

async function crowdPage(page, { k, state, options, map }) {
  await page.nav(`${BASE}?lang=en&debug=1&tour=off`);
  await page.eval(`document.getElementById('quick').click()`);
  await sleep(700);
  const n = await page.eval(AMPLIFY(k, { state, options, map }));
  console.log(`  crowd: ${n} soldiers`);
  await page.nav(`${BASE}?lang=en&debug=1&tour=off`);
}

/** Hides the statistics panel and hint, zooms in and centres the camera on the middle of the living units. */
const FOCUS = (zoom) => `(() => {
  document.getElementById('stats').style.display = 'none';
  const hint = document.querySelector('.hud-hint'); if (hint) hint.style.display = 'none';
  const u = window.__sim.units;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < u.count; i++) if (u.alive[i]) { sx += u.x[i]; sy += u.y[i]; n++; }
  const cx = sx / n, cy = sy / n;
  window.__camera.x = (cx - cy) * 32;
  window.__camera.y = (cx + cy) * 16;
  window.__camera.zoomBy(${zoom});
})()`;

// ---------------------------------------------------------------------------------------------- scenes
const scenes = {
  async battle(page) {
    await page.viewport(1600, 900);
    await crowdPage(page, { k: 34, state: { mapSize: 80, speed: 2 }, options: { comedyVisual: false, fx: 'high', numbers: false }, map: { biome: 'snow', layout: 'classic', relief: 'hills', river: 'winding' } });
    await page.eval(`document.getElementById('start').click()`);
    await sleep(8000);
    await page.eval(FOCUS(2.4));
    await sleep(900);
    await page.shot('battle');
  },
  async comedy(page) {
    await page.viewport(1600, 900);
    await crowdPage(page, { k: 10, state: { mapSize: 56, speed: 1 }, options: { comedyVisual: true, comedyPhysics: true, fx: 'high' }, map: { biome: 'forest', layout: 'classic', relief: 'flat' } });
    await page.eval(`document.getElementById('start').click()`);
    await sleep(5500);
    await page.eval(FOCUS(3.2));
    await sleep(500);
    await page.shot('comedy');
  },
  async home(page) {
    await page.viewport(1600, 900);
    await page.nav(`${BASE}?lang=en&debug=1&tour=off`, false);
    await page.shot('home');
  },
  async maps(page) {
    await page.viewport(1600, 900);
    await page.nav(`${BASE}?lang=en&debug=1&tour=off`);
    await page.eval(`document.getElementById('map-btn').click()`);
    await sleep(2500);
    await page.shot('maps');
  },
  async units(page) {
    await page.viewport(1600, 900);
    await page.nav(`${BASE}?lang=en&debug=1&tour=off`);
    await page.eval(`document.getElementById('gallery-btn').click()`);
    await sleep(1500);
    await page.eval(`document.querySelector('[data-r="epic"]').click()`);
    await sleep(4000);
    await page.shot('units');
  },
  async studio(page) {
    await page.viewport(1600, 900);
    await crowdPage(page, { k: 6, state: { mapSize: 56 }, options: {}, map: { biome: 'desert', layout: 'classic', relief: 'hills' } });
    await sleep(800);
    await page.shot('studio');
  },
  async lobby(page, ctx) {
    const { host } = await onlineSession(ctx, page);
    await page.shot('lobby');
    ctx.host = host;
  },
  async placement(page0, ctx) {
    if (!ctx.guest) await onlineSession(ctx, page0);
    const page = ctx.host ?? page0;
    const { guest } = ctx;
    await page.eval(`document.getElementById('l-start').click()`);
    await sleep(2500);
    for (const p of [page, guest]) await p.eval(`document.querySelector('#pg-brush button:nth-child(3)')?.click()`);
    const spots = [[470, 340], [540, 420], [450, 500], [610, 380], [520, 560], [640, 480], [420, 420], [580, 300], [500, 460], [690, 400]];
    for (const [x, y] of spots) {
      await page.click(x, y);
      await guest.click(1600 - x, y);
    }
    await sleep(5000); // let the "outside your zone" toast fade
    await page.shot('placement');
  },
  async 'mobile-studio'(page) {
    await page.viewport(390, 844, true);
    await crowdPage(page, { k: 5, state: { mapSize: 56 }, options: {}, map: { biome: 'forest', layout: 'classic', relief: 'flat' } });
    await page.viewport(390, 844, true);
    await sleep(900);
    await page.eval(`window.__camera.zoomBy(1.5); window.__camera.y += (innerHeight * 0.27) / window.__camera.zoom; document.querySelector('.sheet-handle').click();`);
    await sleep(900);
    await page.shot('mobile-studio');
  },
  async 'mobile-battle'(page) {
    await page.viewport(390, 844, true);
    await crowdPage(page, { k: 8, state: { mapSize: 56, speed: 1 }, options: { fx: 'low', numbers: false }, map: { biome: 'snow', layout: 'classic', relief: 'hills' } });
    await page.viewport(390, 844, true);
    await page.eval(`document.getElementById('start').click()`);
    await sleep(6500);
    await page.eval(FOCUS(3.4));
    await sleep(700);
    await page.shot('mobile-battle');
  },
};

/** Hosts a LAN lobby in `page` and joins it from a second page (ctx.guest); returns when both are in the lobby (guest ready). */
async function onlineSession(ctx, page) {
  await page.viewport(1600, 900);
  await page.nav(`${BASE}?lang=en&debug=1&tour=off`, false);
  await page.eval(`(async () => {
    document.getElementById('m-name').value = 'Ayla';
    document.querySelector('#m-tp [data-tp="lan"]').click();
    document.getElementById('m-host').click();
    await new Promise((r) => setTimeout(r, 2000));
  })()`);
  const code = await page.eval(`document.getElementById('l-code').textContent`);
  const guest = await Page.open();
  ctx.guest = guest;
  await guest.viewport(1600, 900);
  await guest.nav(`${BASE}?lang=en&debug=1&tour=off`, false);
  await guest.eval(`(async () => {
    document.getElementById('m-name').value = 'Bora';
    document.getElementById('m-code').value = ${JSON.stringify(code)};
    document.getElementById('m-join').click();
    await new Promise((r) => setTimeout(r, 2500));
    document.getElementById('l-ready')?.click();
  })()`);
  await sleep(1200);
  // A recognisable lobby: a fixed map card, more gold, open placement.
  return { host: page, guest };
}

// ---------------------------------------------------------------------------------------------- README
function readmeBlock() {
  const by = Object.fromEntries(SCENES.map((s) => [s.id, s]));
  const alt = (id) => `v${VERSION} — ${by[id].title}`;
  const img = (id, w) => `<img src="docs/screenshots/${id}.jpg" alt="${alt(id)}"${w ? ` width="${w}"` : ''} />`;
  const cell = (id, w) => `<td align="center">${img(id, w)}<br /><sub>${by[id].title}</sub></td>`;
  return [
    '<!-- screenshots:start (generated by `npm run screenshots`) -->',
    '<p align="center">',
    `  <img src="docs/screenshots/battle.jpg" alt="${alt('battle')}" />`,
    '</p>',
    '',
    '<table>',
    `  <tr>${cell('home', 460)}${cell('comedy', 460)}</tr>`,
    `  <tr>${cell('maps', 460)}${cell('units', 460)}</tr>`,
    `  <tr>${cell('studio', 460)}${cell('lobby', 460)}</tr>`,
    `  <tr>${cell('placement', 460)}</tr>`,
    `  <tr><td colspan="2" align="center">${img('mobile-studio', 200)} ${img('mobile-battle', 200)}<br /><sub>Mobile: bottom sheet and battle HUD</sub></td></tr>`,
    '</table>',
    '<!-- screenshots:end -->',
  ].join('\n');
}

function updateReadme() {
  const p = path.join(ROOT, 'README.md');
  let s = fs.readFileSync(p, 'utf8');
  const re = /<!-- screenshots:start[\s\S]*?<!-- screenshots:end -->/;
  if (!re.test(s)) {
    console.log('README has no screenshots markers; skipping README update');
    return;
  }
  const crlf = s.includes('\r\n');
  const block = readmeBlock();
  s = s.replace(re, crlf ? block.replace(/\n/g, '\r\n') : block);
  fs.writeFileSync(p, s);
  console.log('README screenshots block updated');
}

// ---------------------------------------------------------------------------------------------- main
async function main() {
  const wanted = process.argv.slice(2);
  const todo = SCENES.filter((s) => wanted.length === 0 || wanted.includes(s.id));
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('dist/ missing: run `npm run build` first');

  const preview = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgweb-shot-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${tmp}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--disable-extensions',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--window-size=1600,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const cleanup = () => {
    for (const c of [chrome, preview]) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
        else c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* busy */
    }
  };
  process.on('exit', cleanup);
  try {
    await waitHttp(BASE);
    await waitHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const ctx = {};
    for (const s of todo) {
      console.log(`scene: ${s.id}`);
      const page = await Page.open();
      try {
        await scenes[s.id](page, ctx);
      } finally {
        if (s.id !== 'lobby') page.close();
        if (s.id === 'placement') ctx.host?.close();
      }
      if (s.id === 'placement') ctx.guest?.close();
    }
    if (todo.length === SCENES.length) updateReadme();
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
