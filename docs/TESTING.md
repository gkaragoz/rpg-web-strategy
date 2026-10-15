# Testing

| Command | What | Time |
|---|---|---|
| `npm run check` | tsc + repo policy + layer/cycle check + all tests (CI runs this) | minutes |
| `npm run check:fast` | tsc + repo check + layer check + fast tests | ~20 s |
| `npm run test:fast` | fast vitest subset (no fuzz/balance) | ~5 s |
| `npm run test:net` | net, lan, chunk, online setup | fast |
| `npm run test:sim` | simulation suites | medium |
| `npm run test:golden` | committed simulation hashes only | seconds |
| `npm run test:cov` | all tests with V8 coverage (`coverage/`, text summary + lcov) | minutes |
| `npm run e2e` | real headless Chrome against `dist/` (build first): 2D/3D, gallery key EN/TR, painting, battle, mobile overflow, LAN pair | ~1-3 min |
| `npm run test:visual` | pixel diff of fixed screenshots against `tests/visual/*.png` (`--update` rewrites the baselines) | ~1 min |
| `npm run balance:quick` | headless gold-equal tournament, writes `.balance/quick.txt` | ~15 s |
| `npm run balance` | full tournament (2 maps, 2 seeds) | ~1 min |
| `npm run lint:repo` / `lint:layers` | forbidden terms, Turkish in code, license notices / layer rules and import cycles | instant |

Unit tests live in `src/sim/__tests__` (Vitest, Node, no DOM). Prefer pure-logic tests; see `.claude/rules/tests.md`.

**Golden hashes** (`golden.test.ts` + `golden.json`): fixed scenarios must produce the committed hashes. A refactor must not change them. For an intended sim change run `GOLDEN_UPDATE=1 npx vitest run src/sim/__tests__/golden.test.ts` and commit the new `golden.json` with the change.

**Browser tests** (`scripts/e2e.mjs`, `scripts/visual.mjs`, helpers in `scripts/lib/browser.mjs`) start their own `vite preview` (ports 4310/4311, debug 9360/9361) and Chrome and stop only those processes; set `CHROME=/path/to/chrome` if it is not found. Open pages with `?debug=1&tour=off` (hooks on, no first-run tour). `E2E_DIST=/path` serves another build output instead of `dist/`. Tabs of one window are hidden (no animation frames, so a battle stalls): tests that run a battle on several pages open them with `stack.page({ window: true })`. `?debug=0` keeps the debug handles but runs the sim in the worker (the default player path); `?debug=1` forces the main-thread sim.

`scripts/e2e-mobile.mjs` (imported by `e2e.mjs`, tests named `mobile-*`) runs the game-mode screens on emulated phones (portrait and landscape, English and Turkish): no horizontal overflow, mode cards / rule text / siege chooser not clipped, tap targets >= 40 px, VIP pick by a real touch tap, objective strip clear of the team bar, damage meter, stats panel and bottom bar. CDP mouse clicks never settle on a touch-emulated page, so those tests click through the DOM or send CDP touch events.

CI: the `fast` job runs `check:fast` on every push/PR; the `full` job runs `check`, `build`, the bundle budget and coverage; browser tests run in the `e2e` workflow (nightly and manually).
