---
paths:
  - "src/net/**"
  - "src/app/online/**"
  - "relay/**"
  - "scripts/lan.mjs"
---

# Online stack rules

- Star topology: the host's `HostLobby` (`src/net/host.ts`) is authoritative (settings, zones, gold budgets, team ids); guests send intents, the host validates. Never trust a guest message shape: validate types, clamp numbers; `HostLobby.handle` also rate-limits and wraps handlers in try/catch.
- Wire format: JSON over WebSocket (LAN `scripts/lan.mjs`, relay `relay/src/index.js`) or WebRTC (PeerJS). Large messages are split by `src/net/chunk.ts` (≈200 KB pieces; the relay limit is ~1 MB). Changing any message type/shape ⇒ bump `PROTOCOL` in `src/net/protocol.ts` and update `net*.test.ts`.
- Team numbers are fixed when placement starts; a player who leaves mid-game stays as a disconnected "ghost" (no re-teaming). Spectators have `team = -1`.
- `OnlineApp` (`src/app/online/online.ts`) drives screens from the lobby phase (`reconcile`/`go`); every async step must re-check `this.dead`. Screen setup failures call `setupFailed` (toast + rejoinable exit) instead of leaving a blank screen.
- Lockstep (`src/net/lockstep.ts`): the host broadcasts tick/speed/pause; guests catch up or wait (±3 steps), estimate is capped at 1.5 s; checksum mismatch ⇒ host sends a snapshot (throttled to 1 per 4 s).
- Test with `npm run test:net`; for real browsers use the `online-smoke-test` skill (two tabs, relay or LAN).
