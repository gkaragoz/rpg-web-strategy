// Minimal headless-Chrome driver over the DevTools protocol (no dependencies), shared by the e2e and visual tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const c = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = c.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found; set the CHROME environment variable');
  return found;
}

export async function waitHttp(url, ms = 30000) {
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

/** Polls `fn` until it returns a truthy value (or throws after `ms`). */
export async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timeout: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

export class Page {
  constructor(ws, debugPort) {
    this.ws = ws;
    this.debugPort = debugPort;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    /** Console errors, uncaught exceptions and failed loads seen so far. */
    this.errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.exceptionThrown') this.errors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
        this.waiters = this.waiters.filter((w) => !(w.method === m.method && (w.res(m.params), true)));
      }
    };
  }

  static async open(debugPort) {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const t = await r.json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
    });
    const p = new Page(ws, debugPort);
    p.targetId = t.id;
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    return p;
  }

  /**
   * Opens the page in its own browser window. Tabs of one window are hidden while another tab is in front and get no animation
   * frames, which stalls a battle driven by the frame loop; every window is visible, so several windows run side by side.
   */
  static async openWindow(debugPort, width = 1000, height = 640) {
    const ver = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      bws.onopen = res;
      bws.onerror = () => rej(new Error('browser ws error'));
    });
    const r = await new Promise((res) => {
      bws.onmessage = (e) => res(JSON.parse(e.data));
      bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true, width, height } }));
    });
    bws.close();
    const targetId = r.result.targetId;
    let t;
    for (let i = 0; i < 50 && !t; i++) {
      t = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((x) => x.id === targetId);
      if (!t) await sleep(100);
    }
    if (!t) throw new Error('new window did not appear');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
    });
    const p = new Page(ws, debugPort);
    p.targetId = targetId;
    await p.send('Page.enable');
    await p.send('Runtime.enable');
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

  /** Opens `url` and waits for the home menu (or the studio) to exist. */
  async nav(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await this.waitFor(`!!document.querySelector('#m-own')`, 'home menu to load', 30000);
  }

  waitFor(expression, what, ms = 15000) {
    return until(() => this.eval(expression), what, ms);
  }

  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(60);
  }

  /** Clicks the centre of the first element matching `selector`. */
  async clickSel(selector) {
    const r = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    if (!r) throw new Error(`no element: ${selector}`);
    await this.click(r[0], r[1]);
  }

  /** Presses a key (`code` like KeyU); `modifiers` is the CDP bit field (1 alt, 2 ctrl, 4 meta, 8 shift). */
  async key(key, code, modifiers = 0) {
    const base = { key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key.length === 1 && !(modifiers & 2)) await this.send('Input.dispatchKeyEvent', { type: 'char', text: key, ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(60);
  }

  async shotBuffer() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }

  close() {
    try {
      this.ws.close();
      fetch(`http://127.0.0.1:${this.debugPort}/json/close/${this.targetId}`).catch(() => undefined);
    } catch {
      /* closed */
    }
  }
}

/** Starts `vite preview` on `dist/` (or `dist` / E2E_DIST) and a headless Chrome; returns helpers and a `stop()` that kills only what it started. */
export async function startStack({ port = 4310, debugPort = 9360, width = 1280, height = 800, dist = process.env.E2E_DIST || path.join(ROOT, 'dist') } = {}) {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`${dist} missing: run \`npm run build\` first`);
  const preview = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--outDir', dist], { cwd: ROOT, stdio: 'ignore' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgweb-e2e-'));
  const chrome = spawn(
    findChrome(),
    ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${tmp}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-extensions', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--window-size=${width},${height}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  const pages = [];
  const stop = () => {
    for (const p of pages) p.close();
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
  process.on('exit', stop);
  try {
    await waitHttp(`http://127.0.0.1:${port}/`);
    await waitHttp(`http://127.0.0.1:${debugPort}/json/version`);
  } catch (e) {
    stop();
    throw e;
  }
  return {
    base: `http://127.0.0.1:${port}/`,
    stop,
    async page(opts = {}) {
      const p = opts.window ? await Page.openWindow(debugPort, opts.width, opts.height) : await Page.open(debugPort);
      pages.push(p);
      if (opts.width) await p.viewport(opts.width, opts.height, !!opts.mobile);
      return p;
    },
  };
}
