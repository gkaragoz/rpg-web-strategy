# Online play

- **Topology**: one host (authoritative), many guests and spectators. Transports: LAN WebSocket (`scripts/lan.mjs`, also served by `vite preview`), Cloudflare relay (`relay/`), WebRTC (`peerTransport.ts`).
- **Lobby** (`host.ts` `HostLobby`): players, teams, settings, gold budgets (`economy.ts`), placement zones, kicks. Guests send intents; the host validates and broadcasts the state.
- **Flow**: lobby → placement (own zone, gold budget, live cursors) → ready → battle (lockstep) → results. Setup failures return to a rejoinable state.
- **Lockstep** (`lockstep.ts`, `lockstepSim.ts`): host broadcasts ticks/speed/pause; guests step in sync; checksum mismatch ⇒ snapshot resync. Large messages are chunked (`chunk.ts`).
- **Comedy options**: *physics* changes the simulation (big hits launch units, landing in water drowns them), so it is a lobby setting fixed at game start; *view* (ragdolls, comic text, cartoon sounds) is look-only. Both are host-only: guests see them disabled in the lobby, and during a battle only the host can switch the view (`cmd.comedyVisual` then a `comedyView` broadcast; everybody follows, late joiners get it through `init.comedyVisual`).
- **Protocol**: `PROTOCOL` in `protocol.ts` (currently 12). Bump on any wire change. Messages carry codes, receivers translate.
- UI: `src/app/online/` (`online.ts` controller, lobby, placement, badge, cursors).
- Rules: `.claude/rules/online-protocol.md`; manual test: `online-smoke-test` skill.

## Game modes
`LobbySettings.gameMode` (`'classic' | 'hill' | 'vip' | 'ctf'`, default `classic`) is host-only like the other settings: `HostLobby.onSettings` ignores unknown values and a real change clears the ready flags. `start()` copies it into `GameInit.gameMode`; `battleConfig(start)` turns it into `BattleConfig.rules`, so every client builds the same rules. The `result` message (and `HostLobby.finish`) carries optional `scores` (points per team, for hill); the host's `LockstepRunner` reads them from `SimLike.scores` (`Battle.scores`, `WorkerSim.scores`). Added in protocol 12.
