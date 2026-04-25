import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { RapierHelper } from 'three/addons/helpers/RapierHelper.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { Water } from 'three/addons/objects/Water.js'
import Stats from 'three/addons/libs/stats.module.js'
import { CarConfig } from './CarConfig.ts'
import { CarGeometry } from './CarGeometry.ts'
import { DesertCacti } from './DesertCacti.ts'
import { DesertCoconutTrees } from './DesertCoconutTrees.ts'
import { DesertRocksAndRuins, type RuinsExclusionZone } from './DesertRocksAndRuins.ts'
import { DesertTerrainGround } from './DesertTerrainGround.ts'
import { FlatGround } from './FlatGround.ts'
import { loadWaterNormalMap } from './createWaterNormalTexture.ts'
import { loadDirtFloorMaterial } from './loadDirtFloorMaterial.ts'
import { GtaStyleVehicleCamera } from './GtaStyleVehicleCamera.ts'
import { MovementInput } from './MovementInput.ts'
import { CarDriveEffects } from './CarDriveEffects.ts'
import { RaycastCar } from './RaycastCar.ts'
import { RainOverlayEffect } from './RainOverlayEffect'
import { WebGameAudio } from './WebGameAudio.ts'
import { Text } from 'troika-three-text'
import { MultiplayerClient, type MultiplayerKinematics } from './MultiplayerClient.ts'

export class CarPhysicsApp {
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly cameraFollower: GtaStyleVehicleCamera
  private readonly stats: Stats | null
  private readonly timer = new THREE.Timer()
  private readonly movement = new MovementInput()
  private readonly gameAudio = new WebGameAudio()

  private world!: RAPIER.World
  private physicsHelper!: RapierHelper
  private raycastCar: RaycastCar | null = null
  private driveFx: CarDriveEffects | null = null
  private rainOverlay: RainOverlayEffect | null = null
  private driveGround: { heightAt(worldX: number, worldZ: number): number } | null = null
  private pondOverlayT = 0
  private prevPondWade = 0
  private exportingTerrainGlb = false
  private readonly resetHistory: Array<{ x: number; z: number }> = []
  private resetHistorySampleT = 0
  private prevResetPressed = false
  /** Accumulated time chassis world-up points sufficiently downward (flip auto-reset). */
  private flipAutoResetHoldT = 0
  private readonly _flipBodyQuat = new THREE.Quaternion()
  private readonly _flipChassisUpWorld = new THREE.Vector3()
  private checkpointRoute: THREE.Vector3[] = []
  private checkpointIdx = -1
  private checkpointMesh: THREE.Mesh | null = null
  private checkpointOrbMaterial: THREE.MeshStandardMaterial | null = null
  private checkpointTotal = 0
  private checkpointsPassed = 0
  private raceFinished = false
  /** Monotonic race clock (ms since `performance.now()`). */
  private raceTimerStartMs: number | null = null
  /** Elapsed seconds frozen when the race completes. */
  private raceTimerFrozenSec: number | null = null
  /** Set when driving `init()` has finished (HUD + car + input). */
  private raceHudReady = false
  /** NFS-style chevron; world-space, updated each frame toward active checkpoint. */
  private navArrowRoot: THREE.Group | null = null
  private readonly _navLookTarget = new THREE.Vector3()
  private readonly _navQuatCurrent = new THREE.Quaternion()
  private readonly _navQuatTarget = new THREE.Quaternion()
  private readonly _navLookHelper = new THREE.Object3D()
  private readonly _navTmpFwd = new THREE.Vector3()
  private readonly _nameBillboardInv = new THREE.Quaternion()
  private navArrowRouteWasActive = false
  private carWheels: THREE.Object3D[] = []

  private readonly hudMpEl: HTMLElement | null

  private mp: MultiplayerClient | null = null
  /** Scratch for remote wheel visuals (velocity / axle / quats). */
  private readonly _mpChassisUp = new THREE.Vector3(0, 1, 0)
  private readonly _mpRemFwd = new THREE.Vector3()
  private readonly _mpRemRight = new THREE.Vector3()
  private readonly _mpRemVelFlat = new THREE.Vector3()
  private readonly _mpRemHubWorld = new THREE.Vector3()
  private readonly _mpRemConn = new THREE.Vector3()
  private readonly _mpRemAxleLocal = new THREE.Vector3()
  private readonly _mpRemWheelRot = new THREE.Quaternion()
  private readonly _mpRemWheelSteer = new THREE.Quaternion()
  /** Remote proxy body: current Rapier rotation → quaternion error vs network pose. */
  private readonly _mpProxyQCur = new THREE.Quaternion()
  private readonly _mpProxyQInv = new THREE.Quaternion()
  private readonly _mpProxyQErr = new THREE.Quaternion()

  private readonly mpRemotes = new Map<
    string,
    {
      group: THREE.Group
      carVisual: THREE.Group
      hasPacket: boolean
      vehicle: 1 | 2 | 3
      nameLabel: Text
      p: THREE.Vector3
      q: THREE.Quaternion
      targetP: THREE.Vector3
      targetQ: THREE.Quaternion
      vel: THREE.Vector3
      targetVel: THREE.Vector3
      wheels: THREE.Object3D[]
      wheelRadius: number[]
      wheelBaseLocal: THREE.Quaternion[]
      hubLocal: THREE.Vector3[]
      spinAccum: number[]
      forwardAlongX: boolean
      remoteSteerSmoothed: number
      /** Dynamic chassis proxy (convex hull); tracked toward network pose with velocity drive. */
      proxyBody: RAPIER.RigidBody | null
    }
  >()
  private readonly mpGltfLoader = new GLTFLoader()
  private readonly remoteCarTemplate = new Map<1 | 2 | 3, THREE.Group>()
  /** Troika label above the local car in multiplayer. */
  private localPlayerNameLabel: Text | null = null
  private mpSendAcc = 0
  private static readonly MP_SEND_HZ = 16
  /** Dynamic peer proxy: position/velocity tracking toward smoothed network state (before physics step). */
  private static readonly MP_PROXY_TRACK_KP = 22
  private static readonly MP_PROXY_TRACK_MAX_CORR = 26
  private static readonly MP_PROXY_TRACK_K_ANG = 12
  private static readonly MP_PROXY_TRACK_MAX_ANG = 8
  /**
   * Fraction of **current** linear/angular velocity kept when merging toward network targets.
   * Higher = more collision impulse survives between steps; lower = tighter lock to remote pose.
   */
  private static readonly MP_PROXY_PHYS_RETAIN = 0.55
  /** Seconds: show "GO!" after 3,2,1, while the race timer is already running. */
  private static readonly MP_RACE_GO_FLASH_S = 0.4
  /**
   * `performance.now()` when MP movement + shared HUD timer are allowed. From `go` (after loading).
   * `null` in solo or before consume.
   */
  private mpRaceStartPerf: number | null = null
  private readonly mpRaceCountdownEl: HTMLElement | null

  private readonly sunLight: THREE.DirectionalLight
  /** Sun position = car pivot + this (world space). Lower Y gives sunset/golden-hour light. */
  private readonly sunOffsetWorld = new THREE.Vector3(240, 52, 108)

  private readonly sky: Sky
  private readonly skySunDir = new THREE.Vector3()

  private readonly hudWrapEl: HTMLElement
  private readonly hudCheckpointValueEl: HTMLElement
  private readonly hudTimerEl: HTMLElement
  private readonly hudSpeedKmhEl: HTMLElement
  private readonly hudStatusEl: HTMLElement
  private readonly gameOverOverlayEl: HTMLElement
  private readonly gameOverFinalTimeEl: HTMLElement
  private readonly gameOverBestTimeEl: HTMLElement
  private readonly pauseOverlayEl: HTMLElement
  private readonly pausePanelMainEl: HTMLElement
  private readonly pausePanelOptionsEl: HTMLElement
  private readonly pauseSoundToggleEl: HTMLButtonElement
  private readonly pauseSoundToggleTextEl: HTMLElement

  private paused = false

