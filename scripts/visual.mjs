#!/usr/bin/env node
// Visual regression: fixed-seed screenshots compared with the committed baselines in tests/visual/*.png.
// Usage: npm run build && npm run test:visual            compare (fails when more than TOLERANCE of the pixels differ)
//        npm run build && npm run test:visual -- --update  rewrite the baselines (review the images before committing them)
// Baselines depend on the renderer: they are made with Chrome's software GL (SwiftShader) at fixed viewports; small anti-aliasing
// differences between machines are absorbed by the per-channel threshold and the pixel-ratio tolerance.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startStack } from './lib/browser.mjs';
import { compare, readPng, writePng } from './lib/png.mjs';

const DIR = path.join(ROOT, 'tests', 'visual');
const OUT = path.join(ROOT, 'test-results', 'visual');
const update = process.argv.includes('--update');
const TOLERANCE = 0.01; // share of changed pixels that is still accepted

// ---------------------------------------------------------------------------------------------- scenes
const scenes = [
  {
    name: 'home-desktop',
    viewport: [1280, 800, false],
    async run(page, base) {
      await page.nav(`${base}?lang=en&view=2d&tour=off`);
      await sleep(800);
    },
  },
  {
    name: 'studio-2d',
    viewport: [1280, 800, false],
    async run(page, base) {
      await page.nav(`${base}?lang=en&view=2d&tour=off&seed=7`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await sleep(1500);
    },
  },
  {
    name: 'studio-mobile',
    viewport: [390, 844, true],
    async run(page, base) {
      await page.nav(`${base}?lang=en&view=2d&tour=off&seed=7`);
      await page.eval(`document.querySelector('#m-own').click()`); // CDP mouse events never settle on a touch-emulated page
      await page.waitFor(`!!document.querySelector('#start')`, 'studio');
      await sleep(1500);
    },
  },
  {
    name: 'tour-step',
    viewport: [1280, 800, false],
    async run(page, base) {
      await page.nav(`${base}?lang=en&view=2d&seed=7`);
      await page.eval(`localStorage.removeItem('rpgweb.tour.studio')`);
      await page.clickSel('#m-own');
      await page.waitFor(`!!document.querySelector('.tour-balloon')`, 'tour balloon', 15000);
      await sleep(400);
    },
  },
];

// ---------------------------------------------------------------------------------------------- main
const stack = await startStack({ port: 4311, debugPort: 9361 });
let failed = 0;
try {
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const s of scenes) {
    const page = await stack.page({ width: s.viewport[0], height: s.viewport[1], mobile: s.viewport[2] });
    try {
      await s.run(page, stack.base);
      // The game canvas animates (idle poses, water): compare the DOM interface only, with animations and canvases frozen.
      await page.eval(`(() => { document.querySelectorAll('canvas').forEach((c) => (c.style.visibility = 'hidden')); const st = document.createElement('style'); st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.app-ver{visibility:hidden!important}'; document.head.appendChild(st); })()`);
      await sleep(300);
      const shot = readPng(await page.shotBuffer());
      const file = path.join(DIR, `${s.name}.png`);
      if (update || !fs.existsSync(file)) {
        fs.writeFileSync(file, writePng(shot));
        console.log(`${update ? 'UPDATED' : 'NEW'}  ${s.name}`);
        continue;
      }
      const { ratio, diff, sizeMismatch } = compare(shot, readPng(fs.readFileSync(file)));
      if (sizeMismatch || ratio > TOLERANCE) {
        failed++;
        fs.writeFileSync(path.join(OUT, `${s.name}.actual.png`), writePng(shot));
        if (diff) fs.writeFileSync(path.join(OUT, `${s.name}.diff.png`), writePng(diff));
        console.log(`FAIL  ${s.name}: ${sizeMismatch ? 'size changed' : `${(ratio * 100).toFixed(2)} % of pixels differ (limit ${TOLERANCE * 100} %)`}; see test-results/visual/`);
      } else console.log(`PASS  ${s.name} (${(ratio * 100).toFixed(3)} % differ)`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${s.name}: ${e.message}`);
    } finally {
      page.close();
    }
  }
} finally {
  stack.stop();
}
process.exit(failed ? 1 : 0);
