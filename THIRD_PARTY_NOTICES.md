# Third-party notices

This project uses the components below. Each one is under its own license; **the commercial-use restriction of the main project
(`LICENSE`) does not apply to them**, their own terms do.

## Runtime dependencies

| Package | License | Use |
|---|---|---|
| [PixiJS](https://github.com/pixijs/pixijs) v8 | MIT | 2D rendering |
| [PeerJS](https://github.com/peers/peerjs) 1.5.4 | MIT | WebRTC fallback connection |

## Development dependencies

[Vite](https://github.com/vitejs/vite) (MIT), [Vitest](https://github.com/vitest-dev/vitest) (MIT),
[TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), `@types/node` (MIT). [Wrangler](https://github.com/cloudflare/workers-sdk)
(MIT / Apache-2.0) is used only to deploy `relay/`.

## Infrastructure

The internet relay runs as a Cloudflare Worker + Durable Object (`relay/`); the WebRTC fallback uses PeerJS's public signaling server and
public STUN servers. These services are subject to their own terms of use.

## Game content

The unit roster (names, statistics, skills and descriptions), the map generator, all drawings (procedural recipes in `src/render/looks.ts`)
and all sounds (synthesized with WebAudio, no audio files) are original to this project and are covered by the project license.