  private desertWater: Water | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.scene.background = null

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 24_000)
    this.camera.position.set(0, 3.5, 9)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    /** Warm sunset exposure. */
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.86
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap

    const ambient = new THREE.HemisphereLight(0xffc5a2, 0x604a40, 1.05)
    this.scene.add(ambient)

    this.sunLight = new THREE.DirectionalLight(0xffd7ae, 3.2)
    this.sunLight.castShadow = true
    this.sunLight.shadow.mapSize.set(4096, 4096)
    this.sunLight.shadow.radius = 2.2
    this.sunLight.shadow.bias = -0.00055
    this.sunLight.shadow.normalBias = 0.045
    const shadowSize = 140
    this.sunLight.shadow.camera.left = -shadowSize
    this.sunLight.shadow.camera.right = shadowSize
    this.sunLight.shadow.camera.top = shadowSize
    this.sunLight.shadow.camera.bottom = -shadowSize
    this.sunLight.shadow.camera.near = 0.5
    this.sunLight.shadow.camera.far = 720
    this.scene.add(this.sunLight)
    this.scene.add(this.sunLight.target)

    this.sky = new Sky()
    this.sky.scale.setScalar(450_000)
    const skyMat = this.sky.material as THREE.ShaderMaterial
    /* Sunset atmosphere: more haze + forward scattering near low sun. */
    skyMat.uniforms['turbidity'].value = 8.6
    skyMat.uniforms['rayleigh'].value = 1.95
    skyMat.uniforms['mieCoefficient'].value = 0.0041
    skyMat.uniforms['mieDirectionalG'].value = 0.84
    /* Sparse but present clouds, with soft movement. */
    skyMat.uniforms['cloudCoverage'].value = 0.24
    skyMat.uniforms['cloudDensity'].value = 0.52
    skyMat.uniforms['cloudScale'].value = 0.0002
    skyMat.uniforms['cloudSpeed'].value = 0.00007
    skyMat.uniforms['cloudElevation'].value = 0.36
    /* Sunset grading: amber horizon, cooler violet upper sky. */
    skyMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        [
          'float upBlend = smoothstep( 0.0, 0.45, clamp( direction.y, 0.0, 1.0 ) );',
          'vec3 horizonWarm = vec3( 1.24, 0.78, 0.50 );',
          'vec3 zenithCool = vec3( 0.74, 0.60, 0.96 );',
          'texColor = mix( texColor * horizonWarm, texColor * zenithCool, upBlend );',
          'gl_FragColor = vec4( texColor, 1.0 );',
        ].join('\n\t\t\t'),
      )
    }
    this.skySunDir.copy(this.sunOffsetWorld).normalize()
    skyMat.uniforms['sunPosition'].value.copy(this.skySunDir)
    this.scene.add(this.sky)

    /* Warm atmospheric haze for long sunset sightlines. */
    this.scene.fog = new THREE.FogExp2(0xcaa58d, 0.00014)

    this.cameraFollower = new GtaStyleVehicleCamera(this.camera, canvas, {
      pivotLocal: new THREE.Vector3(0, 0.45, 0),
      defaultPitch: 0.25,
      defaultDistance: 9,
      defaultYawRest: CarConfig.CAMERA_DEFAULT_YAW_BIAS,
      /** Chase cam soft floor: pivot + this (more negative = lower allowed camera on dips). */
      minCameraY: -3.5,
    })

    if (import.meta.env.DEV) {
      this.stats = new Stats()
      this.stats.dom.classList.add('stats-panel')
      document.body.appendChild(this.stats.dom)
    } else {
      this.stats = null
    }

    this.hudMpEl = document.getElementById('hud-mp')
    this.mpRaceCountdownEl = document.getElementById('mp-race-countdown')

    const hudWrap = document.getElementById('hud-wrap')
    const hudCheckpointValue = document.getElementById('hud-checkpoints-value')
    const hudTimer = document.getElementById('hud-timer')
    const hudSpeedKmh = document.getElementById('hud-speed-kmh')
    const hudStatus = document.getElementById('hud-status')
    const gameOverOverlay = document.getElementById('game-over-overlay')
    const gameOverFinalTime = document.getElementById('game-over-final-time')
    const gameOverBestTime = document.getElementById('game-over-best-time')
    const gameOverRestart = document.getElementById('game-over-restart')
    const pauseOverlay = document.getElementById('pause-overlay')
    const pausePanelMain = document.getElementById('pause-panel-main')
    const pausePanelOptions = document.getElementById('pause-panel-options')
    const pauseResume = document.getElementById('pause-resume')
    const pauseRestart = document.getElementById('pause-restart')
    const pauseOptions = document.getElementById('pause-options')
    const pauseQuit = document.getElementById('pause-quit')
    const pauseSoundToggle = document.getElementById('pause-sound-toggle')
    const pauseOptionsBack = document.getElementById('pause-options-back')
    if (
      !hudWrap ||
      !hudCheckpointValue ||
      !hudTimer ||
      !hudSpeedKmh ||
      !hudStatus ||
      !gameOverOverlay ||
      !gameOverFinalTime ||
      !gameOverBestTime ||
      !gameOverRestart ||
      !pauseOverlay ||
      !pausePanelMain ||
      !pausePanelOptions ||
      !pauseResume ||
      !pauseRestart ||
      !pauseOptions ||
      !pauseQuit ||
      !pauseSoundToggle ||
      !pauseOptionsBack
    ) {
      throw new Error('Missing HUD / pause / game-over elements in index.html')
    }
    this.hudWrapEl = hudWrap
    this.hudCheckpointValueEl = hudCheckpointValue
    this.hudTimerEl = hudTimer
    this.hudSpeedKmhEl = hudSpeedKmh
    this.hudStatusEl = hudStatus
    this.gameOverOverlayEl = gameOverOverlay
    this.gameOverFinalTimeEl = gameOverFinalTime
    this.gameOverBestTimeEl = gameOverBestTime
    this.pauseOverlayEl = pauseOverlay
    this.pausePanelMainEl = pausePanelMain
    this.pausePanelOptionsEl = pausePanelOptions
    this.pauseSoundToggleEl = pauseSoundToggle as HTMLButtonElement
    const pauseSoundToggleText = this.pauseSoundToggleEl.querySelector('.pause-switch-text')
    if (!pauseSoundToggleText) throw new Error('Missing .pause-switch-text in pause sound toggle.')
    this.pauseSoundToggleTextEl = pauseSoundToggleText as HTMLElement
    gameOverRestart.addEventListener('click', () => {
      window.location.reload()
    })
    pauseResume.addEventListener('click', () => this.setPaused(false))
    pauseRestart.addEventListener('click', () => window.location.reload())
    pauseOptions.addEventListener('click', () => this.showPauseOptions())
    pauseOptionsBack.addEventListener('click', () => this.showPauseMain())
    pauseQuit.addEventListener('click', () => this.quitGame())
    this.syncPauseSoundToggle()
    this.pauseSoundToggleEl.addEventListener('click', () => {
      this.gameAudio.setMuted(!this.gameAudio.isMuted())
      this.syncPauseSoundToggle()
    })

    window.addEventListener('resize', this.onResize)
    this.timer.connect(document)
  }

  async init(): Promise<void> {
    await (RAPIER.init as (config?: object) => Promise<void>)({})

    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.physicsHelper = new RapierHelper(this.world as never)
    this.scene.add(this.physicsHelper)
    this.physicsHelper.visible = false

    if (CarConfig.SCENE_MODE === 'empty') {
      this.scene.clear()
      this.scene.fog = null
      this.desertWater = null
      const bg = await new THREE.TextureLoader().loadAsync(CarConfig.EMPTY_SCENE_BACKGROUND_URL)
      bg.colorSpace = THREE.SRGBColorSpace
      this.scene.background = bg
      this.rainOverlay = new RainOverlayEffect(this.scene, this.camera, { overlayOnly: false })
      this.hudWrapEl.classList.add('hud-off')
      this.hudStatusEl.textContent = ''
      return
    }

    const floorMat = await loadDirtFloorMaterial(this.renderer, {
      uvRepeat: CarConfig.DIRT_FLOOR_UV_REPEAT,
      displacementScale: CarConfig.DIRT_FLOOR_DISP_SCALE_FLAT,
    })
    const terrainMat = floorMat.clone()
    terrainMat.displacementScale = CarConfig.DIRT_FLOOR_DISP_SCALE_TERRAIN
    const ground = CarConfig.USE_DESERT_TERRAIN
      ? new DesertTerrainGround(this.world, this.scene, terrainMat)
      : new FlatGround(this.world, this.scene, floorMat)
    this.driveGround = ground

    if (CarConfig.USE_DESERT_TERRAIN && ground instanceof DesertTerrainGround) {
      const extent = CarConfig.TERRAIN_HALF_EXTENT * 2
      const pondY = ground.terrainMinY + CarConfig.POND_SURFACE_ABOVE_MIN_Y
      const waterNormals = await loadWaterNormalMap()
      const waterGeom = new THREE.PlaneGeometry(extent, extent)
      const water = new Water(waterGeom, {
        textureWidth: 1024,
        textureHeight: 1024,
        clipBias: 0.003,
        waterNormals,
        sunDirection: this.sunOffsetWorld.clone().normalize(),
        sunColor: 0xffe2c8,
        waterColor: 0x0f3a48,
        distortionScale: 0.95,
        alpha: 0.92,
        fog: true,
      })
      water.rotation.x = -Math.PI / 2
      water.position.set(CarConfig.POND_CENTER_X, pondY, CarConfig.POND_CENTER_Z)
      water.material.uniforms['size'].value = 14
      this.scene.add(water)
      this.desertWater = water
    }

    const surfaceY = ground.heightAt(0, 0)
    let spawnX = 0
    let spawnZ = 0
    let spawnY = surfaceY + CarConfig.SPAWN_Y
    let spawnYaw = -Math.PI / 2
    const loader = new GLTFLoader()
    const cactusLoads = CarConfig.USE_DESERT_TERRAIN
      ? [...CarConfig.CACTUS_MODEL_URLS].map((url) => loader.loadAsync(url))
      : []
    const [chassisGltf, tyreGltf, ...cactusGltfs] = await Promise.all([
      loader.loadAsync(CarConfig.activeChassisUrl),
      loader.loadAsync(CarConfig.activeWheelUrl),
      ...cactusLoads,
    ])


    let coconutTemplates: THREE.Object3D[] = []
    if (CarConfig.USE_DESERT_TERRAIN && CarConfig.COCONUT_TREE_MODEL_URLS.length > 0) {
      try {
        const coconutGltfs = await Promise.all(
          [...CarConfig.COCONUT_TREE_MODEL_URLS].map((url) => loader.loadAsync(url)),
        )
        coconutTemplates = coconutGltfs.map((g) => g.scene)
      } catch {
        coconutTemplates = []
      }
    }

    if (CarConfig.USE_DESERT_TERRAIN && ground instanceof DesertTerrainGround) {
      const pondSurfaceY = ground.terrainMinY + CarConfig.POND_SURFACE_ABOVE_MIN_Y
      DesertCoconutTrees.populate(this.world, this.scene, ground, {
        pondSurfaceY,
        pondCenterX: CarConfig.POND_CENTER_X,
        pondCenterZ: CarConfig.POND_CENTER_Z,
        terrainMinY: ground.terrainMinY,
        templates: coconutTemplates,
      })
    }

    if (CarConfig.USE_DESERT_TERRAIN && ground instanceof DesertTerrainGround) {
      const pondSurfaceY = ground.terrainMinY + CarConfig.POND_SURFACE_ABOVE_MIN_Y
      const [ruinsSettled, wizardSettled, stoneArcSettled, rocksSettled] = await Promise.allSettled([
        loader.loadAsync(CarConfig.RUINS_MODEL_URL),
        loader.loadAsync(CarConfig.WIZARD_STATUE_MODEL_URL),
        loader.loadAsync(CarConfig.STONE_ARC_MODEL_URL),
        Promise.all([...CarConfig.ROCKS_MODEL_URLS].map((url) => loader.loadAsync(url))),
      ])
      let ruinsExclusion: RuinsExclusionZone | null = null
      let wizardExclusion: RuinsExclusionZone | null = null
      let stoneArcExclusions: RuinsExclusionZone[] = []
      if (ruinsSettled.status === 'fulfilled') {
        ruinsExclusion = DesertRocksAndRuins.placeRuins(
          this.world,
          this.scene,
          ground,
          ruinsSettled.value.scene,
          pondSurfaceY,
        )
      }
      if (wizardSettled.status === 'fulfilled') {
        wizardExclusion = DesertRocksAndRuins.placeWizardStatue(
          this.world,
          this.scene,
          ground,
          wizardSettled.value.scene,
          pondSurfaceY,
          ruinsExclusion,
        )
      }
      if (stoneArcSettled.status === 'fulfilled') {
        stoneArcExclusions = DesertRocksAndRuins.populateStoneArcs(
          this.world,
          this.scene,
          ground,
          stoneArcSettled.value.scene,
          pondSurfaceY,
          [ruinsExclusion, wizardExclusion].filter((v): v is RuinsExclusionZone => v !== null),
          ruinsExclusion,
        )
      }
      if (stoneArcExclusions.length > 0) {
        const spawnPlan = this.setupCheckpointsAndSpawnPlan(ground, stoneArcExclusions, ruinsExclusion)
        if (spawnPlan) {
          spawnX = spawnPlan.x
          spawnY = spawnPlan.y
          spawnZ = spawnPlan.z
          spawnYaw = spawnPlan.yaw - Math.PI / 2
        }
      }
      const spawnPropExclusions: RuinsExclusionZone[] = [
        { x: spawnX, z: spawnZ, r: CarConfig.SPAWN_PROPS_CLEAR_RADIUS_M },
      ]
      if (CarConfig.isSessionMultiplayer()) {
        for (const d of CarConfig.MP_SPAWN_XZ) {
          spawnPropExclusions.push({
            x: spawnX + d.x,
            z: spawnZ + d.z,
            r: CarConfig.SPAWN_PROPS_CLEAR_RADIUS_M,
          })
        }
      }
      if (cactusGltfs.length > 0) {
        DesertCacti.populate(
          this.world,
          this.scene,
          ground,
          cactusGltfs.map((g) => g.scene),
          pondSurfaceY,
          stoneArcExclusions,
          spawnPropExclusions,
        )
      }
      if (rocksSettled.status === 'fulfilled') {
        DesertRocksAndRuins.scatterRocks(
          this.world,
          this.scene,
          ground,
          rocksSettled.value.map((g) => g.scene),
          pondSurfaceY,
          ruinsExclusion,
          [wizardExclusion, ...stoneArcExclusions].filter((v): v is RuinsExclusionZone => v !== null),
          spawnPropExclusions,
        )
      }
    }

    if (CarConfig.isSessionMultiplayer()) {
      const mpPeek = CarConfig.peekGameStartMultiplayerSnapshot()
      if (mpPeek != null && mpPeek.pl.length > 0) {
        const baseX = spawnX
        const baseZ = spawnZ
        const baseYaw = spawnYaw
        const slot = CarConfig.mpSpawnSlotIndexForLocalId(mpPeek.localId, mpPeek.pl)
        const d = CarConfig.MP_SPAWN_XZ[slot]!
        spawnX = baseX + d.x
        spawnZ = baseZ + d.z
        spawnY = ground.heightAt(spawnX, spawnZ) + CarConfig.SPAWN_Y
        spawnYaw = baseYaw
      }
    }

    const jeepRoot = chassisGltf.scene
    jeepRoot.scale.setScalar(CarConfig.JEEP_SCALE)

    const car = new THREE.Group()
    car.position.set(spawnX, spawnY, spawnZ)
    this.scene.add(car)
    car.add(jeepRoot)

    const { halfExtents, centerOffset } = CarGeometry.computeChassisCuboid(jeepRoot, car)
    /** Align mesh pivot with AABB center so physics COM (cuboid center) matches visuals. */
    jeepRoot.position.sub(centerOffset)
    car.updateMatrixWorld(true)
    const chassisOrigin = new THREE.Vector3(0, 0, 0)
    const chassisColliderDesc = CarGeometry.buildChassisColliderDesc(
      RAPIER,
      jeepRoot,
      car,
      CarConfig.CHASSIS_COLLIDER_MODE,
      halfExtents,
      chassisOrigin,
    )
    const wheelsVisual = CarGeometry.addTyresToCar(car, tyreGltf.scene, halfExtents, chassisOrigin)
    const forwardAlongX = halfExtents.x >= halfExtents.z
    const frontBias = CarConfig.CHASSIS_FRONT_WEIGHT_BIAS_M
    const lowerBias = CarConfig.CHASSIS_WEIGHT_LOWER_M
    const biasX = forwardAlongX ? frontBias : 0
    const biasZ = forwardAlongX ? 0 : -frontBias
    chassisColliderDesc.setTranslation(biasX, -lowerBias, biasZ)

    jeepRoot.traverse((obj) => {
      const m = obj as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
      }
    })
    if (CarConfig.activeChassisUrl === CarConfig.CHASSIS_2_MODEL_URL) {
      this.clampLocalChassis2Emissive(jeepRoot)
    }
    this.applyReadableVehiclePaint(car)

    const pondZone =
      CarConfig.USE_DESERT_TERRAIN && ground instanceof DesertTerrainGround
        ? {
            surfaceY: ground.terrainMinY + CarConfig.POND_SURFACE_ABOVE_MIN_Y,
            halfExtent: CarConfig.TERRAIN_HALF_EXTENT,
            centerX: CarConfig.POND_CENTER_X,
            centerZ: CarConfig.POND_CENTER_Z,
          }
        : null

    this.raycastCar = new RaycastCar(
      this.world,
      car,
      wheelsVisual,
      halfExtents,
      forwardAlongX,
      chassisColliderDesc,
      pondZone,
    )
    this.raycastCar.chassisBody.setRotation(
      new RAPIER.Quaternion(0, Math.sin(spawnYaw * 0.5), 0, Math.cos(spawnYaw * 0.5)),
      true,
    )
    this.raycastCar.syncGroupFromPhysics()
    this.raycastCar.setResetSpawn(spawnX, spawnY, spawnZ)
    this.resetHistory.length = 0
    this.resetHistory.push({ x: spawnX, z: spawnZ })
    this.resetHistorySampleT = 0
    this.prevResetPressed = false
    this.carWheels = wheelsVisual
    this.driveFx = new CarDriveEffects(this.scene, ground, pondZone)
    const carLength = 2 * Math.max(halfExtents.x, halfExtents.z) * CarConfig.NAV_ARROW_LENGTH_SCALE
    this.navArrowRoot = this.createCheckpointNavArrow(carLength)
    this.navArrowRoot.visible = false
    this.scene.add(this.navArrowRoot)
    this.rainOverlay = new RainOverlayEffect(this.scene, this.camera, {
      overlayOnly: true,
      intensity: 0,
      speed: 0.9,
      brightness: 1,
      zoom: 1.45,
    })
    this.pondOverlayT = 0
    this.prevPondWade = 0
    this.cameraFollower.setTarget(this.raycastCar.group)
    /** One tick so camera Y/orbit matches the car before the first render (avoids fixed world Y). */
    this.cameraFollower.update(1 / 60, this.raycastCar.chassisBody)

    this.movement.attach()
    window.addEventListener('keydown', this.onGlobalKeyDown, true)
    window.addEventListener('keydown', (e: KeyboardEvent) => this.startRaceTimerFromKey(e), true)

    if (import.meta.env.DEV) {
      let physicsDebugVisible = false
      window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.repeat) return
        if (e.code === 'KeyP') {
          physicsDebugVisible = !physicsDebugVisible
          this.physicsHelper.visible = physicsDebugVisible
          return
        }
        if (e.code === 'KeyG') {
          void this.exportTerrainPropsGlb()
        }
      })
    }

    this.raceHudReady = true
    await this.connectMultiplayerIfConfigured()
  }

  start(): void {
    requestAnimationFrame((t) => this.frame(t))
  }

  /**
   * Start race clock on keydown (capture). No checkpoint route required (works in free drive).
   * Enter / T / W / ↑ — first qualifying key sets `raceTimerStartMs` once until reset/finish.
   */
  private startRaceTimerFromKey(event: KeyboardEvent): void {
    if (!this.raceHudReady || CarConfig.SCENE_MODE !== 'driving') return
    if (this.paused) return
    if (event.repeat) return
    if (this.raycastCar === null) return
    if (CarConfig.isSessionMultiplayer()) return
    if (this.raceFinished || this.raceTimerStartMs !== null) return

    const c = event.code
    const k = event.key
    const fromEnterOrT =
      c === 'Enter' ||
      c === 'NumpadEnter' ||
      c === 'KeyT' ||
      k === 'Enter' ||
      k === 't' ||
      k === 'T'
    const fromDriveKey = c === 'KeyW' || c === 'ArrowUp'
    if (!fromEnterOrT && !fromDriveKey) return

    if (fromEnterOrT) event.preventDefault()
    this.raceTimerStartMs = performance.now()
  }

  /** WebAudio unlock + quick mute toggle (`M`). */
  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    this.gameAudio.unlockFromUserGesture()
    const k = event.key
    if (event.repeat) return
    if (k === 'Escape') {
      event.preventDefault()
      if (this.raceHudReady && !this.gameOverOverlayEl.hidden) return
      this.setPaused(!this.paused)
      return
    }
    if (k !== 'm' && k !== 'M') return
    const muted = this.gameAudio.toggleMute()
    this.syncPauseSoundToggle()
    this.hudStatusEl.textContent = muted ? 'Audio muted (M)' : 'Audio on (M)'
    window.setTimeout(() => {
      if (this.hudStatusEl.textContent === 'Audio muted (M)' || this.hudStatusEl.textContent === 'Audio on (M)') {
        this.hudStatusEl.textContent = ''
      }
    }, 1300)
  }

  private setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    this.gameAudio.setPaused(paused)
    this.clearMovementInput()
    if (paused) {
      this.showPauseMain()
      return
    }
    this.pauseOverlayEl.hidden = true
    this.pausePanelOptionsEl.hidden = true
    this.pausePanelMainEl.hidden = false
    this.timer.reset()
  }

  private showPauseMain(): void {
    this.pauseOverlayEl.hidden = false
    this.pausePanelMainEl.hidden = false
    this.pausePanelOptionsEl.hidden = true
  }

  private showPauseOptions(): void {
    this.pauseOverlayEl.hidden = false
    this.pausePanelMainEl.hidden = true
    this.pausePanelOptionsEl.hidden = false
    this.syncPauseSoundToggle()
  }

  private clearMovementInput(): void {
    this.movement.forward = 0
    this.movement.right = 0
    this.movement.brake = 0
    this.movement.reset = false
  }

  private hideMpRaceCountdownOverlay(): void {
    const el = this.mpRaceCountdownEl
    if (el) {
      el.hidden = true
      el.textContent = ''
    }
  }

  /** 3,2,1 + GO, blocks input and drive until `tEnd` + optional GO flash; sets shared `raceTimerStartMs` at `tEnd`. */
  private syncMultiplayerRaceCountdown(): void {
    if (this.raycastCar == null) return
    if (this.mp == null || this.mpRaceStartPerf == null) {
      this.hideMpRaceCountdownOverlay()
      return
    }
    const tEnd = this.mpRaceStartPerf
    const now = performance.now()
    const rem = tEnd - now
    if (rem > 0) {
      this.clearMovementInput()
      this.raycastCar.setDriveEnabled(false)
      this.raceTimerStartMs = null
      const n = Math.ceil(rem / 1000)
      const el = this.mpRaceCountdownEl
      if (el) {
        el.hidden = false
        el.textContent = String(Math.min(3, Math.max(1, n)))
      }
      return
    }
    if (this.raceTimerStartMs == null) {
      this.raceTimerStartMs = tEnd
    }
    if (rem > -CarPhysicsApp.MP_RACE_GO_FLASH_S) {
      const el = this.mpRaceCountdownEl
      if (el) {
        el.hidden = false
        el.textContent = 'GO!'
      }
    } else {
      this.hideMpRaceCountdownOverlay()
    }
    if (!this.raceFinished) {
      this.raycastCar.setDriveEnabled(true)
    }
  }

  private quitGame(): void {
    this.setPaused(false)
    window.close()
    window.location.href = 'about:blank'
  }

  private syncPauseSoundToggle(): void {
    const soundOn = !this.gameAudio.isMuted()
    this.pauseSoundToggleEl.setAttribute('aria-pressed', soundOn ? 'true' : 'false')
    this.pauseSoundToggleTextEl.textContent = soundOn ? 'ON' : 'OFF'
  }

  private static hueForPeerId(id: string): number {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) % 9_001
    return h / 9_001
  }

  private syncHudMultiplayerCount(): void {
    if (this.hudMpEl == null) return
    if (!this.mp?.connected) {
      this.hudMpEl.textContent = ''
      return
    }
    this.hudMpEl.textContent = `MP · ${1 + this.mpRemotes.size} players`
  }

  /**
   * Chassis GLBs often ship with MeshPhysicalMaterial (transmission / clearcoat / sheen) that reads milky
   * next to exp2 fog + ACES exposure. Keep the same maps and base `color`; only disable fog on the vehicle,
   * turn off glass-like transmission, and slightly tighten roughness so paint matches the sun key.
   */
  private applyReadableVehiclePaint(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (mat instanceof THREE.MeshPhysicalMaterial) {
          mat.fog = false
          mat.transmission = 0
          mat.thickness = 0
          mat.transmissionMap = null
          mat.sheen = 0
          mat.iridescence = 0
          mat.clearcoat = Math.min(mat.clearcoat, 0.12)
          mat.roughness = THREE.MathUtils.clamp(mat.roughness * 0.88 + 0.04, 0.1, 1)
          mat.metalness = THREE.MathUtils.clamp(mat.metalness, 0, 1)
        } else if (mat instanceof THREE.MeshStandardMaterial) {
          mat.fog = false
          mat.roughness = THREE.MathUtils.clamp(mat.roughness * 0.88 + 0.04, 0.1, 1)
        } else if ('fog' in mat && typeof (mat as { fog?: boolean }).fog === 'boolean') {
          ;(mat as { fog: boolean }).fog = false
        }
      }
    })
  }

  /** Tones down baked-in warm emissive on `chassis_2.glb` only (local + remote). */
  private clampLocalChassis2Emissive(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material
      const fix = (mm: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial) => {
        mm.emissiveMap = null
        const c = mm.emissive
        if (c.r + c.g + c.b > 0.2) {
          c.multiplyScalar(0.5)
        }
        mm.emissiveIntensity = Math.min(0.12, mm.emissiveIntensity * 0.25)
      }
      if (Array.isArray(mat)) {
        for (const mm of mat) {
          if (mm instanceof THREE.MeshStandardMaterial || mm instanceof THREE.MeshPhysicalMaterial) fix(mm)
        }
      } else if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial) {
        fix(mat)
      }
    })
  }

  private applyRemotePlayerVisualTint(root: THREE.Object3D, hue: number, vehicle: 1 | 2 | 3): void {
    const dimChassis = vehicle === 2 || vehicle === 3
    const emissive = new THREE.Color().setHSL(
      hue,
      dimChassis ? 0.2 : 0.38,
      dimChassis ? 0.07 : 0.2,
    )
    const intensity = dimChassis ? 0.09 : 0.2
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const mat = m.material
        const one = (mm: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial) => {
          mm.emissive = emissive.clone()
          mm.emissiveIntensity = intensity
        }
        if (Array.isArray(mat)) {
          for (const mm of mat) {
            if (mm instanceof THREE.MeshStandardMaterial || mm instanceof THREE.MeshPhysicalMaterial) one(mm)
          }
        } else if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial) {
          one(mat)
        }
      }
    })
    if (vehicle === 2) {
      this.clampLocalChassis2Emissive(root)
    }
  }

  /** Troika SDF nameplate: 2m above car pivot; always on top in scene (no z-fight with chassis). */
  private static nameFromRosterRow(
    row: {
      playerName?: string
      n?: string
      name?: string
      displayName?: string
      label?: string
    } | null | undefined,
  ): string {
    if (row == null) return 'Player'
    const s = String(row.playerName ?? row.n ?? row.name ?? row.displayName ?? row.label ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 20)
    return s || 'Player'
  }

  private buildPlayerNameText(displayName: string): Promise<Text> {
    return new Promise((resolve) => {
      const t = new Text()
      t.text = (displayName.trim().replace(/\s+/g, ' ').slice(0, 20) || 'Player')
      t.fontSize = 0.42
      t.letterSpacing = 0.04
      t.color = 0xf8f0e4
      t.outlineWidth = '8%'
      t.outlineColor = 0x0d0806
      t.outlineOpacity = 0.95
      t.strokeWidth = '2.2%'
      t.strokeColor = 0x2a1e18
      t.strokeOpacity = 0.55
      t.anchorX = 'center'
      t.anchorY = 'middle'
      t.position.set(0, 2, 0)
      t.depthOffset = -0.35
      t.sync(() => {
        t.renderOrder = 60
        const mat = t.material
        const apply = (m: THREE.Material) => {
          m.depthTest = false
          m.depthWrite = false
          m.transparent = true
          if ('fog' in m) (m as { fog: boolean }).fog = false
        }
        if (Array.isArray(mat)) {
          for (const m of mat) if (m) apply(m)
        } else if (mat) {
          apply(mat)
        }
        resolve(t)
      })
    })
  }

  private async getRemoteCarVisualClone(vehicle: 1 | 2 | 3): Promise<THREE.Group> {
    let src = this.remoteCarTemplate.get(vehicle)
    if (src == null) {
      const chassisUrl =
        vehicle === 1
          ? CarConfig.CHASSIS_1_MODEL_URL
          : vehicle === 2
            ? CarConfig.CHASSIS_2_MODEL_URL
            : CarConfig.CHASSIS_3_MODEL_URL
      const wheelUrl =
        vehicle === 1
          ? CarConfig.WHEEL_MODEL_URL_1
          : vehicle === 2
            ? CarConfig.WHEEL_MODEL_URL_2
            : CarConfig.WHEEL_MODEL_URL_3
      const [chassisGltf, tyreGltf] = await Promise.all([
        this.mpGltfLoader.loadAsync(chassisUrl),
        this.mpGltfLoader.loadAsync(wheelUrl),
      ])
      const chassisRoot = chassisGltf.scene
      chassisRoot.scale.setScalar(CarConfig.JEEP_SCALE)
      const car = new THREE.Group()
      car.add(chassisRoot)
      const { halfExtents, centerOffset } = CarGeometry.computeChassisCuboid(chassisRoot, car)
      chassisRoot.position.sub(centerOffset)
      car.updateMatrixWorld(true)
      const chassisOrigin = new THREE.Vector3(0, 0, 0)
      const pl = CarConfig.tyrePlacementForChassisUrl(chassisUrl)
      CarGeometry.addTyresToCar(car, tyreGltf.scene, halfExtents, chassisOrigin, pl)
      car.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true
          m.receiveShadow = true
        }
      })
      this.applyReadableVehiclePaint(car)
      this.remoteCarTemplate.set(vehicle, car)
      src = car
    }
    return (src as THREE.Group).clone(true) as THREE.Group
  }

  private static buildRemoteWheelVisualState(carRoot: THREE.Group): {
    wheels: THREE.Object3D[]
    wheelRadius: number[]
    wheelBaseLocal: THREE.Quaternion[]
    hubLocal: THREE.Vector3[]
    spinAccum: number[]
    forwardAlongX: boolean
  } | null {
    const chassis = carRoot.children[0]
    if (chassis == null) return null
    const { halfExtents } = CarGeometry.computeChassisCuboid(chassis as THREE.Object3D, carRoot)
    const forwardAlongX = halfExtents.x >= halfExtents.z
    const wheels = carRoot.children.slice(1) as THREE.Object3D[]
    if (wheels.length !== 4) return null
    return {
      wheels,
      wheelRadius: wheels.map((w) => CarGeometry.estimateWheelRollingRadius(w)),
      wheelBaseLocal: wheels.map((w) => w.quaternion.clone()),
      hubLocal: wheels.map((w) => w.position.clone()),
      spinAccum: [0, 0, 0, 0],
      forwardAlongX,
    }
  }

  private async expectRemotePlayer(id: string, vehicle: 1 | 2 | 3, displayName: string): Promise<void> {
    if (this.mp && id === this.mp.localId) return
    if (this.raycastCar == null) return
    if (this.mpRemotes.has(id)) return
    const hue = CarPhysicsApp.hueForPeerId(id)
    const carRoot = await this.getRemoteCarVisualClone(vehicle)
    this.applyRemotePlayerVisualTint(carRoot, hue, vehicle)
    const nameLabel = await this.buildPlayerNameText(displayName)
    const group = new THREE.Group()
    group.add(carRoot)
    group.add(nameLabel)
    group.visible = false
    this.scene.add(group)
    const carVisual = carRoot as THREE.Group
    const layout = CarPhysicsApp.buildRemoteWheelVisualState(carVisual)
    this.mpRemotes.set(id, {
      group,
      carVisual,
      hasPacket: false,
      vehicle,
      nameLabel,
      p: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      targetP: new THREE.Vector3(),
      targetQ: new THREE.Quaternion(),
      vel: new THREE.Vector3(),
      targetVel: new THREE.Vector3(),
      wheels: layout?.wheels ?? [],
      wheelRadius: layout?.wheelRadius ?? [],
      wheelBaseLocal: layout?.wheelBaseLocal ?? [],
      hubLocal: layout?.hubLocal ?? [],
      spinAccum: layout?.spinAccum ?? [0, 0, 0, 0],
      forwardAlongX: layout?.forwardAlongX ?? true,
      remoteSteerSmoothed: 0,
      proxyBody: null,
    })
    this.syncHudMultiplayerCount()
  }

  private disposeRemoteObject3D(o: THREE.Object3D): void {
    o.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose()
        const m = obj.material
        if (Array.isArray(m)) {
          for (const mm of m) {
            ;(mm as THREE.Material).dispose()
          }
        } else m?.dispose()
      }
    })
  }

  private removeRemotePlayer(id: string): void {
    const e = this.mpRemotes.get(id)
    if (e) {
      if (e.proxyBody) {
        this.world.removeRigidBody(e.proxyBody)
        e.proxyBody = null
      }
      e.nameLabel.removeFromParent()
      e.nameLabel.dispose()
      this.scene.remove(e.group)
      this.disposeRemoteObject3D(e.group)
      this.mpRemotes.delete(id)
    }
    this.syncHudMultiplayerCount()
  }

  /**
   * Convex hull chassis collider from the remote GLB mesh (same path as local `convexHull` framing).
   * Falls back to cuboid inside `buildChassisColliderDesc` if the hull cannot be built.
   */
  private ensureRemotePlayerProxyBody(
    e: {
      carVisual: THREE.Group
      p: THREE.Vector3
      q: THREE.Quaternion
      vel: THREE.Vector3
      proxyBody: RAPIER.RigidBody | null
    },
  ): void {
    if (e.proxyBody != null) return
    const chassis = e.carVisual.children[0] as THREE.Object3D | undefined
    if (chassis == null) return
    const chassisOrigin = new THREE.Vector3(0, 0, 0)
    const { halfExtents } = CarGeometry.computeChassisCuboid(chassis, e.carVisual)
    const forwardAlongX = halfExtents.x >= halfExtents.z
    const frontBias = CarConfig.CHASSIS_FRONT_WEIGHT_BIAS_M
    const lowerBias = CarConfig.CHASSIS_WEIGHT_LOWER_M
    const biasX = forwardAlongX ? frontBias : 0
    const biasZ = forwardAlongX ? 0 : -frontBias
    const colliderDesc = CarGeometry.buildChassisColliderDesc(
      RAPIER,
      chassis,
      e.carVisual,
      'convexHull',
      halfExtents,
      chassisOrigin,
    )
      .setTranslation(biasX, -lowerBias, biasZ)
      .setFriction(0.92)
      .setRestitution(0.08)
      .setMass(CarConfig.CHASSIS_MASS)
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(e.p.x, e.p.y, e.p.z)
      .setRotation(new RAPIER.Quaternion(e.q.x, e.q.y, e.q.z, e.q.w))
      .setLinvel(e.vel.x, e.vel.y, e.vel.z)
      .setGravityScale(0)
      .setLinearDamping(0.06)
      .setAngularDamping(CarConfig.CHASSIS_ANGULAR_DAMPING * 0.85)
      .setCcdEnabled(true)
      .setCanSleep(false)
    const body = this.world.createRigidBody(bodyDesc)
    this.world.createCollider(colliderDesc, body)
    e.proxyBody = body
  }

  private applyRemoteKinematics(id: string, k: MultiplayerKinematics): void {
    if (id === this.mp?.localId) return
    const e = this.mpRemotes.get(id)
    if (e) {
      e.targetP.set(k.px, k.py, k.pz)
      e.targetQ.set(k.qx, k.qy, k.qz, k.qw)
      e.targetVel.set(k.vx, k.vy, k.vz)
      if (!e.hasPacket) {
        e.hasPacket = true
        e.p.copy(e.targetP)
        e.q.copy(e.targetQ)
        e.vel.copy(e.targetVel)
        e.group.position.copy(e.p)
        e.group.quaternion.copy(e.q)
        e.group.visible = true
        this.ensureRemotePlayerProxyBody(e)
        if (e.proxyBody) {
          const b = e.proxyBody
          b.setTranslation(new RAPIER.Vector3(e.p.x, e.p.y, e.p.z), true)
          b.setRotation(new RAPIER.Quaternion(e.q.x, e.q.y, e.q.z, e.q.w), true)
          b.setLinvel(new RAPIER.Vector3(e.vel.x, e.vel.y, e.vel.z), true)
          b.setAngvel(new RAPIER.Vector3(0, 0, 0), true)
        }
      }
    }
  }

  private tearDownMultiplayer(): void {
    this.disposeLocalPlayerNameplate()
    for (const id of [...this.mpRemotes.keys()]) {
      this.removeRemotePlayer(id)
    }
    CarConfig.setOnMultiplayerRoomEndedInGame(null)
    this.mp?.disconnect()
    this.mp = null
    this.mpSendAcc = 0
    this.mpRaceStartPerf = null
    this.hideMpRaceCountdownOverlay()
    this.syncHudMultiplayerCount()
  }

  private async connectMultiplayerIfConfigured(): Promise<void> {
    if (this.raycastCar == null) return
    const pre = CarConfig.takePreconnectedMultiplayerClient()
    const snap = CarConfig.takeGameStartMultiplayerSnapshot()
    const peerIds = CarConfig.takeGameStartPeerIds()
    this.tearDownMultiplayer()
    if (pre == null) {
      this.syncHudMultiplayerCount()
      return
    }
    this.mp = pre
    {
      let t0 = CarConfig.takeMultiplayerRaceStartPerf()
      if (t0 == null) t0 = performance.now()
      this.mpRaceStartPerf = t0
      this.raycastCar.setDriveEnabled(false)
    }
    const local = snap?.localId ?? this.mp.localId ?? ''
    if (snap && snap.pl.length > 0) {
      for (const pid of snap.peerOrder) {
        if (pid === local) continue
        const row = snap.pl.find((p) => p.i === pid)
        const v = CarConfig.normalizeVehicleWire(row?.v)
        const label = CarPhysicsApp.nameFromRosterRow(row)
        await this.expectRemotePlayer(pid, v, label)
      }
    } else {
      for (const id of peerIds) {
        if (id === local) continue
        await this.expectRemotePlayer(id, 1, 'Player')
      }
    }
    this.mp.setInGameMode(true)
    CarConfig.setOnMultiplayerRoomEndedInGame(() => this.tearDownMultiplayer())
    this.mp.onPeerKinematics = (id, k) => {
      this.applyRemoteKinematics(id, k)
    }
    this.mp.onLeave = (id) => {
      this.removeRemotePlayer(id)
    }
    this.mp.onConnectionLost = (info) => {
      this.hudStatusEl.textContent = `Multiplayer disconnected (code ${info.code})`
      window.setTimeout(() => {
        if (this.hudStatusEl.textContent.startsWith('Multiplayer disconnected')) {
          this.hudStatusEl.textContent = ''
        }
      }, 2000)
      this.tearDownMultiplayer()
    }
    this.syncHudMultiplayerCount()
    void this.attachLocalPlayerNameplate()
  }

  private disposeLocalPlayerNameplate(): void {
    if (this.localPlayerNameLabel) {
      this.localPlayerNameLabel.removeFromParent()
      this.localPlayerNameLabel.dispose()
      this.localPlayerNameLabel = null
    }
  }

  private async attachLocalPlayerNameplate(): Promise<void> {
    if (this.raycastCar == null) return
    this.disposeLocalPlayerNameplate()
    if (!CarConfig.isSessionMultiplayer()) return
    const raw = CarConfig.getSessionMultiplayerDisplayName().trim()
    if (raw === '') return
    const t = await this.buildPlayerNameText(raw)
    this.raycastCar.group.add(t)
    this.localPlayerNameLabel = t
  }

  private buildLocalKinematics(): MultiplayerKinematics {
    const g = this.raycastCar!.group
    const q = g.quaternion
    const p = g.position
    const v = this.raycastCar!.chassisBody.linvel()
    return {
      px: p.x,
      py: p.y,
      pz: p.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      vx: v.x,
      vy: v.y,
      vz: v.z,
      vehicle: CarConfig.activeVehicleChoice,
    }
  }

  /**
   * Remote cars are not simulated in Rapier on this client; use network pose + velocity to
   * animate wheels (spin, steer, suspension compression) against the same ground height field
   * as the local car so motion reads closer to full physics.
   */
  private updateRemoteVehicleVisuals(
    e: {
      group: THREE.Group
      carVisual: THREE.Group
      vel: THREE.Vector3
      targetVel: THREE.Vector3
      wheels: THREE.Object3D[]
      wheelRadius: number[]
      wheelBaseLocal: THREE.Quaternion[]
      hubLocal: THREE.Vector3[]
      spinAccum: number[]
      forwardAlongX: boolean
      remoteSteerSmoothed: number
    },
    dt: number,
  ): void {
    if (e.wheels.length !== 4 || !this.driveGround) return
    const t = Math.max(1e-6, dt)
    const g = e.group
    const carVisual = e.carVisual
    const aV = 1.0 - Math.exp(-16 * t)
    e.vel.lerp(e.targetVel, aV)
    carVisual.updateMatrixWorld(true)

    if (e.forwardAlongX) this._mpRemFwd.set(1, 0, 0)
    else this._mpRemFwd.set(0, 0, -1)
    this._mpRemFwd.applyQuaternion(g.quaternion)
    this._mpRemFwd.y = 0
    if (this._mpRemFwd.lengthSq() < 1e-10) this._mpRemFwd.set(0, 0, 1)
    else this._mpRemFwd.normalize()
    this._mpRemRight.crossVectors(this._mpChassisUp, this._mpRemFwd)
    if (this._mpRemRight.lengthSq() < 1e-10) return
    this._mpRemRight.normalize()

    this._mpRemVelFlat.set(e.vel.x, 0, e.vel.z)
    const forwardSpeed = this._mpRemVelFlat.dot(this._mpRemFwd)
    const lateralSpeed = this._mpRemVelFlat.dot(this._mpRemRight)
    const speedXZ = this._mpRemVelFlat.length()
    const maxSt = CarConfig.MAX_STEER_ANGLE * CarConfig.steerSpeedScale(speedXZ)
    const steerTarget =
      THREE.MathUtils.clamp(lateralSpeed / (Math.abs(forwardSpeed) * 0.9 + 3.5), -1, 1) * maxSt * 0.95
    e.remoteSteerSmoothed += (steerTarget - e.remoteSteerSmoothed) * (1 - Math.exp(-20 * t))

    const rest = CarConfig.SUSPENSION_REST_LENGTH
    const maxTravel = 0.22
    const spinRate = forwardSpeed

    for (let i = 0; i < 4; i++) {
      const wheel = e.wheels[i]!
      const rad = e.wheelRadius[i]!
      const base = e.wheelBaseLocal[i]!
      const hub = e.hubLocal[i]!

      this._mpRemConn.copy(hub)
      this._mpRemHubWorld.copy(hub).applyMatrix4(carVisual.matrixWorld)
      const groundY = this.driveGround.heightAt(this._mpRemHubWorld.x, this._mpRemHubWorld.z)
      const gap = this._mpRemHubWorld.y - groundY - rad * 0.9
      const susp = THREE.MathUtils.clamp(rest * 0.52 - Math.min(gap, rest * 1.15), 0, maxTravel)
      this._mpRemConn.y -= susp
      wheel.position.copy(this._mpRemConn)

      e.spinAccum[i]! += (spinRate / Math.max(0.07, rad)) * t

      if (e.forwardAlongX) this._mpRemAxleLocal.set(0, 0, -1)
      else this._mpRemAxleLocal.set(-1, 0, 0)
      this._mpRemWheelRot.setFromAxisAngle(this._mpRemAxleLocal, e.spinAccum[i]!)
      const steer = i === 0 || i === 1 ? e.remoteSteerSmoothed : 0
      this._mpRemWheelSteer.setFromAxisAngle(this._mpChassisUp, steer)
      wheel.quaternion.copy(base)
      wheel.quaternion.premultiply(this._mpRemWheelRot)
      wheel.quaternion.premultiply(this._mpRemWheelSteer)
    }
  }

  /** Interpolate network pose, move Three.js roots, wheel visuals, remote nameplates. */
  private updateMpRemotesInterpolationVisualsBillboards(dt: number): void {
    if (this.raycastCar == null) return
    for (const e of this.mpRemotes.values()) {
      if (!e.hasPacket) continue
      const a = 1.0 - Math.exp(-12 * dt)
      const b = 1.0 - Math.exp(-14 * dt)
      e.p.lerp(e.targetP, a)
      e.q.slerp(e.targetQ, b)
      e.group.position.copy(e.p)
      e.group.quaternion.copy(e.q)
      this.updateRemoteVehicleVisuals(e, dt)
      this._nameBillboardInv.copy(e.group.quaternion).invert()
      e.nameLabel.quaternion.copy(this.camera.quaternion).premultiply(this._nameBillboardInv)
    }
  }

  /**
   * Drive **dynamic** peer proxies toward the smoothed network pose, before `world.step()`.
   * Blends in the body’s current linear/angular velocity so contact impulses from the last step
   * are not erased (full `setLinvel(target)` would make hits feel inert).
   */
  /**
   * The mesh is updated toward network data *before* `step()`, but the collider is the dynamic `proxyBody`.
   * After contacts resolve, the proxy can move while `e.p` / `e.group` still reflect the pre-step network pose
   * — the other car then looks “unmovable”. Copy the proxy back so visuals match the physics response.
   */
  private syncMpRemoteVisualsFromProxyAfterStep(): void {
    if (this.raycastCar == null) return
    for (const e of this.mpRemotes.values()) {
      if (!e.hasPacket || e.proxyBody == null) continue
      const b = e.proxyBody
      const t = b.translation()
      const r = b.rotation()
      const v = b.linvel()
      e.p.set(t.x, t.y, t.z)
      e.q.set(r.x, r.y, r.z, r.w)
      e.vel.copy(v)
      e.group.position.copy(e.p)
      e.group.quaternion.copy(e.q)
    }
  }

  private syncMpRemoteDynamicProxyBodies(_dt: number): void {
    const kp = CarPhysicsApp.MP_PROXY_TRACK_KP
    const maxC = CarPhysicsApp.MP_PROXY_TRACK_MAX_CORR
    const kAng = CarPhysicsApp.MP_PROXY_TRACK_K_ANG
    const maxOmega = CarPhysicsApp.MP_PROXY_TRACK_MAX_ANG
    const rkBase = CarPhysicsApp.MP_PROXY_PHYS_RETAIN

    for (const e of this.mpRemotes.values()) {
      if (!e.hasPacket || e.proxyBody == null) continue
      const b = e.proxyBody
      const tr = b.translation()
      const posErr = Math.hypot(e.p.x - tr.x, e.p.y - tr.y, e.p.z - tr.z)
      /** Large pose error usually means we were shoved by a contact — keep more of `linvel`/`angvel`. */
      const shove = THREE.MathUtils.clamp(posErr / 0.42, 0, 1)
      const rk = THREE.MathUtils.clamp(rkBase + shove * 0.2, 0.36, 0.82)
      const tk = 1 - rk
      const lv = b.linvel()
      const cx = THREE.MathUtils.clamp((e.p.x - tr.x) * kp, -maxC, maxC)
      const cy = THREE.MathUtils.clamp((e.p.y - tr.y) * kp, -maxC, maxC)
      const cz = THREE.MathUtils.clamp((e.p.z - tr.z) * kp, -maxC, maxC)
      const tx = e.vel.x + cx
      const ty = e.vel.y + cy
      const tz = e.vel.z + cz
      b.setLinvel(new RAPIER.Vector3(lv.x * rk + tx * tk, lv.y * rk + ty * tk, lv.z * rk + tz * tk), true)

      const rr = b.rotation()
      this._mpProxyQCur.set(rr.x, rr.y, rr.z, rr.w)
      this._mpProxyQErr.copy(e.q).multiply(this._mpProxyQInv.copy(this._mpProxyQCur).invert())
      if (this._mpProxyQErr.w < 0) {
        this._mpProxyQErr.set(
          -this._mpProxyQErr.x,
          -this._mpProxyQErr.y,
          -this._mpProxyQErr.z,
          -this._mpProxyQErr.w,
        )
      }
      const wCl = THREE.MathUtils.clamp(this._mpProxyQErr.w, -1, 1)
      const vlen = Math.hypot(this._mpProxyQErr.x, this._mpProxyQErr.y, this._mpProxyQErr.z)
      let wx = 0
      let wy = 0
      let wz = 0
      if (vlen > 1e-6) {
        const ang = 2 * Math.atan2(vlen, wCl)
        const inv = 1 / vlen
        const ax = this._mpProxyQErr.x * inv
        const ay = this._mpProxyQErr.y * inv
        const az = this._mpProxyQErr.z * inv
        const omegaMag = Math.min(ang * kAng, maxOmega)
        wx = ax * omegaMag
        wy = ay * omegaMag
        wz = az * omegaMag
      }
      const av = b.angvel()
      b.setAngvel(new RAPIER.Vector3(av.x * rk + wx * tk, av.y * rk + wy * tk, av.z * rk + wz * tk), true)
    }
  }

  /** After physics: send local state, HUD, local nameplate billboarding. */
  private updateMpLocalSendAndHud(dt: number): void {
    if (this.raycastCar == null) return
    if (this.localPlayerNameLabel && this.raycastCar) {
      this._nameBillboardInv.copy(this.raycastCar.group.quaternion).invert()
      this.localPlayerNameLabel.quaternion
        .copy(this.camera.quaternion)
        .premultiply(this._nameBillboardInv)
    }
    if (this.mp == null || !this.mp.connected) {
      this.syncHudMultiplayerCount()
      return
    }
    if (!this.paused) {
      this.mpSendAcc += dt
      const minSep = 1.0 / CarPhysicsApp.MP_SEND_HZ
      if (this.mpSendAcc >= minSep) {
        this.mpSendAcc = 0
        this.mp.sendKinematics(this.buildLocalKinematics())
      }
    }
    this.syncHudMultiplayerCount()
  }

  private formatRaceTime(seconds: number): string {
    const s = Math.max(0, seconds)
    const totalSec = Math.floor(s + 1e-6)
    const sec = totalSec % 60
    const m = Math.floor(totalSec / 60)
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  private updateDrivingHud(): void {
    if (!this.raycastCar) return
    const v = this.raycastCar.chassisBody.linvel()
    const kmh = Math.hypot(v.x, v.z) * 3.6
    this.hudSpeedKmhEl.textContent = `${kmh.toFixed(0)} km/h`

    let tSec = 0
    if (this.raceFinished && this.raceTimerFrozenSec !== null) {
      tSec = this.raceTimerFrozenSec
    } else if (this.raceTimerStartMs !== null && !this.raceFinished) {
      tSec = (performance.now() - this.raceTimerStartMs) / 1000
    }
    this.hudTimerEl.textContent = this.formatRaceTime(tSec)

    const t = this.checkpointTotal
    this.hudCheckpointValueEl.textContent = t > 0 ? `${this.checkpointsPassed} / ${t}` : `0 / 0`
  }

  /** Ramps angular damping at high speed to reduce rollover while debugging with HUD. */
  private updateHighSpeedStability(): void {
    if (!this.raycastCar) return
    if (!this.raycastCar.getDriveEnabled()) {
      this.raycastCar.chassisBody.setAngularDamping(9)
      return
    }
    const v = this.raycastCar.chassisBody.linvel()
    const sxz = Math.hypot(v.x, v.z)
    const start = CarConfig.STABILITY_SPEED_DAMP_START
    const extra =
      sxz <= start
        ? 0
        : Math.min(
            CarConfig.STABILITY_ANG_DAMP_MAX_EXTRA,
            (sxz - start) * CarConfig.STABILITY_ANG_DAMP_PER_MS,
          )
    this.raycastCar.chassisBody.setAngularDamping(CarConfig.CHASSIS_ANGULAR_DAMPING + extra)
  }

  /** Keeps shadow frustum over the car so contact shadows read on the whole map. */
  private updateSunLight(): void {
    if (!this.raycastCar) return
    const c = this.raycastCar.group.position
    this.sunLight.position.set(
      c.x + this.sunOffsetWorld.x,
      c.y + this.sunOffsetWorld.y,
      c.z + this.sunOffsetWorld.z,
    )
    this.sunLight.target.position.copy(c)
    this.sunLight.target.updateMatrixWorld(true)

    this.skySunDir.copy(this.sunOffsetWorld).normalize()
    ;(this.sky.material as THREE.ShaderMaterial).uniforms['sunPosition'].value.copy(this.skySunDir)
    if (this.desertWater) {
      this.desertWater.material.uniforms['sunDirection'].value.copy(this.skySunDir)
    }
  }

  private readonly onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  private readonly frame = (timestamp?: number): void => {
    this.timer.update(timestamp)
    const dt = Math.min(this.timer.getDelta(), 0.05)
    this.world.timestep = dt

    if (!this.raycastCar || !this.driveFx) {
      this.rainOverlay?.update(dt)
      this.stats?.update()
      this.renderer.render(this.scene, this.camera)
      requestAnimationFrame((t) => this.frame(t))
      return
    }

    this.syncMultiplayerRaceCountdown()

    if (this.paused) {
      this.updateMpRemotesInterpolationVisualsBillboards(dt)
      this.updateMpLocalSendAndHud(dt)
      this.rainOverlay?.update(dt)
      this.stats?.update()
      this.renderer.render(this.scene, this.camera)
      requestAnimationFrame((t) => this.frame(t))
      return
    }

    this.updateResetHistoryAndSpawn(dt)
    this.updateFlipAutoReset(dt)

    this.updateMpRemotesInterpolationVisualsBillboards(dt)
    this.syncMpRemoteDynamicProxyBodies(dt)

    this.raycastCar.applyInput(this.movement, dt)
    this.raycastCar.vehicleController.updateVehicle(dt)
    this.world.step()
    this.syncMpRemoteVisualsFromProxyAfterStep()

    this.raycastCar.enforceGroundSpeedCap(this.mpRemotes.size > 0 ? 1.38 : 1)
    this.raycastCar.syncGroupFromPhysics()
    this.raycastCar.updateWheelMeshes(dt)
    this.updateMpLocalSendAndHud(dt)
    this.updateAudio(dt)

    this.updateHighSpeedStability()
    this.updateDrivingHud()
    this.updateSunLight()
    ;(this.sky.material as THREE.ShaderMaterial).uniforms['time'].value += dt
    if (this.desertWater) {
      this.desertWater.material.uniforms['time'].value += dt * CarConfig.POND_WATER_SHADER_TIME_SCALE
    }

    this.cameraFollower.update(dt, this.raycastCar.chassisBody)

    this.driveFx.update(dt, this.raycastCar, this.movement, this.carWheels)
    this.updateCheckpointProgress()
    this.updateNavArrow(dt)
    const wade = this.raycastCar.getPondWadeFactor()
    const enterWade = CarConfig.POND_OVERLAY_ENTRY_WADE
    if (this.prevPondWade < enterWade && wade >= enterWade) {
      this.pondOverlayT = CarConfig.POND_OVERLAY_HOLD_S + CarConfig.POND_OVERLAY_FADE_S
    }
    this.prevPondWade = wade
    if (this.rainOverlay) {
      const fade = CarConfig.POND_OVERLAY_FADE_S
      const peak = CarConfig.POND_OVERLAY_PEAK_INTENSITY
      if (this.pondOverlayT > 0) {
        this.pondOverlayT = Math.max(0, this.pondOverlayT - dt)
      }
      const intensity =
        this.pondOverlayT > fade
          ? peak
          : peak * THREE.MathUtils.clamp(this.pondOverlayT / Math.max(1e-6, fade), 0, 1)
      this.rainOverlay.setIntensity(intensity)
      this.rainOverlay.update(dt)
    }

    if (this.physicsHelper.visible) this.physicsHelper.update()
    this.stats?.update()
    this.renderer.render(this.scene, this.camera)
    requestAnimationFrame((t) => this.frame(t))
  }

  /**
   * Build checkpoint route: one smooth loop around the map by polar angle (no greedy zig-zag).
   * Ruins share the same sort so they land between the two arcs they sit between on that loop.
   * First checkpoint is the lowest-elevation arc; the cyclic order follows increasing angle from there.
   */
  private setupCheckpointsAndSpawnPlan(
    terrain: { heightAt(worldX: number, worldZ: number): number },
    arcExclusions: RuinsExclusionZone[],
    ruinsExclusion: RuinsExclusionZone | null,
  ): { x: number; y: number; z: number; yaw: number } | null {
    if (arcExclusions.length === 0) return null

    type Node = { v: THREE.Vector3; isRuins: boolean }
    const nodes: Node[] = arcExclusions.map((a) => ({
      v: new THREE.Vector3(a.x, terrain.heightAt(a.x, a.z) + 4.2, a.z),
      isRuins: false,
    }))
    if (ruinsExclusion) {
      nodes.push({
        v: new THREE.Vector3(
          ruinsExclusion.x,
          terrain.heightAt(ruinsExclusion.x, ruinsExclusion.z) + 4.2,
          ruinsExclusion.z,
        ),
        isRuins: true,
      })
    }

    let cx = 0
    let cz = 0
    for (const n of nodes) {
      cx += n.v.x
      cz += n.v.z
    }
    cx /= nodes.length
    cz /= nodes.length

    const withAngle = nodes.map((n) => ({
      n,
      t: Math.atan2(n.v.z - cz, n.v.x - cx),
    }))
    withAngle.sort((a, b) => a.t - b.t)

    let startRing = 0
    let startY = Infinity
    for (let k = 0; k < withAngle.length; k++) {
      if (withAngle[k]!.n.isRuins) continue
      const y = withAngle[k]!.n.v.y
      if (y < startY) {
        startY = y
        startRing = k
      }
    }

    const ordered: THREE.Vector3[] = []
    for (let step = 0; step < withAngle.length; step++) {
      ordered.push(withAngle[(startRing + step) % withAngle.length]!.n.v.clone())
    }

    this.checkpointRoute = ordered
    this.checkpointIdx = ordered.length > 0 ? 0 : -1
    this.checkpointTotal = ordered.length
    this.checkpointsPassed = 0
    this.raceFinished = false
    this.raceTimerStartMs = null
    this.raceTimerFrozenSec = null
    this.ensureCheckpointMesh()
    if (this.checkpointMesh && this.checkpointIdx >= 0) {
      this.checkpointMesh.visible = true
      this.checkpointMesh.position.copy(this.checkpointRoute[this.checkpointIdx]!)
      this.syncCheckpointOrbMaterial()
    }

    const target = ordered[0]!
    const radius = 50
    let best = { x: target.x - radius, z: target.z, score: Infinity }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const x = target.x + Math.cos(a) * radius
      const z = target.z + Math.sin(a) * radius
      const s = this.slopeAt(terrain, x, z, 6.5)
      if (s < best.score) best = { x, z, score: s }
    }
    const y = terrain.heightAt(best.x, best.z) + CarConfig.SPAWN_Y
    const yaw = Math.atan2(target.x - best.x, target.z - best.z)
    return { x: best.x, y, z: best.z, yaw }
  }

  private updateNavArrow(dt: number): void {
    if (!this.navArrowRoot || !this.raycastCar) return
    const active = this.checkpointIdx >= 0 && this.checkpointRoute.length > 0
    this.navArrowRoot.visible = active
    if (!active) {
      this.navArrowRouteWasActive = false
      return
    }

    const cp = this.checkpointRoute[this.checkpointIdx]!
    const car = this.raycastCar.group.position
    const y = car.y + CarConfig.NAV_ARROW_HEIGHT_ABOVE_CAR_M
    this.navArrowRoot.position.set(car.x, y, car.z)

    const justEnteredRoute = !this.navArrowRouteWasActive
    this.navArrowRouteWasActive = true

    const dx = cp.x - car.x
    const dz = cp.z - car.z
    const distSq = dx * dx + dz * dz
    if (distSq >= 0.04) {
      this._navLookTarget.set(cp.x, y, cp.z)
      this._navLookHelper.position.copy(this.navArrowRoot.position)
      this._navLookHelper.lookAt(this._navLookTarget)
      this._navQuatTarget.copy(this._navLookHelper.quaternion)
    } else if (justEnteredRoute) {
      this._navTmpFwd.set(0, 0, -1).applyQuaternion(this.raycastCar.group.quaternion)
      this._navTmpFwd.y = 0
      if (this._navTmpFwd.lengthSq() < 1e-8) this._navTmpFwd.set(0, 0, 1)
      else this._navTmpFwd.normalize()
      this._navLookTarget.copy(this.navArrowRoot.position).add(this._navTmpFwd)
      this._navLookHelper.position.copy(this.navArrowRoot.position)
      this._navLookHelper.lookAt(this._navLookTarget)
      this._navQuatTarget.copy(this._navLookHelper.quaternion)
    }

    if (justEnteredRoute) {
      this._navQuatCurrent.copy(this._navQuatTarget)
    } else {
      const k = 1 - Math.exp(-CarConfig.NAV_ARROW_ROTATION_SMOOTH * dt)
      this._navQuatCurrent.slerp(this._navQuatTarget, k)
    }
    this.navArrowRoot.quaternion.copy(this._navQuatCurrent)
  }

  /** Wide extruded chevron (NFS MW–style); local +Z is forward after setup, for `lookAt`. */
  private createCheckpointNavArrow(length: number): THREE.Group {
    const root = new THREE.Group()
    const L = Math.max(length, 1.2)
    const W = L * 0.46
    const shoulderY = L * 0.38

    const sh = new THREE.Shape()
    sh.moveTo(0, L)
    sh.lineTo(W * 0.52, shoulderY)
    sh.lineTo(W * 0.24, shoulderY)
    sh.lineTo(W * 0.24, 0)
    sh.lineTo(-W * 0.24, 0)
    sh.lineTo(-W * 0.24, shoulderY)
    sh.lineTo(-W * 0.52, shoulderY)
    sh.closePath()

    const depth = THREE.MathUtils.clamp(L * 0.065, 0.11, 0.38)
    const geo = new THREE.ExtrudeGeometry(sh, {
      depth,
      bevelEnabled: true,
      bevelThickness: depth * 0.22,
      bevelSize: depth * 0.16,
      bevelSegments: 2,
      curveSegments: 6,
    })
    geo.translate(0, 0, -depth * 0.5)

    const fillMat = new THREE.MeshStandardMaterial({
      color: 0x575b61,
      emissive: 0x2f3338,
      emissiveIntensity: 0.2,
      roughness: 0.46,
      metalness: 0.08,
      side: THREE.DoubleSide,
    })
    const outlineMat = new THREE.MeshStandardMaterial({
      color: 0xbfc4cb,
      emissive: 0x6e737a,
      emissiveIntensity: 0.16,
      roughness: 0.38,
      metalness: 0.06,
      side: THREE.DoubleSide,
    })

    const outline = new THREE.Mesh(geo.clone(), outlineMat)
    outline.scale.setScalar(1.09)
    outline.rotation.x = Math.PI / 2
    outline.castShadow = false
    outline.receiveShadow = false
    outline.renderOrder = 6

    const fill = new THREE.Mesh(geo, fillMat)
    fill.rotation.x = Math.PI / 2
    fill.castShadow = false
    fill.receiveShadow = false
    fill.renderOrder = 7

    root.add(outline)
    root.add(fill)

    const box = new THREE.Box3().setFromObject(root)
    const center = box.getCenter(new THREE.Vector3())
    outline.position.sub(center)
    fill.position.sub(center)

    return root
  }

  private onCheckpointRaceFinished(): void {
    this.raceFinished = true
    if (this.raceTimerStartMs !== null) {
      this.raceTimerFrozenSec = (performance.now() - this.raceTimerStartMs) / 1000
    }
    this.gameAudio.playRaceFinish()
    this.raycastCar?.setDriveEnabled(false)
    this.showGameOverScreen()
  }

  private readBestTimeSeconds(): number | null {
    const raw = localStorage.getItem(CarConfig.BEST_RACE_TIME_LS_KEY)
    if (raw === null) return null
    const v = Number(raw)
    return !Number.isNaN(v) && v > 0 ? v : null
  }

  /** Updates stored best when `finalSec` is a new record; returns best time to show (or null). */
  private mergeBestTimeAfterRun(finalSec: number): number | null {
    const prev = this.readBestTimeSeconds()
    if (finalSec > 0) {
      if (prev === null || finalSec < prev) {
        localStorage.setItem(CarConfig.BEST_RACE_TIME_LS_KEY, String(finalSec))
        return finalSec
      }
    }
    return prev
  }

  private showGameOverScreen(): void {
    const finalSec = this.raceTimerFrozenSec ?? 0
    const best = this.mergeBestTimeAfterRun(finalSec)
    this.gameOverFinalTimeEl.textContent = this.formatRaceTime(finalSec)
    this.gameOverBestTimeEl.textContent = best !== null ? this.formatRaceTime(best) : '—'
    this.gameOverOverlayEl.hidden = false
  }

  private syncCheckpointOrbMaterial(): void {
    const mat = this.checkpointOrbMaterial
    if (!mat || this.checkpointIdx < 0 || this.checkpointRoute.length === 0) return
    const isLast = this.checkpointIdx === this.checkpointRoute.length - 1
    if (isLast) {
      mat.color.setHex(0xffdd44)
      mat.emissive.setHex(0xc9a008)
      mat.emissiveIntensity = 0.88
    } else {
      mat.color.setHex(0x4da3ff)
      mat.emissive.setHex(0x1f5fb8)
      mat.emissiveIntensity = 0.75
    }
  }

  private updateCheckpointProgress(): void {
    if (!this.raycastCar || !this.checkpointMesh || this.checkpointIdx < 0 || this.checkpointRoute.length === 0) return
    if (this.mp != null && this.mpRaceStartPerf != null && performance.now() < this.mpRaceStartPerf) {
      return
    }
    const cp = this.checkpointRoute[this.checkpointIdx]!
    const carPos = this.raycastCar.group.position
    if (carPos.distanceTo(cp) <= 9.5) {
      const isLastCheckpoint = this.checkpointIdx === this.checkpointRoute.length - 1
      this.gameAudio.playCheckpoint(isLastCheckpoint)
      this.checkpointsPassed++
      this.checkpointIdx++
      if (this.checkpointIdx >= this.checkpointRoute.length) {
        this.checkpointMesh.visible = false
        this.checkpointIdx = -1
        this.onCheckpointRaceFinished()
      } else {
        this.checkpointMesh.visible = true
        this.checkpointMesh.position.copy(this.checkpointRoute[this.checkpointIdx]!)
        this.syncCheckpointOrbMaterial()
      }
    }
  }

  private updateAudio(dt: number): void {
    if (!this.raycastCar) return
    const lv = this.raycastCar.chassisBody.linvel()
    const speedMps = Math.hypot(lv.x, lv.z)
    let grounded = 0
    for (let i = 0; i < 4; i++) grounded += this.raycastCar.wheelOnGround(i) ? 1 : 0
    this.gameAudio.updateDriving(
      {
        speedMps,
        throttle: Math.abs(this.movement.forward),
        steer: Math.abs(this.movement.right),
        brake: this.movement.brake,
        groundedRatio: grounded / 4,
        driveEnabled: this.raycastCar.getDriveEnabled(),
        waterWade: this.raycastCar.getPondWadeFactor(),
      },
      dt,
    )
  }

  private ensureCheckpointMesh(): void {
    if (this.checkpointMesh) return
    const geo = new THREE.IcosahedronGeometry(8.5, 1)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4da3ff,
      emissive: 0x1f5fb8,
      emissiveIntensity: 0.75,
      transparent: true,
      opacity: 0.32,
      roughness: 0.28,
      metalness: 0.05,
      depthWrite: false,
    })
    this.checkpointOrbMaterial = mat
    this.checkpointMesh = new THREE.Mesh(geo, mat)
    this.checkpointMesh.visible = false
    this.checkpointMesh.castShadow = false
    this.checkpointMesh.receiveShadow = false
    this.checkpointMesh.renderOrder = 8
    this.scene.add(this.checkpointMesh)
  }

  private slopeAt(terrain: { heightAt(worldX: number, worldZ: number): number }, x: number, z: number, eps: number): number {
    const dx = (terrain.heightAt(x + eps, z) - terrain.heightAt(x - eps, z)) / (2 * eps)
    const dz = (terrain.heightAt(x, z + eps) - terrain.heightAt(x, z - eps)) / (2 * eps)
    return Math.hypot(dx, dz)
  }

  /** Keep rolling x/z history and set reset target from latest sampled position. */
  private updateResetHistoryAndSpawn(dt: number): void {
    if (!this.raycastCar || !this.driveGround) return

    this.resetHistorySampleT += dt
    if (this.resetHistorySampleT >= 2) {
      this.resetHistorySampleT -= 2
      const p = this.raycastCar.group.position
      this.resetHistory.push({ x: p.x, z: p.z })
      if (this.resetHistory.length > 20) this.resetHistory.shift()
    }

    const resetPressed = this.movement.reset
    if (resetPressed && !this.prevResetPressed) {
      const last = this.resetHistory[this.resetHistory.length - 1] ?? { x: 0, z: 0 }
      const y = this.driveGround.heightAt(last.x, last.z) + CarConfig.SPAWN_Y
      this.raycastCar.setResetSpawn(last.x, y, last.z)
    }
    this.prevResetPressed = resetPressed
  }

  /** After sustained upside-down pose, reset like R (history spawn + `applySpawnReset`). */
  private updateFlipAutoReset(dt: number): void {
    if (!this.raycastCar || !this.driveGround || this.raceFinished) {
      this.flipAutoResetHoldT = 0
      return
    }
    if (!this.raycastCar.getDriveEnabled()) {
      this.flipAutoResetHoldT = 0
      return
    }

    const r = this.raycastCar.chassisBody.rotation()
    this._flipBodyQuat.set(r.x, r.y, r.z, r.w)
    this._flipChassisUpWorld.set(0, 1, 0).applyQuaternion(this._flipBodyQuat)
    if (this._flipChassisUpWorld.y <= CarConfig.AUTO_RESET_FLIP_UP_Y_MAX) {
      this.flipAutoResetHoldT += dt
      if (this.flipAutoResetHoldT >= CarConfig.AUTO_RESET_FLIP_HOLD_S) {
        this.flipAutoResetHoldT = 0
        const last = this.resetHistory[this.resetHistory.length - 1] ?? { x: 0, z: 0 }
        const y = this.driveGround.heightAt(last.x, last.z) + CarConfig.SPAWN_Y
        this.raycastCar.setResetSpawn(last.x, y, last.z)
        this.raycastCar.applySpawnReset()
        this.raycastCar.syncGroupFromPhysics()
      }
    } else {
      this.flipAutoResetHoldT = 0
    }
  }

  /**
   * Exports terrain + cacti + ruins + rocks to a single GLB.
   * Ignores water, jeep, wheels, and other dynamic scene content.
   */
  private async exportTerrainPropsGlb(): Promise<void> {
    if (this.exportingTerrainGlb) return
    this.exportingTerrainGlb = true
    this.hudStatusEl.textContent = 'Exporting terrain GLB...'
    try {
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
      const exportScene = new THREE.Scene()
      const floorMat = await loadDirtFloorMaterial(this.renderer, {
        uvRepeat: CarConfig.DIRT_FLOOR_UV_REPEAT,
        displacementScale: CarConfig.DIRT_FLOOR_DISP_SCALE_FLAT,
      })
      const terrainMat = floorMat.clone()
      terrainMat.displacementScale = CarConfig.DIRT_FLOOR_DISP_SCALE_TERRAIN
      const ground = new DesertTerrainGround(world, exportScene, terrainMat)

      const loader = new GLTFLoader()
      const pondSurfaceY = ground.terrainMinY + CarConfig.POND_SURFACE_ABOVE_MIN_Y

      const cactusGltfs =
        CarConfig.CACTUS_MODEL_URLS.length > 0
          ? await Promise.all([...CarConfig.CACTUS_MODEL_URLS].map((url) => loader.loadAsync(url)))
          : []

      const [ruinsSettled, wizardSettled, stoneArcSettled, rocksSettled] = await Promise.allSettled([
        loader.loadAsync(CarConfig.RUINS_MODEL_URL),
        loader.loadAsync(CarConfig.WIZARD_STATUE_MODEL_URL),
        loader.loadAsync(CarConfig.STONE_ARC_MODEL_URL),
        Promise.all([...CarConfig.ROCKS_MODEL_URLS].map((url) => loader.loadAsync(url))),
      ])

      let ruinsExclusion: RuinsExclusionZone | null = null
      let wizardExclusion: RuinsExclusionZone | null = null
      let stoneArcExclusions: RuinsExclusionZone[] = []
      if (ruinsSettled.status === 'fulfilled') {
        ruinsExclusion = DesertRocksAndRuins.placeRuins(
          world,
          exportScene,
          ground,
          ruinsSettled.value.scene,
          pondSurfaceY,
        )
      }
      if (wizardSettled.status === 'fulfilled') {
        wizardExclusion = DesertRocksAndRuins.placeWizardStatue(
          world,
          exportScene,
          ground,
          wizardSettled.value.scene,
          pondSurfaceY,
          ruinsExclusion,
        )
      }
      if (stoneArcSettled.status === 'fulfilled') {
        stoneArcExclusions = DesertRocksAndRuins.populateStoneArcs(
          world,
          exportScene,
          ground,
          stoneArcSettled.value.scene,
          pondSurfaceY,
          [ruinsExclusion, wizardExclusion].filter((v): v is RuinsExclusionZone => v !== null),
          ruinsExclusion,
        )
      }
      if (cactusGltfs.length > 0) {
        DesertCacti.populate(
          world,
          exportScene,
          ground,
          cactusGltfs.map((g) => g.scene),
          pondSurfaceY,
          stoneArcExclusions,
        )
      }
      if (rocksSettled.status === 'fulfilled') {
        DesertRocksAndRuins.scatterRocks(
          world,
          exportScene,
          ground,
          rocksSettled.value.map((g) => g.scene),
          pondSurfaceY,
          ruinsExclusion,
          [wizardExclusion, ...stoneArcExclusions].filter((v): v is RuinsExclusionZone => v !== null),
        )
      }

      this.prepareSceneForGlbExport(exportScene)

      const exporter = new GLTFExporter()
      const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          exportScene,
          (result) => {
            if (result instanceof ArrayBuffer) {
              resolve(result)
            } else {
              reject(new Error('Expected binary GLB export result.'))
            }
          },
          (error) => reject(error),
          { binary: true, onlyVisible: true, includeCustomExtensions: true },
        )
      })

      const blob = new Blob([glb], { type: 'model/gltf-binary' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'terrain_cactus_ruins_rocks.glb'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      this.hudStatusEl.textContent = 'Export complete: terrain_cactus_ruins_rocks.glb'
      window.setTimeout(() => {
        if (this.hudStatusEl.textContent.startsWith('Export complete')) this.hudStatusEl.textContent = ''
      }, 4500)
    } catch {
      this.hudStatusEl.textContent = 'Export failed.'
    } finally {
      this.exportingTerrainGlb = false
    }
  }

  /** Ensure exported GLB embeds textures for props like ruins reliably. */
  private prepareSceneForGlbExport(root: THREE.Object3D): void {
    const texCache = new WeakMap<THREE.Texture, THREE.Texture>()
    const textureKeys = [
      'map',
      'alphaMap',
      'aoMap',
      'bumpMap',
      'displacementMap',
      'emissiveMap',
      'lightMap',
      'metalnessMap',
      'normalMap',
      'roughnessMap',
      'specularMap',
      'clearcoatMap',
      'clearcoatNormalMap',
      'clearcoatRoughnessMap',
      'sheenColorMap',
      'sheenRoughnessMap',
      'thicknessMap',
      'transmissionMap',
      'iridescenceMap',
      'iridescenceThicknessMap',
    ] as const

    const cloneTexture = (src: THREE.Texture): THREE.Texture => {
      const cached = texCache.get(src)
      if (cached) return cached
      const t = src.clone()
      t.image = this.toCanvasImage(src.image)
      t.needsUpdate = true
      texCache.set(src, t)
      return t
    }

    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const cloned = mats.map((mat) => {
        const out = this.toExportMaterial(mat)
        for (const k of textureKeys) {
          const tex = out[k]
          if (tex instanceof THREE.Texture) out[k] = cloneTexture(tex)
        }
        return out
      })
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!
    })
  }

  private toCanvasImage(image: unknown): unknown {
    if (!image || typeof document === 'undefined') return image
    if (image instanceof HTMLCanvasElement) return image
    const w = (image as { width?: number }).width
    const h = (image as { height?: number }).height
    if (!w || !h) return image
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return image
    try {
      ctx.drawImage(image as CanvasImageSource, 0, 0, w, h)
      return canvas
    } catch {
      return image
    }
  }

  private toExportMaterial(src: THREE.Material): THREE.Material & Record<string, unknown> {
    const srcAny = src as THREE.Material & Record<string, unknown>
    const out = new THREE.MeshStandardMaterial()
    if ('name' in srcAny && typeof srcAny.name === 'string') out.name = srcAny.name
    if ('side' in srcAny && typeof srcAny.side === 'number') out.side = srcAny.side as THREE.Side
    if ('transparent' in srcAny && typeof srcAny.transparent === 'boolean') out.transparent = srcAny.transparent
    if ('opacity' in srcAny && typeof srcAny.opacity === 'number') out.opacity = srcAny.opacity
    if ('alphaTest' in srcAny && typeof srcAny.alphaTest === 'number') out.alphaTest = srcAny.alphaTest
    if ('color' in srcAny && srcAny.color instanceof THREE.Color) out.color.copy(srcAny.color)
    if ('emissive' in srcAny && srcAny.emissive instanceof THREE.Color) out.emissive.copy(srcAny.emissive)
    if ('roughness' in srcAny && typeof srcAny.roughness === 'number') out.roughness = srcAny.roughness
    if ('metalness' in srcAny && typeof srcAny.metalness === 'number') out.metalness = srcAny.metalness
    if ('map' in srcAny && srcAny.map instanceof THREE.Texture) out.map = srcAny.map
    if ('normalMap' in srcAny && srcAny.normalMap instanceof THREE.Texture) out.normalMap = srcAny.normalMap
    if ('roughnessMap' in srcAny && srcAny.roughnessMap instanceof THREE.Texture) out.roughnessMap = srcAny.roughnessMap
    if ('metalnessMap' in srcAny && srcAny.metalnessMap instanceof THREE.Texture) out.metalnessMap = srcAny.metalnessMap
    if ('aoMap' in srcAny && srcAny.aoMap instanceof THREE.Texture) out.aoMap = srcAny.aoMap
    if ('emissiveMap' in srcAny && srcAny.emissiveMap instanceof THREE.Texture) out.emissiveMap = srcAny.emissiveMap
    if ('alphaMap' in srcAny && srcAny.alphaMap instanceof THREE.Texture) out.alphaMap = srcAny.alphaMap
    if ('bumpMap' in srcAny && srcAny.bumpMap instanceof THREE.Texture) out.bumpMap = srcAny.bumpMap
    if ('displacementMap' in srcAny && srcAny.displacementMap instanceof THREE.Texture) {
      out.displacementMap = srcAny.displacementMap
    }
    return out as unknown as THREE.Material & Record<string, unknown>
  }
}
