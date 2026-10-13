---
name: online-smoke-test
description: Manually verify online play with two real browser pages (LAN server or relay), including a phone via adb.
---

# Online smoke test

1. Automated first: `npm run test:net`.
2. Start the LAN server with the built app: `npm run build`, then `npx vite preview --host 127.0.0.1 --port 4173` (it also serves `/ws`).
3. Open two pages (`?lang=en`): host creates a room, guest joins by code. Check: lobby list, team/gold budget bars, placement zones, cursors, kick, ready → battle start on both, speed/pause sync.
4. Phone: `adb reverse tcp:4173 tcp:4173`, open `http://127.0.0.1:4173` on the device; drive with CDP if needed.
5. Relay: `wss://rpg-web-relay.gkaragoz96tablet.workers.dev` is the default; `relay/` holds the worker source.
6. Leaving or closing a tab must show the ghost player, not break the game.
