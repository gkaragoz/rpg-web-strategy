import { defineConfig, type Plugin } from 'vite';
import { attachLan } from './scripts/lan.mjs';

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
  plugins: [lanPlugin()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
});
