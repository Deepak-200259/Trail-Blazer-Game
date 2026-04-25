# Car Physics (Desert Driving + Multiplayer)

A stylized off-road driving game built with Three.js + Rapier physics, with both singleplayer and room-based multiplayer.

## About the game

- Drive across a large desert terrain with checkpoints, dunes, props, and dynamic vehicle handling.
- Choose from multiple vehicles (including custom chassis/tyre sets).
- Play solo, or host/join multiplayer rooms with a shareable room code.
- Multiplayer syncs car transforms/velocity and supports lobby flow (vehicle + ready state + countdown).

## Tech stack

- `three` for rendering
- `@dimforge/rapier3d-compat` for physics
- `troika-three-text` for in-world player labels
- `ws` for multiplayer WebSocket server
- Vite + TypeScript for dev/build

## Quick start

### Prerequisites

- Node.js 18+ (recommended 20+)
- npm

### Install

```bash
npm install
```

### Run singleplayer/dev frontend

```bash
npm run dev
```

### Run multiplayer server (in another terminal)

```bash
npm run mp-server
```

By default:
- Frontend dev server: Vite default port (usually `5173`)
- Multiplayer WS server: `8000`

In dev, frontend can connect via the Vite proxy path `/_mp`.

## How to play

### Controls

- `W` / `ArrowUp`: accelerate
- `S` / `ArrowDown`: reverse
- `A` / `ArrowLeft`: steer left
- `D` / `ArrowRight`: steer right
- `Space`: brake
- `R`: reset vehicle
- `Esc`: pause/unpause

### Singleplayer

1. Open the game.
2. Select `Singleplayer`.
3. Optionally open `Options` and pick a vehicle.
4. Press `Play`.

### Multiplayer overview

Multiplayer uses room codes from the websocket server. One player hosts, others join by code.

## Multiplayer: host a room

1. Open `Multiplayer`.
2. Click `Host room`.
3. Enter your display name.
4. Wait for room creation; copy/share the room code.
5. In lobby, select your vehicle and click `Ready`.
6. Match starts after all players are ready and countdown completes.

## Multiplayer: join a room

1. Open `Multiplayer`.
2. Click `Join room`.
3. Enter room code (provided by host).
4. Enter your display name.
5. In lobby, choose your vehicle and click `Ready`.
6. Game starts when all players are ready.

## Project scripts

- `npm run dev` - start frontend dev server
- `npm run mp-server` - start websocket multiplayer server
- `npm run build` - typecheck + production build
- `npm run preview` - preview production build locally
- `npm run lint` - run lint checks

## Multiplayer deployment notes

For production, deploy frontend and websocket server separately:

- Frontend: Vercel/Netlify/etc.
- Multiplayer server: Render/Railway/Fly.io/VPS (must support long-lived websocket process)

Set frontend env var:

- `VITE_MP_URL=wss://<your-mp-server-domain>`

If frontend is HTTPS, websocket must be `wss://` (not `ws://`).

## Project structure

Core folders/files:

- `src/main.ts` - start screen flow, mode selection, lobby UI wiring
- `src/CarPhysicsApp.ts` - main game loop, scene setup, vehicle, multiplayer runtime
- `src/CarConfig.ts` - central tuning constants, URLs, gameplay config
- `src/RaycastCar.ts` - local car physics/controller integration with Rapier
- `src/MultiplayerClient.ts` - websocket client protocol and message handling
- `src/DesertTerrainGround.ts` - terrain generation + collision surface
- `src/DesertCacti.ts`, `src/DesertRocksAndRuins.ts` - world prop placement/colliders
- `src/style.css` - UI styling
- `server/mp-server.mjs` - websocket room server (host/join/lobby/state relay)
- `public/` - static assets (GLBs, textures, thumbnails, fonts)

## How to expand the game

Good extension points:

- Add new vehicles:
  - Add chassis/tyre models in `public/`
  - Wire them in `CarConfig.ts`
  - Add UI thumbnail/cards in start/lobby carousel
- Improve multiplayer:
  - Better reconciliation/interpolation
  - Add chat, ping indicator, reconnect flow
- Add gameplay systems:
  - Lap/time trials, penalties, collectibles
  - Dynamic weather/time of day
  - AI traffic or bots
- Improve deployment:
  - Persistent room service, telemetry, crash logging
  - Matchmaking beyond room codes

## Troubleshooting

- Multiplayer not connecting:
  - Ensure `npm run mp-server` is running
  - Verify frontend points to correct WS URL
  - Confirm `wss://` in production
- Players cannot join:
  - Ensure host/server is online
  - Room code is correct
  - Room not already started/full
- Vehicle/props look wrong after updates:
  - Clear browser cache and hard refresh
  - Rebuild frontend (`npm run build`)

---

If you want, this README can be split further into `docs/` pages (Gameplay, Multiplayer Protocol, Deployment, Asset Pipeline) for easier maintenance.
