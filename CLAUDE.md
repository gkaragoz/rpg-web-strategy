# RPG Web — Battle Studio

Browser isometric auto-battle game (PixiJS v8 + Vite + TypeScript, Vitest). Up to 6 teams, 49 units, random maps, online play (LAN / Cloudflare relay / WebRTC), mobile touch UI, bilingual UI (English default + Türkçe). License: PolyForm Noncommercial 1.0.0 + CLA (see `LICENSE`, `CONTRIBUTING.md`). Live: https://gkaragoz.github.io/rpg-web-strategy/

## Commands
| Command | Use |
|---|---|
| `npm run dev` | dev server on :5173 (also serves the LAN lobby socket `/ws`) |
| `npm run check:fast` | tsc + repo rules + the fast tests (~15 s) — **run this after every change** |
| `npm run check` | tsc + repo rules + the full test suite (~90 s; before a commit/PR) |
| `npm run test:net` / `test:sim` | online-stack tests / simulation tests only |
| `npm run lint:repo` | forbidden terms, Turkish-in-code, README images (`scripts/check-repo.mjs`) |
| `npm run build` | tsc + production build into `dist/` |
| `npm run screenshots` | rebuild + regenerate `docs/screenshots/*` and the README block (headless Chrome) |
| `BALANCE=1 npx vitest run src/sim/__tests__/balance.test.ts` | roster win-rate table → `test-results/balance.txt` |

## Repo map (open files by purpose; big files: search with Grep, do not read whole)
- `src/sim/` — pure deterministic simulation (also runs in Node/tests). `battle.ts` (2.5k lines: AI, skills, physics — grep for the skill id or method), `terrain.ts` (1k, map generation), `units.ts` (stats, `KIND_OF_TROOP`, `TAG_OF`), `mapSpec.ts` (map recipes/presets), `data/troops.ts` (roster) + `data/skills.ts` (skill numbers), `testing/` (scenario + stall detector helpers), `__tests__/`.
- `src/render/` — PixiJS drawing: `unitView.ts` (detailed unit, `POSE_STATES`), `looks.ts` (1.1k: one drawing recipe per roster unit id), `atlas.ts` (baked textures), `massRenderer.ts` (crowds), `fx.ts`, `comedy.ts`, `audio.ts`.
- `src/app/` — DOM UI: `studio.ts` (+ `studio.css`, all CSS lives here), `battle.ts` (battle scene + HUD), `editor.ts` (placement), `mapPicker.ts`, `unitGallery.ts` + `unitPreview.ts` (animated attack previews), `unitSettings.ts`, `langPicker.ts`, `sheet.ts` (mobile bottom sheet), `bottomStack.ts`, `state.ts`; `online/` — `online.ts` (OnlineApp: menu → lobby → placement → battle), `screens.ts`, `placement.ts`, `cursors.ts`, `chat.ts`, `badge.ts`.
- `src/net/` — `protocol.ts` (messages, `PROTOCOL` version), `host.ts` (authoritative lobby state machine), `client.ts`, `lockstep.ts`, `transport.ts`/`wsTransport.ts`/`peerTransport.ts`, `chunk.ts` (large-message splitting), `economy.ts` (gold costs, zones).
- `src/i18n.ts` + `src/i18n/*.ts` — UI strings (`t('area.key')`). `src/main.ts` — wiring/bootstrap.
- `relay/` — Cloudflare Worker + Durable Object relay. `scripts/` — installers, `server.mjs`/`lan.mjs` (local server), `screenshots.mjs`, `check-repo.mjs`, `hooks/guard.mjs`. `docs/` — architecture notes. `.claude/` — rules, skills, agents.

## Rules (enforced by tests, `lint:repo` and a Claude hook)
1. **English** for code, comments, commit messages, docs. UI text only through `src/i18n/*.ts` with both `en` and `tr` entries; never hard-code UI strings.
2. **No references to any third-party game or its data** anywhere (the roster is original). Do not copy names/stats/text from other games.
3. **Determinism** (`src/sim`): no `Math.random`, `Date.now`, `performance.now`; use the `Mulberry` RNG. Online play depends on identical results on every client.
4. **Protocol**: changing a message shape in `src/net/protocol.ts` ⇒ bump `PROTOCOL`; host sends machine codes, clients translate with `t()`.
5. Keep the "© gkaragoz and Contributors" notice and the license files; contributions need the CLA.
6. Run `npm run check:fast` after edits and the full `npm run check` before committing. Add or update a test for every bug fix.
7. Never `git push --force`, rewrite history, or delete releases/tags without the user's explicit request.

## Conventions
- Strict TypeScript, no unused locals. Prefer small pure helpers that can be unit tested (see `previewOverlay.ts`, `chunk.ts`).
- Mobile matters: check UI changes at ~390 px and with touch (`(pointer: coarse)` and `(max-width: 760px)` blocks at the end of `studio.css`).
- Commit messages: short imperative English subject. Releases: bump `package.json` + `package-lock.json`, run `npm run screenshots` if visuals changed, `git tag vX.Y.Z && git push origin vX.Y.Z` (the `release` workflow builds the zip + Pages).

## Gotchas (learned the hard way)
- Git Bash heredocs mangle backslashes and long content: write files with the Write tool.
- In Python, `open(p, 'w').write(open(p).read()…)` truncates the file first — read before opening for write.
- The dev server listens on IPv6 `::1` only; `adb reverse` needs a small TCP proxy to `127.0.0.1`.
- Many files are CRLF, some LF; edit tools keep each file's style — do not mass-renormalize.
- The Vite dev server can cache an empty module if a file is rewritten non-atomically; restart it (`preview_stop`/`preview_start`).
- `node scripts/screenshots.mjs <scene>` does not rebuild `dist/` (only `npm run screenshots` does): run `npm run build` first.
- More detail: `docs/ARCHITECTURE.md`, `docs/SIMULATION.md`, `docs/ONLINE.md`, `docs/UI.md`, `docs/UNITS.md`, `docs/TESTING.md`, `docs/RELEASING.md`. Skills: `.claude/skills/*`.
