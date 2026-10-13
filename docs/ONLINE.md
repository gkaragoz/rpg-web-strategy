# Online play

- **Topology**: one host (authoritative), many guests and spectators. Transports: LAN WebSocket (`scripts/lan.mjs`, also served by `vite preview`), Cloudflare relay (`relay/`), WebRTC (`peerTransport.ts`).
- **Lobby** (`host.ts` `HostLobby`): players, teams, settings, gold budgets (`economy.ts`), placement zones, kicks. Guests send intents; the host validates and broadcasts the state.
- **Flow**: lobby → placement (own zone, gold budget, live cursors) → ready → battle (lockstep) → results. Setup failures return to a rejoinable state.
- **Lockstep** (`lockstep.ts`, `lockstepSim.ts`): host broadcasts ticks/speed/pause; guests step in sync; checksum mismatch ⇒ snapshot resync. Large messages are chunked (`chunk.ts`).
- **Protocol**: `PROTOCOL` in `protocol.ts` (currently 3). Bump on any wire change. Messages carry codes, receivers translate.
- UI: `src/app/online/` (`online.ts` controller, lobby, placement, badge, cursors).
- Rules: `.claude/rules/online-protocol.md`; manual test: `online-smoke-test` skill.
