import * as THREE from 'three'
import type { LobbyPlayer, MultiplayerClient } from './MultiplayerClient.ts'

/** Chassis Rapier shape: box proxy, hull from mesh verts, or full triangle mesh. */
export type ChassisColliderMode = 'cuboid' | 'convexHull' | 'trimesh'

/** Tyre scale / offsets from chassis bbox (`CarGeometry.addTyresToCar`). */
export type TyrePlacementConfig = {
  widthFrac: number
  alongFrontFrac: number
  alongRearFrac: number
  lateralFrac: number
  extraDropY: number
  leftYaw: number
}

export class CarConfig {
  /** `driving` spawns the full world; `empty` renders an intentionally blank scene. */
  static readonly SCENE_MODE: 'driving' | 'empty' = 'driving'
  /** Screen-space background image used by `SCENE_MODE = 'empty'`. */
  static readonly EMPTY_SCENE_BACKGROUND_URL = '/temp_background.webp'

  /** `localStorage` key for best checkpoint-run time (seconds, number). */
  static readonly BEST_RACE_TIME_LS_KEY = 'car-physics-desert-race-best-sec-v1'

  private static _sessionMultiplayerDisplayName: string | null = null

  /** Shown in lobby + your car; set only from the name modal (in-memory for this page load). */
  static setSessionMultiplayerDisplayName(name: string | null): void {
    if (name == null || String(name).trim() === '') {
      CarConfig._sessionMultiplayerDisplayName = null
      return
    }
    const t = String(name).replace(/\r|\n/g, ' ').trim().slice(0, 20)
    CarConfig._sessionMultiplayerDisplayName = t
  }

  static getSessionMultiplayerDisplayName(): string {
    if (CarConfig._sessionMultiplayerDisplayName != null && CarConfig._sessionMultiplayerDisplayName.length > 0) {
      return CarConfig._sessionMultiplayerDisplayName
    }
    return ''
  }

  /** `public/chassis_1.glb` — uses `VEHICLE1_TYRE_*` in `tyrePlacementForActiveChassis()`. */
  static readonly CHASSIS_1_MODEL_URL = '/chassis_1.glb'
  /** `public/chassis_2.glb` — uses `VEHICLE2_TYRE_*`. */
  static readonly CHASSIS_2_MODEL_URL = '/chassis_2.glb'
  /** `public/chassis_3.glb` — uses `VEHICLE3_TYRE_*`. */
  static readonly CHASSIS_3_MODEL_URL = '/chassis_3.glb'

  static readonly WHEEL_MODEL_URL_1 = '/tyre_1.glb'

  static readonly WHEEL_MODEL_URL_2 = '/tyre_2.glb'
  static readonly WHEEL_MODEL_URL_3 = '/tyre_3.glb'
  /** Default chassis when no start-screen choice (`activeChassisUrl`). */
  static readonly JEEP_MODEL_URL = CarConfig.CHASSIS_2_MODEL_URL

  private static _sessionChassisUrl: string | null = null
  private static _sessionWheelUrl: string | null = null

  /** Chassis GLB for this page load; set via `setActiveVehicleChoice` before `CarPhysicsApp.init()`. */
  static get activeChassisUrl(): string {
    return CarConfig._sessionChassisUrl ?? CarConfig.JEEP_MODEL_URL
  }

  static get activeWheelUrl(): string {
    return CarConfig._sessionWheelUrl ?? CarConfig.WHEEL_MODEL_URL_1
  }

  /** `1` / `2` / `3` → matching chassis + tyre GLBs. */
  static setActiveVehicleChoice(vehicle: 1 | 2 | 3): void {
    if (vehicle === 1) {
      CarConfig._sessionChassisUrl = CarConfig.CHASSIS_1_MODEL_URL
      CarConfig._sessionWheelUrl = CarConfig.WHEEL_MODEL_URL_1
      return
    }
    if (vehicle === 2) {
      CarConfig._sessionChassisUrl = CarConfig.CHASSIS_2_MODEL_URL
      CarConfig._sessionWheelUrl = CarConfig.WHEEL_MODEL_URL_2
      return
    }
    CarConfig._sessionChassisUrl = CarConfig.CHASSIS_3_MODEL_URL
    CarConfig._sessionWheelUrl = CarConfig.WHEEL_MODEL_URL_3
  }

  /** `1`–`3` matching the active chassis + wheel set for this page load. */
  static get activeVehicleChoice(): 1 | 2 | 3 {
    const u = CarConfig.activeChassisUrl
    if (u === CarConfig.CHASSIS_1_MODEL_URL) return 1
    if (u === CarConfig.CHASSIS_3_MODEL_URL) return 3
    return 2
  }

  /** Lobby / kinematics `v` field: coerce to `1` | `2` | `3`. */
  static normalizeVehicleWire(v: unknown): 1 | 2 | 3 {
    const n = Number(v)
    if (n === 3) return 3
    if (n === 2) return 2
    return 1
  }

