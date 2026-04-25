import * as THREE from 'three'
import type { MovementInput } from './MovementInput.ts'
import type { RaycastCar, RaycastCarPondZone } from './RaycastCar.ts'

export type DriveFxHeightField = {
  heightAt(worldX: number, worldZ: number): number
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Soft circle for `PointsMaterial.map` so particles render round, not square cards. */
function makeParticleCircleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const g = c.getContext('2d')
  if (!g) {
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 62)
  gr.addColorStop(0, 'rgba(255,255,255,1)')
  gr.addColorStop(0.15, 'rgba(255,255,255,0.95)')
  gr.addColorStop(0.45, 'rgba(255,255,255,0.35)')
  gr.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = gr
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.flipY = false
  return t
}

type ParticleBurstOpts = {
  /** World-space attenuated points (default). If true, `size` is roughly pixels — reads clearly at distance. */
  screenSpaceSize?: boolean
  screenSizePx?: number
  /** When false, particles ignore depth (not recommended for wheel dust — shows through body). */
  depthTest?: boolean
  /** Horizontal velocity damping per second (dust settles). */
  airDrag?: number
  /** Nudge depth for near-coplanar ground (still occluded by car when depthTest is on). */
  polygonOffset?: boolean
}

type ParticleEmitFlavor = {
  /** Looser, lower, slower puff — desert dust. */
  dust?: boolean
  /** Scales how wide / fast the cloud spreads (speed, landing impact). Typical ~0.6–2.4. */
  intensity?: number
}

class ParticleBurst {
  readonly max: number
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  readonly points: THREE.Points
  private readonly rng: () => number
  private readonly airDrag: number

