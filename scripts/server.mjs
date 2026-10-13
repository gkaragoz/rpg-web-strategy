#!/usr/bin/env node
// Dependency-free static server: serves a directory with COOP/COEP headers (for SharedArrayBuffer / the worker sim).
// Usage: node server.mjs [dizin] [--port 5174] [--open] [--lan]
//   --lan: let other devices on the network connect (0.0.0.0) and print the LAN addresses; the /ws path routes LAN lobby rooms.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { attachLan } from './lan.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const here = fileURLToPath(new URL('.', import.meta.url));
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const root = resolve(positional[0] ?? (existsSync(join(here, 'app')) ? join(here, 'app') : here));
const basePort = Number(opt('--port', '5174'));
let port = basePort;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const decoded = decodeURIComponent(url.pathname);
    // Escaping to a parent directory (path traversal) is blocked.
    let rel = normalize(decoded).split(sep).filter((p) => p && p !== '..' && p !== '.').join(sep);
    let file = join(root, rel);
    if (!file.startsWith(root)) file = join(root, 'index.html');
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = join(file, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st) {
      file = join(root, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

attachLan(server);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* if the browser cannot be opened, the address is printed anyway */
  }
}

function listen() {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < basePort + 20) {
      port++;
      listen();
    } else {
      console.error('Could not start the server:', e.message);
      process.exit(1);
    }
  });
  const lan = flag('--lan');
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`\n  RPG Web - Battle Studio\n  ${url}`);
    if (lan) for (const ip of lanAddresses()) console.log(`  LAN address: http://${ip}:${port}/   <- your friends should open this`);
    console.log('  (press Ctrl+C to stop)\n');
    if (flag('--open')) openBrowser(url);
  });
}
listen();
