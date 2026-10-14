import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachLan } from './scripts/lan.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Gelistirme sunucusuna da LAN/WebSocket lobi odalarini ekler (/ws). */
const lanPlugin = (): Plugin => ({
  name: 'rpgweb-lan',
  configureServer(server) {
    if (server.httpServer) attachLan(server.httpServer);
  },
  configurePreviewServer(server) {
    attachLan(server.httpServer);
  },
});

// SharedArrayBuffer (sim worker) requires cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Relative base: dist/ works from any subdirectory (GitHub Pages, local server).
  base: './',
  // The version shown on screen always comes from package.json.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [lanPlugin()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  // Two pages: the game and the 3D prototype (/3d/).
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), view3d: fileURLToPath(new URL('./3d/index.html', import.meta.url)) } } },
});
