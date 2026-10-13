# Contributing

Contributions are welcome: bug fixes, balance and gameplay improvements, translations, tests and documentation. The project is
**source-available but closed to commercial use** (see [`LICENSE`](LICENSE): PolyForm Noncommercial 1.0.0 plus additional terms).
Your contribution goes to the official project; the right to use it commercially stays with the project owner.

## Before you start

1. **Read the license and the CLA:** [`LICENSE`](LICENSE) and [`CLA.md`](CLA.md). By opening a pull request and ticking the CLA
   box in the template you accept the CLA. Pull requests without the CLA are not merged.
2. **Open an issue first** (especially for large changes): describe what you want to do, get a go-ahead, then work on it.
   Small bug fixes can go straight to a pull request.
3. **Original content only.** Do not copy code, art, sound, unit names, statistics or text from other games or sources. Third-party
   libraries must be license-compatible and listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Development

```bash
git clone https://github.com/gkaragoz/rpg-web-strategy.git
cd rpg-web-strategy
npm install
npm run dev       # http://localhost:5173
npm run check     # tsc --noEmit + tests (must pass before a PR)
```

- **Code style:** follow the existing files (TypeScript, strict types, short English comments). Do not add unnecessary dependencies; for a
  new dependency explain why in the issue (pinned version).
- **Language:** code, comments, commit messages and documentation are in **English**. The game UI is bilingual (English + Türkçe): add UI
  text through the tables in `src/i18n/` (both languages) and use `t('area.key')`; never hard-code UI strings. `npm test` checks that
  both tables stay in sync. Translations into new languages are welcome (open an issue first).
- **The simulation (`src/sim`) is deterministic:** online play relies on every client producing the same result. Do not introduce
  nondeterministic sources such as `Math.random`, `Date.now` or `performance.now` into the simulation path; use `Mulberry` for randomness.
  Pull requests that change the simulation must keep `src/sim/__tests__/determinism.test.ts` and the `net*.test.ts` files green.
- **Tests:** add a test for every bug fix or feature when possible (`src/sim/__tests__`).
- **Online / network code** (`src/net`, `src/app/online`, `relay/`): if you change the protocol, bump `PROTOCOL`.
- **Mobile:** try UI changes on a narrow screen (≈ 380 px, portrait and landscape) and with touch.

## Pull request process

1. Fork → create a branch (`fix/...`, `feat/...`) → small, focused commits.
2. `npm run check` must be clean.
3. Fill in the pull request template and **tick the CLA box**.
4. After review it is merged. The project owner may change or reject a contribution.

## Security

If you find a security issue, do not open a public issue; contact the project owner privately through the GitHub profile.

## Conduct

Be respectful. Personal attacks, harassment and discrimination are not accepted and may end your right to contribute.
