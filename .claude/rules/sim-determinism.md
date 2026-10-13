---
paths:
  - "src/sim/**"
---

# Simulation rules (deterministic lockstep)

Online play runs the same simulation on every client from the same seed + layout and only sends commands; a checksum every 60 steps catches divergence. So:

- No `Math.random()`, `Date.now()`, `performance.now()`, iteration over unordered `Map/Set` with side effects, or floating-point results that depend on call order differences between clients. Use `Mulberry` (`src/sim/random.ts`); its state is part of the snapshot.
- Anything that changes simulation results for the same inputs (new skill, changed numbers) also changes replays — that is fine, but online clients must run the same build (bump `PROTOCOL` only when the wire format changes).
- New persistent simulation state must be added to `Battle.serialize/restore/hash` (`src/sim/battle.ts`) and covered by `src/sim/__tests__/determinism.test.ts`.
- Hot loops use typed arrays (SoA in `Units`/`Projectiles`); do not allocate per step.
- `src/sim` must not import from `src/app`, `src/render` or the DOM; it also runs in Node tests and a Web Worker.
- After changes run `npm run test:sim` (skills, troops, edge, terrain, determinism, crowd, comedy, economy, mapSpec).
