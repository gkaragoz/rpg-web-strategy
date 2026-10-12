import { defineConfig } from 'vite';

// SharedArrayBuffer (sim worker) icin cross-origin isolation gerekir.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Goreli taban: dist/ herhangi bir alt dizinde (GitHub Pages, yerel sunucu) calisir.
  base: './',
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
});
