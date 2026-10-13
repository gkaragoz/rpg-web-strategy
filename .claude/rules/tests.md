---
paths:
  - "src/sim/__tests__/**"
---

# Writing tests

- Vitest, Node environment, no DOM. Put new tests in `src/sim/__tests__/<topic>.test.ts`; titles and messages in English.
- Prefer pure logic tests (helpers such as `previewOverlay.ts`, `chunk.ts`, `gestureStep`) over mocking the DOM or Pixi.
- Simulation scenarios: `src/sim/testing/scenarios.ts` (`makeScenario`, `makeRosterScenario`), `runScenario` + stall detector in `src/sim/testing/stall.ts`.
- Online tests use `LoopbackHub`/`HostLobby`/`HostSession`/`GuestSession` (see `net.test.ts`, `netedge.test.ts`); fuzz tests are seeded — keep them deterministic.
- Slow suites (fuzz, rosterfuzz, comedy, mapSpec, troops, determinism, …) are excluded from `npm run test:fast`; run the full `npm run check` before committing.
- Never assert localized UI text; assert keys/codes. `i18n.test.ts` guards parity between English and Turkish tables.
