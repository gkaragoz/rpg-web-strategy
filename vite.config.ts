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

// SharedArrayBuffer (sim worker) icin cross-origin isolation gerekir.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Goreli taban: dist/ herhangi bir alt dizinde (GitHub Pages, yerel sunucu) calisir.
  base: './',
  plugins: [lanPlugin()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
});
