# Testing

| Command | What | Time |
|---|---|---|
| `npm run check` | tsc + repo policy check + all tests (CI runs this) | minutes |
| `npm run check:fast` | tsc + repo check + fast tests | ~10 s |
| `npm run test:fast` | fast vitest subset (no fuzz/balance) | ~5 s |
| `npm run test:net` | net, lan, chunk, online setup | fast |
| `npm run test:sim` | simulation suites | medium |
| `npm run balance:quick` | headless gold-equal tournament, writes `.balance/quick.txt` | ~15 s |
| `npm run balance` | full tournament (2 maps, 2 seeds) | ~1 min |
| `npm run lint:repo` | forbidden terms, Turkish in code, license notices, README images | instant |

Tests live in `src/sim/__tests__` (Vitest, Node). Prefer pure-logic tests; see `.claude/rules/tests.md`.