  private static _multiplayerWsUrl: string | null = null
  /**
   * When set, `CarPhysicsApp` connects to this WebSocket after the world loads.
   * The relay is not bundled; run `npm run mp-server` (default port 8000; URL from `getDefaultMultiplayerWsUrl()`).
   */
  static setMultiplayerSession(url: string | null): void {
    CarConfig._multiplayerWsUrl = url
  }
  static get multiplayerWsUrl(): string | null {
    return CarConfig._multiplayerWsUrl
  }

  /**
   * URL for the lobby server (`npm run mp-server`, default port 8000).
   *
   * - **`VITE_MP_URL`** in env if set.
   * - **Dev** (`import.meta.env.DEV`): `ws(s)://<page host>/_mp` — Vite proxies to `http://127.0.0.1:8000` so
   *   the browser uses the same origin as the app (HTTPS → `wss` to Vite, not raw `wss:8000` on Node).
   *   LAN phones open `http://ip:5173` and the socket goes through 5173, which helps when the game port is closed.
   * - **Preview / production** build: `ws(s)://<hostname>:8000` (use `VITE_MP_URL` for `wss` to a real host).
   */
  static getDefaultMultiplayerWsUrl(): string {
    const env = import.meta.env['VITE_MP_URL'] as string | undefined
    if (env != null && String(env).trim() !== '') return String(env).trim()
    if (import.meta.env.DEV && typeof window !== 'undefined' && window.location?.host) {
      const { protocol, host } = window.location
      const wsProto = protocol === 'https:' ? 'wss:' : 'ws:'
      return `${wsProto}//${host}/_mp`
    }
    if (typeof window === 'undefined' || !window.location?.hostname) {
      return 'ws://127.0.0.1:8000'
    }
    const { protocol, hostname } = window.location
    if (hostname.length === 0) return 'ws://127.0.0.1:8000'
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProto}//${hostname}:8000`
  }

  private static _preconnectedMp: MultiplayerClient | null = null
  private static _gameStartPeerIds: string[] | null = null
  private static _gameStartSnapshot: {
    localId: string
    peerOrder: string[]
    pl: LobbyPlayer[]
  } | null = null

  /**
   * `main` calls `notifyMultiplayerRoomEndedInGame` when the server reports `HOST_LEFT` / `ROOM_CLOSED` so
   * remote 3D cars and Rapier proxies are removed before the socket is closed with `userDisconnect: true`
   * (which would otherwise skip `onConnectionLost` and leave stale remotes in the world).
   */
  private static _onMultiplayerRoomEndedInGame: (() => void) | null = null
  static setOnMultiplayerRoomEndedInGame(fn: (() => void) | null): void {
    CarConfig._onMultiplayerRoomEndedInGame = fn
  }
  static notifyMultiplayerRoomEndedInGame(): void {
    CarConfig._onMultiplayerRoomEndedInGame?.()
  }

  /** Set when the lobby hands off to `CarPhysicsApp` (session already had `go`). */
  static setPreconnectedMultiplayerClient(c: MultiplayerClient | null): void {
    CarConfig._preconnectedMp = c
  }
  static takePreconnectedMultiplayerClient(): MultiplayerClient | null {
    const x = CarConfig._preconnectedMp
    CarConfig._preconnectedMp = null
    return x
  }
  static setGameStartPeerIds(ids: string[]): void {
    CarConfig._gameStartPeerIds = ids
  }
  static takeGameStartPeerIds(): string[] {
    const x = CarConfig._gameStartPeerIds
    CarConfig._gameStartPeerIds = null
    return x ?? []
  }
  /**
   * Richer than peer ids only: per-player name + vehicle for remote visuals.
   * Cleared in `takeGameStartMultiplayerSnapshot()`.
   */
  static setGameStartMultiplayerSnapshot(
    s: { localId: string; peerOrder: string[]; pl: LobbyPlayer[] } | null,
  ): void {
    CarConfig._gameStartSnapshot = s
  }
  static takeGameStartMultiplayerSnapshot(): {
    localId: string
    peerOrder: string[]
    pl: LobbyPlayer[]
  } | null {
    const x = CarConfig._gameStartSnapshot
    CarConfig._gameStartSnapshot = null
    return x
  }

  /**
   * Read snapshot without consuming (e.g. local spawn before `connectMultiplayer` takes it).
   * `takeGameStartMultiplayerSnapshot` still clears when called from game init.
   */
  static peekGameStartMultiplayerSnapshot(): {
    localId: string
    peerOrder: string[]
    pl: LobbyPlayer[]
  } | null {
    return CarConfig._gameStartSnapshot
  }

  /**
   * Multiplayer spawn offsets in XZ (meters) from the **normal** solo spawn (checkpoint or default).
   * Added to the resolved `spawnX` / `spawnZ` before the car is built. Slot 0..3 = four corners (±5).
   */
  static readonly MP_SPAWN_XZ: readonly { x: number; z: number }[] = [
    { x: -5, z: -5 },
    { x: -5, z: 5 },
    { x: 5, z: -5 },
    { x: 5, z: 5 },
  ]

  /** Deterministic slot 0..3 for the local client from the lobby `pl` list (by player id). */
  static mpSpawnSlotIndexForLocalId(localId: string, pl: LobbyPlayer[]): number {
    if (pl.length === 0) return 0
    const unique = Array.from(new Set(pl.map((p) => p.i).filter((id) => id.length > 0))).sort()
    const k = unique.indexOf(localId)
    const max = CarConfig.MP_SPAWN_XZ.length - 1
    if (k < 0) return 0
    return k > max ? max : k
  }

  /**
   * Wall-clock: `performance.now()` when the MP race is allowed to move and the shared timer starts.
   * Set in `main` on `go` to `performance.now() + MP_RACE_COUNTDOWN_MS` (3s + optional skew before load);
   * consumed in `CarPhysicsApp` once when wiring multiplayer.
   */
  static readonly MP_RACE_COUNTDOWN_MS = 3000
  private static _multiplayerRaceStartPerf: number | null = null
  static setMultiplayerRaceStartPerf(perfNow: number): void {
    CarConfig._multiplayerRaceStartPerf = perfNow
  }
  static takeMultiplayerRaceStartPerf(): number | null {
    const x = CarConfig._multiplayerRaceStartPerf
    CarConfig._multiplayerRaceStartPerf = null
    return x
  }

  private static _sessionMultiplayer = false
  /** Set in `main` from the selected start mode (solo vs mp). Gating: MP uses server-sync race timer. */
  static setSessionMultiplayer(on: boolean): void {
    CarConfig._sessionMultiplayer = on
  }
  static isSessionMultiplayer(): boolean {
    return CarConfig._sessionMultiplayer
  }

  /** Clearance above ground surface at spawn / reset (world Y offset on top of terrain height). */
  static readonly SPAWN_Y = 1.55
  /**
   * Hard prop exclusion around gameplay spawn zones (cacti/rocks). Includes multiplayer slot offsets
   * when active, so nobody spawns inside static colliders.
   */
  static readonly SPAWN_PROPS_CLEAR_RADIUS_M = 64

  /** If true, use `DesertTerrainGround`; otherwise `FlatGround` (checker slab). */
  static readonly USE_DESERT_TERRAIN = true
  /** Half-size of desert patch on X and Z (meters); physics matches this extent. */
  static readonly TERRAIN_HALF_EXTENT = 900
  /** Grid resolution along each edge (includes corners → (n+1)² vertices). */
  static readonly TERRAIN_VERTS_PER_SIDE = 190
  /** Max vertical variation from noise (meters). */
  static readonly TERRAIN_AMPLITUDE = 26
  /** Base spatial frequency for dunes (lower = wider rolls). */
  static readonly TERRAIN_NOISE_SCALE = 0.0018
  /** Low-frequency mask for local rough zones (higher = smaller noisy patches). */
  static readonly TERRAIN_NOISE_PATCH_SCALE = 0.00058
  /** Extra amplitude multiplier in rough zones (1 = disabled). */
  static readonly TERRAIN_NOISE_PATCH_BOOST = 1.72
  static readonly TERRAIN_FBM_OCTAVES = 5
  static readonly TERRAIN_SEED = 42_069
  /** Flat disk radius (m) at world origin so spawn/reset sits level with dunes. */
  static readonly TERRAIN_SPAWN_PAD_INNER = 34
  /** Blend ring outer radius (m); must be greater than `TERRAIN_SPAWN_PAD_INNER`. */
  static readonly TERRAIN_SPAWN_PAD_OUTER = 78
  /** Circular mountain belt starts around this fraction of `TERRAIN_HALF_EXTENT`. */
  static readonly TERRAIN_MOUNTAIN_RING_START_FRAC = 0.62
  /** Belt reaches full strength near this fraction of `TERRAIN_HALF_EXTENT`. */
  static readonly TERRAIN_MOUNTAIN_RING_FULL_FRAC = 0.95
  /** Max added mountain elevation (m) at outer belt, before noise shaping. */
  static readonly TERRAIN_MOUNTAIN_HEIGHT = 210
  /** Low-frequency mountain shape noise scale (smaller = broader mountains). */
  static readonly TERRAIN_MOUNTAIN_NOISE_SCALE = 0.00115
  /** Shapes ridge contrast; >1 gives broader smooth ridges and softer valleys. */
  static readonly TERRAIN_MOUNTAIN_RIDGE_EXP = 1.35

  /** `Water` plane center X/Z (m); full width/depth = `TERRAIN_HALF_EXTENT * 2`. */
  static readonly POND_CENTER_X = -10
  static readonly POND_CENTER_Z = -5
  /** Water surface Y = `terrainMinY +` this (m), i.e. a few units above the lowest ground vertex. */
  static readonly POND_SURFACE_ABOVE_MIN_Y = 2.5
  /** Radius (m) where shoreline smoothing starts near pond center. */
  static readonly POND_SHORE_SMOOTH_INNER_R = 18
  /** Radius (m) where shoreline smoothing reaches zero. */
  static readonly POND_SHORE_SMOOTH_OUTER_R = 98
  /** Past `POND_SHORE_SMOOTH_OUTER_R`, gently blend back to natural dunes (m) — softens the hard lip. */
  static readonly POND_SHORE_EDGE_OUTER_R = 158
  /** How strongly the outer feather pulls toward undampened dunes (0..1). */
  static readonly POND_SHORE_OUTER_FEATHER = 0.78
  /** Blend amount to low-frequency terrain around shoreline (0..1). */
  static readonly POND_SHORE_NOISE_DAMP = 0.45
  /** Extra basin carve depth near pond center (m). */
  static readonly POND_BASIN_DEPTH_M = 4.25

  /** Chassis world +Y below this (upside-down) counts as “flipped” for auto-reset. */
  static readonly AUTO_RESET_FLIP_UP_Y_MAX = -0.42
  /** Seconds upside-down before auto reset (same spawn logic as R). */
  static readonly AUTO_RESET_FLIP_HOLD_S = 2
  /** Multiplier on Δt for `Water` shader time (normal map scroll / ripples). */
  static readonly POND_WATER_SHADER_TIME_SCALE = 1.12
  /** Ground speed cap (km/h) when fully wading in the pond (lerps from `MAX_SPEED_KMH`). */
  static readonly POND_MAX_SPEED_KMH = 36
  /** Engine multiplier at full wade (`lerp(1, this, submergeFactor)`). */
  static readonly POND_MIN_ENGINE_MULT = 0.28
  /** Extra linear damping at full wade (added to chassis base ~0.08). */
  static readonly POND_LINEAR_DAMP_EXTRA = 0.62
  /** Chassis-bottom depth into water (m) before wade factor reaches 1. */
  static readonly POND_SUBMERGE_FULL_DEPTH_M = 1.05
  /** Trigger droplets overlay when wade factor crosses this from below. */
  static readonly POND_OVERLAY_ENTRY_WADE = 0.06
  /** Seconds droplets stay near peak after entering water. */
  static readonly POND_OVERLAY_HOLD_S = 2.2
  /** Seconds droplets fade from peak to 0 after hold. */
  static readonly POND_OVERLAY_FADE_S = 3.4
  /** Peak rain mask intensity for the fullscreen droplets overlay. */
  static readonly POND_OVERLAY_PEAK_INTENSITY = 0.26

  /** Coconut palm GLB in `public/` (trees scene). If load fails, procedural palms are used. */
  static readonly COCONUT_TREE_MODEL_URLS = ['/coconut_trees_1.glb'] as const
  /** Sparse palms near the pond / low shore. */
  static readonly COCONUT_TREE_COUNT = 5
  /**
   * Sample (x,z) uniformly in area between these radii from `POND_CENTER_*` (m), then apply
   * `COCONUT_RING_JITTER_M` — keeps trees around the water, not across the whole map.
   */
  static readonly COCONUT_POND_R_MIN_M = 18
  static readonly COCONUT_POND_R_MAX_M = 108
  static readonly COCONUT_RING_JITTER_M = 36
  static readonly COCONUT_MIN_SEPARATION = 24
  static readonly COCONUT_EDGE_MARGIN = 8
  static readonly COCONUT_CLEAR_ORIGIN_RADIUS = CarConfig.TERRAIN_SPAWN_PAD_OUTER + 36
  static readonly COCONUT_MIN_CLEARANCE_ABOVE_POND_M = 0.55
  /**
   * Trunk base sits this far **below** terrain surface (m): mesh bottom = `yGround -` this.
   */
  static readonly COCONUT_ROOT_EMBED_BELOW_SURFACE_M = 1.0
  static readonly COCONUT_SCALE_MIN = 1.18
  static readonly COCONUT_SCALE_MAX = 1.58
  /** Only spawn where `heightAt(x,z) <= terrainMinY +` this (low ground / depressions). */
  static readonly COCONUT_LOW_TERRAIN_BAND_M = 13
  /** Extra random thinning (0–1); lower = sparser. */
  static readonly COCONUT_PLACE_KEEP_PROB = 0.075
  /** Simplex on XZ; spawn only if normalized value ≥ this — breaks continuous “lines” in low areas. */
  static readonly COCONUT_PATCH_NOISE_SCALE = 0.00115
  static readonly COCONUT_PATCH_NOISE_MIN = 0.42
  static readonly COCONUT_PATCH_NOISE_SEED = 99_127
  static readonly COCONUT_PLACE_SEED = 77_821

  static readonly CACTUS_MODEL_URLS = ['/cactus_1.glb', '/cactus_2.glb', '/cactus_3.glb'] as const
  /** Target instances across the playable desert (see `DesertCacti` max-attempt budget). */
  static readonly CACTUS_PLACEMENT_COUNT = 280
  /** Inset from `±TERRAIN_HALF_EXTENT` so samples stay inside the heightfield (m). */
  static readonly CACTUS_EDGE_MARGIN = 6
  /** No cactus closer than this to world origin (keeps spawn clear). */
  static readonly CACTUS_CLEAR_ORIGIN_RADIUS = CarConfig.TERRAIN_SPAWN_PAD_OUTER + 32
  /** Min spacing between cactus bases (m). */
  static readonly CACTUS_MIN_SEPARATION = 17
  static readonly CACTUS_SCALE_MIN = 2.38
  static readonly CACTUS_SCALE_MAX = 3.72
  /**
   * Extra scale in the noisiest placement zones (multiplier lerp 1 → this at max mask).
   * Base scale still comes from `CACTUS_SCALE_MIN` / `CACTUS_SCALE_MAX`.
   */
  static readonly CACTUS_SCALE_MASK_BOOST = 1.3
  /** Min terrain Y at plant (x,z) vs pond surface — keeps bases out of the water sheet. */
  static readonly CACTUS_MIN_CLEARANCE_ABOVE_POND_M = 0.65
  /** Start thinning cacti above `terrainMinY +` this (m). */
  static readonly CACTUS_MOUNTAIN_SPARSE_START_ABOVE_MIN_M = 62
  /** Reach max thinning above `terrainMinY +` this (m). */
  static readonly CACTUS_MOUNTAIN_SPARSE_FULL_ABOVE_MIN_M = 128
  /** Keep probability at highest mountain band (0–1). */
  static readonly CACTUS_MOUNTAIN_KEEP_MIN = 0.24
  /** Extra embed depth for cactus base (m) after terrain normal alignment. */
  static readonly CACTUS_GROUND_SINK_M = 0.2
  static readonly CACTUS_PLACE_SEED = 90_241
  /** Permutation seed for density noise (independent of terrain). */
  static readonly CACTUS_NOISE_SEED = 18_377
  /** Skip cacti placement when local ground slope exceeds this (m/m). */
  static readonly CACTUS_MAX_SLOPE_FOR_PLACEMENT = 0.18
  static readonly CACTUS_SLOPE_SAMPLE_EPS_M = 6.5

  static readonly RUINS_MODEL_URL = '/ruins.glb'
  static readonly WIZARD_STATUE_MODEL_URL = '/wizard_stature.glb'
  static readonly STONE_ARC_MODEL_URL = '/stone_arc.glb'
  static readonly ROCKS_MODEL_URLS = ['/rocks_1.glb', '/rocks_2.glb', '/rocks_3.glb', '/rocks_4.glb'] as const
  /** Horizontal footprint target (m) after uniform scale; max of model XZ extent. */
  static readonly RUINS_TARGET_FOOTPRINT_MIN_M = 58
  static readonly RUINS_TARGET_FOOTPRINT_MAX_M = 102
  static readonly RUINS_EDGE_MARGIN = 14
  /** Ruins *anchor* must stay beyond this (m); footprint checked separately. */
  static readonly RUINS_CLEAR_ORIGIN_RADIUS = CarConfig.TERRAIN_SPAWN_PAD_OUTER + 108
  /** Clamp uniform scale so a bad/jittery bounds box cannot create a world-sized collider. */
  static readonly RUINS_SCALE_MIN = 0.06
  static readonly RUINS_SCALE_MAX = 78
  /** Min 2‑D distance (m) from world origin to ruins mesh AABB in XZ after placement. */
  static readonly SPAWN_FIXED_COLLIDER_CLEAR_M = 52
  static readonly RUINS_POND_CLEAR_RADIUS_M = 112
  static readonly RUINS_MIN_CLEARANCE_ABOVE_POND_M = 0.75
  /** Nudge root Y after ground snap (m). */
  static readonly RUINS_VERTICAL_BIAS_M = 0.02
  /** Best-of random samples; lowest slope wins. */
  static readonly RUINS_FLAT_SEARCH_TRIES = 1100
  static readonly RUINS_SLOPE_SAMPLE_EPS_M = 8
  /** Reject site if best |∇h| exceeds this (≈ 4% grade). */
  static readonly RUINS_MAX_SLOPE = 0.042
  static readonly RUINS_EXCLUSION_PAD_M = 32
  static readonly RUINS_PLACE_SEED = 58_331
  /** Large landmark statue placement/scaling. */
  static readonly WIZARD_STATUE_TARGET_FOOTPRINT_MIN_M = 30
  static readonly WIZARD_STATUE_TARGET_FOOTPRINT_MAX_M = 54
  static readonly WIZARD_STATUE_SCALE_MIN = 0.2
  static readonly WIZARD_STATUE_SCALE_MAX = 34
  static readonly WIZARD_STATUE_EDGE_MARGIN = 10
  static readonly WIZARD_STATUE_CLEAR_ORIGIN_RADIUS = CarConfig.TERRAIN_SPAWN_PAD_OUTER + 122
  static readonly WIZARD_STATUE_POND_CLEAR_RADIUS_M = 96
  static readonly WIZARD_STATUE_MIN_CLEARANCE_ABOVE_POND_M = 0.7
  static readonly WIZARD_STATUE_VERTICAL_BIAS_M = 0.02
  static readonly WIZARD_STATUE_SLOPE_SAMPLE_EPS_M = 7
  static readonly WIZARD_STATUE_MAX_SLOPE = 0.06
  static readonly WIZARD_STATUE_EXCLUSION_PAD_M = 26
  static readonly WIZARD_STATUE_PLACE_SEED = 41_907
  /** Stone arc placement/scaling (fixed user-requested scale). */
  static readonly STONE_ARC_SCALE = 4
  static readonly STONE_ARC_EDGE_MARGIN = 10
  static readonly STONE_ARC_CLEAR_ORIGIN_RADIUS = CarConfig.TERRAIN_SPAWN_PAD_OUTER + 132
  static readonly STONE_ARC_POND_CLEAR_RADIUS_M = 106
  static readonly STONE_ARC_MIN_CLEARANCE_ABOVE_POND_M = 0.7
  static readonly STONE_ARC_VERTICAL_BIAS_M = 0.02
  static readonly STONE_ARC_SLOPE_SAMPLE_EPS_M = 7
  static readonly STONE_ARC_MAX_SLOPE = 0.08
  static readonly STONE_ARC_EXCLUSION_PAD_M = 22
  static readonly STONE_ARC_COUNT = 10
  static readonly STONE_ARC_MIN_SEPARATION = 52
  static readonly STONE_ARC_MAX_ABOVE_MIN_M = 88
  static readonly STONE_ARC_RUINS_CLEAR_RADIUS_M = 100
  static readonly STONE_ARC_NEAR_WATER_MIN_R = 28
  static readonly STONE_ARC_NEAR_WATER_MAX_R = 76
  static readonly STONE_ARC_NEAR_WATER_TRIES = 380
  static readonly STONE_ARC_GENERAL_TRIES = 4400
  static readonly STONE_ARC_PLACE_SEED = 27_511

  /** Navigation chevron length ≈ `NAV_ARROW_LENGTH_SCALE * 2 * max(chassis half X, half Z)`. */
  static readonly NAV_ARROW_LENGTH_SCALE = 0.72
  /** World-space height above the car pivot for the NFS-style checkpoint arrow. */
  static readonly NAV_ARROW_HEIGHT_ABOVE_CAR_M = 3.65
  /** Exponential smoothing for arrow yaw toward the next checkpoint (higher = snappier). */
  static readonly NAV_ARROW_ROTATION_SMOOTH = 5.2

  /** Total rock instances (split across 4 templates). */
  static readonly ROCKS_PLACEMENT_COUNT = 235
  static readonly ROCKS_SCALE_MIN = 2.75
  static readonly ROCKS_SCALE_MAX = 7.35
  static readonly ROCKS_EDGE_MARGIN = 6
  /** Rock *centers* stay farther out so scaled meshes cannot reach spawn (m). */
  static readonly ROCKS_CLEAR_ORIGIN_RADIUS = CarConfig.TERRAIN_SPAWN_PAD_OUTER + 102
  static readonly ROCKS_POND_CLEAR_RADIUS_M = 92
  static readonly ROCKS_MIN_SEPARATION = 8.5
  static readonly ROCKS_MIN_CLEARANCE_ABOVE_POND_M = 0.55
  /** Start thinning rocks above `terrainMinY +` this (m). */
  static readonly ROCKS_MOUNTAIN_SPARSE_START_ABOVE_MIN_M = 68
  /** Reach max thinning above `terrainMinY +` this (m). */
  static readonly ROCKS_MOUNTAIN_SPARSE_FULL_ABOVE_MIN_M = 136
  /** Keep probability at highest mountain band (0–1). */
  static readonly ROCKS_MOUNTAIN_KEEP_MIN = 0.28
  static readonly ROCKS_VERTICAL_BIAS_M = -2
  static readonly ROCKS_PLACE_SEED = 71_009
  /** Skip rocks on steep/curvy mountain edges (m/m). */
  static readonly ROCKS_MAX_SLOPE_FOR_PLACEMENT = 0.22
  static readonly ROCKS_SLOPE_SAMPLE_EPS_M = 7.5
  /** World XZ frequency for “patches” of cacti vs empty desert (lower = bigger regions). */
  static readonly CACTUS_NOISE_SCALE = 0.00052
  /** Second octave weight (0 = single octave only). */
  static readonly CACTUS_NOISE_FBM_WEIGHT = 0.42
  /**
   * Normalized mask below this ⇒ never place. Use `0` so every point on the terrain can spawn;
   * variation comes from `INTENSITY_*` only.
   */
  static readonly CACTUS_NOISE_EMPTY_BELOW = 0
  /** Shapes how much extra density piles into high-noise zones (everywhere still gets `FLOOR`). */
  static readonly CACTUS_NOISE_INTENSITY_EXP = 1.35
  /**
   * Minimum placement weight at the lowest mask (0–1); `lerp(FLOOR, 1, mask^EXP)` so the whole
   * patch is populated, with hotter groves where noise is high.
   */
  static readonly CACTUS_NOISE_INTENSITY_FLOOR = 0.58
  /** >1 boosts acceptance further in mid/high mask areas. */
  static readonly CACTUS_NOISE_ACCEPTANCE_GAIN = 1.42

  /**
   * Tyre layout for `chassis_1.glb` (`CHASSIS_1_MODEL_URL`). Selected when the active chassis URL matches
   * at that file (see `tyrePlacementForActiveChassis`).
   */
  static readonly VEHICLE1_TYRE_WIDTH_FRAC = 0.58
  static readonly VEHICLE1_TYRE_ALONG_FRONT_FRAC = 0.64
  static readonly VEHICLE1_TYRE_ALONG_REAR_FRAC = 0.43
  static readonly VEHICLE1_TYRE_LATERAL_FRAC = 0.88
  static readonly VEHICLE1_TYRE_EXTRA_DROP_Y = 0.4
  static readonly VEHICLE1_TYRE_LEFT_YAW = Math.PI

  /**
   * Tyre layout for `chassis_2.glb` (`CHASSIS_2_MODEL_URL`). Default for any chassis whose basename
   * is not `chassis_1.glb`.
   */
  static readonly VEHICLE2_TYRE_WIDTH_FRAC = 0.58
  static readonly VEHICLE2_TYRE_ALONG_FRONT_FRAC = 0.52
  static readonly VEHICLE2_TYRE_ALONG_REAR_FRAC = 0.52
  static readonly VEHICLE2_TYRE_LATERAL_FRAC = 0.88
  static readonly VEHICLE2_TYRE_EXTRA_DROP_Y = 0.3
  static readonly VEHICLE2_TYRE_LEFT_YAW = Math.PI

  /**
   * Tyre layout for `chassis_3.glb` (`CHASSIS_3_MODEL_URL`). `tyre_3.glb` is authored with a smaller bbox than
   * tyre_1/2 for the same visual tire, so the shared auto-fit (`targetTyreSize / ref`) overscales unless this
   * frac is lower than 0.58.
   */
  static readonly VEHICLE3_TYRE_WIDTH_FRAC = 0.45
  static readonly VEHICLE3_TYRE_ALONG_FRONT_FRAC = 0.58
  static readonly VEHICLE3_TYRE_ALONG_REAR_FRAC = 0.48
  static readonly VEHICLE3_TYRE_LATERAL_FRAC = 0.88
  static readonly VEHICLE3_TYRE_EXTRA_DROP_Y = 0.3
  static readonly VEHICLE3_TYRE_LEFT_YAW = Math.PI

  /** Lowercase filename from a chassis URL (strip query; last path segment). */
  static chassisModelBasename(url: string): string {
    const noQuery = url.split('?')[0] ?? url
    const parts = noQuery.split(/[/\\]/)
    return (parts[parts.length - 1] ?? noQuery).toLowerCase()
  }

  static tyrePlacementForChassisUrl(chassisUrl: string): TyrePlacementConfig {
    const bn = CarConfig.chassisModelBasename(chassisUrl)
    if (bn === CarConfig.chassisModelBasename(CarConfig.CHASSIS_1_MODEL_URL)) {
      return {
        widthFrac: CarConfig.VEHICLE1_TYRE_WIDTH_FRAC,
        alongFrontFrac: CarConfig.VEHICLE1_TYRE_ALONG_FRONT_FRAC,
        alongRearFrac: CarConfig.VEHICLE1_TYRE_ALONG_REAR_FRAC,
        lateralFrac: CarConfig.VEHICLE1_TYRE_LATERAL_FRAC,
        extraDropY: CarConfig.VEHICLE1_TYRE_EXTRA_DROP_Y,
        leftYaw: CarConfig.VEHICLE1_TYRE_LEFT_YAW,
      }
    }
    if (bn === CarConfig.chassisModelBasename(CarConfig.CHASSIS_3_MODEL_URL)) {
      return {
        widthFrac: CarConfig.VEHICLE3_TYRE_WIDTH_FRAC,
        alongFrontFrac: CarConfig.VEHICLE3_TYRE_ALONG_FRONT_FRAC,
        alongRearFrac: CarConfig.VEHICLE3_TYRE_ALONG_REAR_FRAC,
        lateralFrac: CarConfig.VEHICLE3_TYRE_LATERAL_FRAC,
        extraDropY: CarConfig.VEHICLE3_TYRE_EXTRA_DROP_Y,
        leftYaw: CarConfig.VEHICLE3_TYRE_LEFT_YAW,
      }
    }
    return {
      widthFrac: CarConfig.VEHICLE2_TYRE_WIDTH_FRAC,
      alongFrontFrac: CarConfig.VEHICLE2_TYRE_ALONG_FRONT_FRAC,
      alongRearFrac: CarConfig.VEHICLE2_TYRE_ALONG_REAR_FRAC,
      lateralFrac: CarConfig.VEHICLE2_TYRE_LATERAL_FRAC,
      extraDropY: CarConfig.VEHICLE2_TYRE_EXTRA_DROP_Y,
      leftYaw: CarConfig.VEHICLE2_TYRE_LEFT_YAW,
    }
  }

  /** Tyre layout matching `activeChassisUrl` (start screen or default `JEEP_MODEL_URL`). */
  static tyrePlacementForActiveChassis(): TyrePlacementConfig {
    return CarConfig.tyrePlacementForChassisUrl(CarConfig.activeChassisUrl)
  }

  static readonly WHEEL_STEER_INDICES = [0, 1] as const
  /** Max rack angle (rad) for front wheels. */
  static readonly MAX_STEER_ANGLE = Math.PI / 4
  /** Damped steering: higher K = snappier, higher D = less overshoot. */
  static readonly STEER_SPRING_K = 36
  static readonly STEER_SPRING_DAMP = 11
  /** Low-pass time constant (s) for keyboard steer input before spring targeting. */
  static readonly STEER_INPUT_FILTER_TAU = 0.085
  /** Low-pass time constant (s) for speed used by steer limiter (reduces stepy lock changes). */
  static readonly STEER_SPEED_FILTER_TAU = 0.16
  /** Below this horizontal speed (m/s), full steering lock is allowed. */
  static readonly STEER_SPEED_FULL_BELOW = 4
  /** Above this speed, steering cap reaches `STEER_SPEED_MIN_SCALE`. */
  static readonly STEER_SPEED_MIN_ABOVE = 22
  /** Minimum fraction of max steer at high speed (reduces rollover in fast turns). */
  static readonly STEER_SPEED_MIN_SCALE = 0.26

  static readonly CHASSIS_MASS = 900
  /**
   * `cuboid` — single box from `computeChassisCuboid` (fast).
   * `convexHull` — Rapier convex hull of all chassis mesh vertices in body space (matches silhouette; concave areas are filled in).
   * `trimesh` — exact triangles (concave); heavier and can be twitchier at speed than a hull.
   */
  static readonly CHASSIS_COLLIDER_MODE: ChassisColliderMode = 'convexHull'
  /** Shift chassis collider mass center toward front axle (m) to reduce wheelies. */
  static readonly CHASSIS_FRONT_WEIGHT_BIAS_M = 0.22
  /** Lower chassis mass center (m) to improve pitch stability under acceleration. */
  static readonly CHASSIS_WEIGHT_LOWER_M = 0.08
  /** Base angular damping; extra is added at high ground speed (see stability constants). */
  static readonly CHASSIS_ANGULAR_DAMPING = 0.48
  /** Above this horizontal speed (m/s), angular damping ramps up to fight roll at very high speed. */
  static readonly STABILITY_SPEED_DAMP_START = 16
  /** Extra angular damping per m/s above `STABILITY_SPEED_DAMP_START`. */
  static readonly STABILITY_ANG_DAMP_PER_MS = 0.028
  /** Cap on the extra damping (keeps steering from feeling totally dead). */
  static readonly STABILITY_ANG_DAMP_MAX_EXTRA = 1.05
  /**
   * Tyre longitudinal slip stiffness. Very large values = instant grip → violent lateral
   * impulses and rollover; keep moderate (Rapier/Bullet-style single digits to ~20).
   */
  static readonly WHEEL_FRICTION_SLIP = 14
  /** Lower = less “side bite” when cornering hard (helps tipping). */
  static readonly WHEEL_SIDE_FRICTION_STIFFNESS = 0.52

  static readonly MAX_ENGINE_FORCE = 35 * (CarConfig.CHASSIS_MASS / 10)
  static readonly MAX_BRAKE_FORCE = 1
  /** Hard cap for ground speed (km/h → m/s clamp on XZ after each physics step). */
  static readonly MAX_SPEED_KMH = 120

  /**
   * Default chase-cam yaw (rad): springs here when not dragging. Negative = orbit toward
   * −rightFlat (see GtaStyleVehicleCamera), framing more of the car’s left side from behind.
   */
  static readonly CAMERA_DEFAULT_YAW_BIAS = 0

  /** Extra tyre spin (rad/s) when throttling but physics wheelRotation barely moves (air / flipped). */
  static readonly VISUAL_THROTTLE_SPIN_RATE = 24
  /** If filtered |ΔwheelRotation/Δt| exceeds this (rad/s), physics drives mesh — drop visual offset. */
  static readonly WHEEL_PHY_SPIN_SYNC_THRESHOLD = 0.55
  /** Reject one-frame Rapier jumps (rad) before computing spin rate (steered wheels can spike). */
  static readonly WHEEL_ROT_DELTA_CAP = 2.0
  /** Low-pass time constant (s) for spin rate — avoids brief spikes clearing visual spin. */
  static readonly WHEEL_WDOT_FILTER_TAU = 0.09

  static readonly PHYSICS_TYRE_RADIUS_SCALE = 0.78
  static readonly SUSPENSION_REST_LENGTH = 0.32
  static readonly JEEP_SCALE = 1.2

  /** Half-extent (m) of ground physics cuboid on X/Z — huge “infinite” slab. */
  static readonly GROUND_HALF_EXTENT_XZ = 2500
  static readonly GROUND_HALF_EXTENT_Y = 0.25
  /** UV tiling for `public/textures/dirt_floor_*` on the ground meshes. */
  static readonly DIRT_FLOOR_UV_REPEAT = 160
  /** Subdivisions per side on the flat ground plane (displacement needs tessellation). */
  static readonly GROUND_PLANE_SEGMENTS = 128
  /** `displacementMap` strength on the infinite flat plane. */
  static readonly DIRT_FLOOR_DISP_SCALE_FLAT = 0.038
  /** Weaker displacement on procedural dunes (geometry already displaced). */
  static readonly DIRT_FLOOR_DISP_SCALE_TERRAIN = 0.008

  /** 1 = full steer at low speed; eases down toward `STEER_SPEED_MIN_SCALE` at high speed. */
  static steerSpeedScale(speedXZ: number): number {
    const low = CarConfig.STEER_SPEED_FULL_BELOW
    const high = CarConfig.STEER_SPEED_MIN_ABOVE
    const minS = CarConfig.STEER_SPEED_MIN_SCALE
    if (speedXZ <= low) return 1
    if (speedXZ >= high) return minS
    return THREE.MathUtils.lerp(1, minS, (speedXZ - low) / (high - low))
  }
}