  constructor(
    max: number,
    pointSize: number,
    color: number,
    seed: number,
    scene: THREE.Scene,
    circleMap: THREE.Texture,
    opts?: ParticleBurstOpts,
  ) {
    this.max = max
    this.airDrag = opts?.airDrag ?? 0
    this.rng = mulberry32(seed)
    this.pos = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.life = new Float32Array(max)
    this.maxLife = new Float32Array(max)
    for (let i = 0; i < max; i++) {
      this.life[i] = 0
      this.pos[i * 3 + 1] = -1e5
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setDrawRange(0, max)
    const screen = opts?.screenSpaceSize === true
    const mat = new THREE.PointsMaterial({
      color,
      map: circleMap,
      size: screen ? (opts?.screenSizePx ?? 18) : pointSize,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: opts?.depthTest !== false,
      sizeAttenuation: !screen,
      blending: THREE.NormalBlending,
      alphaTest: 0.04,
      polygonOffset: opts?.polygonOffset === true,
      polygonOffsetFactor: opts?.polygonOffset === true ? -3 : 0,
      polygonOffsetUnits: opts?.polygonOffset === true ? -3 : 0,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = screen ? 12 : 4
    scene.add(this.points)
  }

  emit(
    origin: THREE.Vector3,
    count: number,
    speed: number,
    spread: number,
    gravity: number,
    lifeMin: number,
    lifeMax: number,
    flavor?: ParticleEmitFlavor,
  ): void {
    const jitter = this.rng
    const dust = flavor?.dust === true
    const int = dust ? THREE.MathUtils.clamp(flavor?.intensity ?? 1, 0.45, 2.85) : 1
    let spawned = 0
    for (let i = 0; i < this.max && spawned < count; i++) {
      if (this.life[i]! > 0) continue
      const ix = i * 3
      if (dust) {
        const pj = 0.2 + 0.14 * int
        this.pos[ix] = origin.x + (jitter() - 0.5) * spread * pj
        this.pos[ix + 1] = origin.y + (jitter() - 0.35) * spread * (0.05 + 0.04 * int)
        this.pos[ix + 2] = origin.z + (jitter() - 0.5) * spread * pj
        const ang = jitter() * Math.PI * 2
        const up = (0.05 + jitter() * speed * 0.085) * (0.85 + 0.2 * int)
        const hor = 0.1 * speed * (0.32 + jitter() * (0.75 + 0.35 * int)) * int
        const hs = spread * (0.72 + 0.12 * int)
        this.vel[ix] = Math.cos(ang) * hor * hs
        this.vel[ix + 1] = up + gravity * 0.015
        this.vel[ix + 2] = Math.sin(ang) * hor * hs
      } else {
        this.pos[ix] = origin.x + (jitter() - 0.5) * spread * 0.1
        this.pos[ix + 1] = origin.y + jitter() * spread * 0.08
        this.pos[ix + 2] = origin.z + (jitter() - 0.5) * spread * 0.1
        const ang = jitter() * Math.PI * 2
        const up = 0.4 + jitter() * speed * 0.15
        const hor = 0.28 * speed * (0.45 + jitter())
        this.vel[ix] = Math.cos(ang) * hor * spread
        this.vel[ix + 1] = up + gravity * 0.02
        this.vel[ix + 2] = Math.sin(ang) * hor * spread
      }
      const lf = THREE.MathUtils.lerp(
        dust ? lifeMin * (1.08 + 0.1 * int) : lifeMin,
        dust ? lifeMax * (1.12 + 0.22 * int) : lifeMax,
        jitter(),
      )
      this.life[i] = lf
      this.maxLife[i] = lf
      spawned++
      if (spawned >= count) break
    }
  }

  update(dt: number, gravity: number): void {
    const posAttr = this.points.geometry.attributes.position as THREE.BufferAttribute
    let active = 0
    let sumT = 0
    for (let i = 0; i < this.max; i++) {
      const L = this.life[i]!
      if (L <= 0) continue
      this.life[i] = L - dt
      const ix = i * 3
      if (this.airDrag > 0) {
        const k = Math.exp(-this.airDrag * dt)
        this.vel[ix]! *= k
        this.vel[ix + 1]! *= Math.exp(-this.airDrag * 0.35 * dt)
        this.vel[ix + 2]! *= k
      }
      this.vel[ix + 1] += gravity * dt
      this.pos[ix] += this.vel[ix]! * dt
      this.pos[ix + 1] += this.vel[ix + 1]! * dt
      this.pos[ix + 2] += this.vel[ix + 2]! * dt
      if (this.life[i]! <= 0) {
        this.life[i] = 0
        this.pos[ix] = 0
        this.pos[ix + 1] = -1e5
        this.pos[ix + 2] = 0
        continue
      }
      active++
      sumT += this.life[i]! / this.maxLife[i]!
    }
    posAttr.needsUpdate = true
    const mat = this.points.material as THREE.PointsMaterial
    mat.opacity = active === 0 ? 0 : THREE.MathUtils.clamp(0.45 + (sumT / active) * 0.5, 0.4, 1)
  }
}

export class CarDriveEffects {
  private readonly ground: DriveFxHeightField
  private readonly pond: RaycastCarPondZone | null
  private readonly dirt: ParticleBurst
  private readonly water: ParticleBurst
  private readonly rng: () => number
  private readonly particleCircle: THREE.CanvasTexture
  private prevWade = 0
  private readonly tmpV = new THREE.Vector3()
  private readonly tmpSide = new THREE.Vector3()
  private readonly tmpMotion = new THREE.Vector3()
  /** One-shot puff when the session begins moving on dry ground. */
  private startDustEmitted = false
  /** Tracks vertical fall for landing dust. */
  private prevChassisVy = 0
  private wasFalling = false
  private landDustCooldown = 0
  private prevAnyWheelDown = true
  private airborneTime = 0

  constructor(scene: THREE.Scene, ground: DriveFxHeightField, pond: RaycastCarPondZone | null) {
    this.ground = ground
    this.pond = pond
    this.rng = mulberry32(41_113)
    this.particleCircle = makeParticleCircleTexture()
    this.dirt = new ParticleBurst(720, 1.2, 0x8f7358, 88_901, scene, this.particleCircle, {
      screenSpaceSize: true,
      screenSizePx: 20,
      airDrag: 2.05,
      polygonOffset: true,
    })
    this.water = new ParticleBurst(480, 0.36, 0xd2ecff, 90_227, scene, this.particleCircle)
  }

  update(dt: number, car: RaycastCar, movement: MovementInput, wheels: THREE.Object3D[]): void {
    const wade = car.getPondWadeFactor()
    const lv = car.chassisBody.linvel()
    const speedXZ = Math.hypot(lv.x, lv.z)

    const wEnter = this.prevWade < 0.035 && wade >= 0.035
    if (wEnter && this.pond) {
      const t = car.chassisBody.translation()
      this.tmpV.set(t.x, this.pond.surfaceY + 0.15, t.z)
      const dive = Math.min(1, Math.abs(Math.min(0, lv.y)) / 10)
      const burst = 95 + Math.floor(dive * 95)
      this.water.emit(this.tmpV, burst, Math.max(6, speedXZ * 0.5 + dive * 14), 2.2 + dive * 0.8, -6, 0.35, 0.95)
    }
    if (wade > 0.12 && speedXZ > 2.5 && this.pond) {
      const emitN = Math.min(14, Math.floor(speedXZ * wade * dt * 20))
      if (emitN > 0 && this.rng() < wade * 1.15) {
        for (const wi of [0, 1, 2, 3]) {
          wheels[wi]?.getWorldPosition(this.tmpV)
          this.tmpV.y = this.pond.surfaceY + 0.06
          this.water.emit(this.tmpV, emitN, speedXZ * 0.09, 1.1, -2.5, 0.1, 0.38)
        }
      }
    }

    const dry = wade < 0.05
    if (!dry) this.wasFalling = false

    this.landDustCooldown = Math.max(0, this.landDustCooldown - dt)

    const anyWheelDown =
      wheels.length >= 4 &&
      (car.wheelOnGround(0) || car.wheelOnGround(1) || car.wheelOnGround(2) || car.wheelOnGround(3))
    const vy = lv.y

    const prevAirborneTime = this.airborneTime
    if (!anyWheelDown) this.airborneTime += dt
    else this.airborneTime = 0

    if (vy < -1.75) this.wasFalling = true

    if (dry && wheels.length >= 4) {
      if (
        !this.startDustEmitted &&
        anyWheelDown &&
        (speedXZ > 1.2 || movement.forward !== 0 || movement.brake > 0)
      ) {
        const startMul = Math.max(2.0, speedXZ * 0.38 + 1.25)
        const startCount = Math.floor(28 + Math.min(56, speedXZ * 5.5 + Math.abs(movement.forward) * 18))
        this.emitDustBurstWheels(car, wheels, startCount, startMul, lv)
        this.startDustEmitted = true
      }

      const landedFromAir = !this.prevAnyWheelDown && anyWheelDown
      const hardLanding = this.prevChassisVy < -0.7 || this.wasFalling
      if (
        this.landDustCooldown <= 0 &&
        landedFromAir &&
        prevAirborneTime > 0.05 &&
        hardLanding
      ) {
        const impact = Math.min(1, Math.abs(this.prevChassisVy) / 12)
        const landInt = 0.75 + impact * 1.55 + Math.min(0.65, speedXZ * 0.04)
        const n = Math.floor(42 + impact * 95 + speedXZ * 2.2)
        this.emitDustBurstWheels(car, wheels, n, 2.35 + impact * 6.5 + speedXZ * 0.12, lv, landInt)
        const t = car.chassisBody.translation()
        this.tmpV.set(t.x, this.ground.heightAt(t.x, t.z) + 0.2, t.z)
        this.dirt.emit(
          this.tmpV,
          Math.floor(32 + impact * 55 + speedXZ * 1.8),
          1.85 + impact * 5.5 + speedXZ * 0.08,
          1.85 + impact * 2.2,
          -5.5,
          0.42,
          1.12,
          { dust: true, intensity: landInt },
        )
        this.wasFalling = false
        this.landDustCooldown = 0.28
      }
    }

    this.prevChassisVy = vy
    this.prevAnyWheelDown = anyWheelDown

    this.dirt.update(dt, -6.2)
    this.water.update(dt, -5)
    this.prevWade = wade
  }

  private emitDustBurstWheels(
    car: RaycastCar,
    wheels: THREE.Object3D[],
    countPerWheel: number,
    speedMul: number,
    lv: { x: number; y: number; z: number },
    intensityOverride?: number,
  ): void {
    const t = car.chassisBody.translation()
    this.tmpMotion.set(lv.x, 0, lv.z)
    const speedXZ = this.tmpMotion.length()
    if (speedXZ > 0.45) this.tmpMotion.multiplyScalar(1 / speedXZ)
    else this.tmpMotion.set(0, 0, 0)

    const intensity =
      intensityOverride ??
      THREE.MathUtils.clamp(0.52 + speedMul * 0.11 + speedXZ * 0.038, 0.55, 2.75)
    const spread = 1.28 + intensity * 0.95

    for (let wi = 0; wi < 4; wi++) {
      if (!car.wheelOnGround(wi)) continue
      wheels[wi]?.getWorldPosition(this.tmpV)

      this.tmpSide.set(this.tmpV.x - t.x, 0, this.tmpV.z - t.z)
      const latLen = this.tmpSide.length()
      if (latLen > 1e-4) this.tmpSide.multiplyScalar(0.22 / latLen)
      else this.tmpSide.set(0, 0, 0)
      this.tmpV.add(this.tmpSide)

      if (this.tmpMotion.lengthSq() > 1e-6) {
        const rear = wi < 2 ? 0.34 : 0.26
        this.tmpV.addScaledVector(this.tmpMotion, -rear)
      }

      const gy = this.ground.heightAt(this.tmpV.x, this.tmpV.z)
      const jm = 0.14 + 0.16 * intensity
      this.tmpV.x += (this.rng() - 0.5) * jm
      this.tmpV.z += (this.rng() - 0.5) * jm
      this.tmpV.y = gy + 0.06 + this.rng() * (0.1 + 0.08 * intensity)
      const each = Math.min(80, Math.max(5, countPerWheel))
      this.dirt.emit(this.tmpV, each, speedMul, spread, -5.2, 0.46, 1.08 + intensity * 0.14, {
        dust: true,
        intensity,
      })
    }
  }

  dispose(): void {
    this.particleCircle.dispose()
  }
}
