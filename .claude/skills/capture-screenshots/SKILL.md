---
name: capture-screenshots
description: Regenerate README screenshots (headless Chrome over CDP) and the README gallery block.
---

# Capture screenshots

- Everything: `npm run screenshots` (build + all scenes).
- One scene: `npm run build`, then `node scripts/screenshots.mjs <scene>` — scenes: battle, comedy, maps, units, studio, lobby, placement, mobile-studio, mobile-battle.
- Output: `docs/screenshots/*.jpg` and the README block between the `screenshots:start/end` markers; alt text is `v<version> — <feature>`.
- Needs Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` (override with `CHROME_PATH`).
- Look at the images afterwards (Read tool) before committing; keep total size small.
