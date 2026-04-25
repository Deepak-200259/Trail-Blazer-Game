import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { CarConfig } from './CarConfig.ts'

/**
 * GTA-style chase cam with damped orbit return, position spring, speed-based FOV
 * (asymmetric widen vs slow return), and centrifugal roll from chassis angular velocity.
 */
export class GtaStyleVehicleCamera {
  private readonly camera: THREE.PerspectiveCamera
  private readonly canvas: HTMLCanvasElement
  private readonly pivotLocal = new THREE.Vector3()
  private readonly worldUp = new THREE.Vector3(0, 1, 0)

  private readonly forwardFlat = new THREE.Vector3()
  private readonly backFlat = new THREE.Vector3()
  private readonly rightFlat = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private readonly pivotWorld = new THREE.Vector3()
  private readonly idealCamPos = new THREE.Vector3()
  private readonly smoothCamPos = new THREE.Vector3()
  private readonly smoothCamVel = new THREE.Vector3()
  private readonly tmpCatchup = new THREE.Vector3()

  private target: THREE.Object3D | null = null

  /** Horizontal orbit angle (rad); rest pose = `defaultYawRest` (slightly left of straight behind). */
  private yawOffset: number
  /** Elevation above horizon (rad). */
  private pitch = 0.28
  /** Distance from pivot to camera. */
  private distance = 12

  private yawVel = 0
  private pitchVel = 0
  private distVel = 0

  private roll = 0
  private rollVel = 0

  private currentFov: number
  /** Smoothed 0…1 speed factor; rises faster than it falls so FOV regains slowly. */
  private fovSpeedBlend = 0

  private smoothPosInitialized = false

  private readonly defaultPitch: number
  private readonly defaultDistance: number
  /** Spring target for yaw when not dragging (typically small negative = left-biased chase). */
  private readonly defaultYawRest: number
  /**
   * Soft floor for camera world Y: `pivotWorld.y + minCameraYFromPivot` (negative = allow camera
   * below pivot for typical chase). Not an absolute world height.
   */
  private readonly minCameraYFromPivot: number
  private readonly pitchMin: number
  private readonly pitchMax: number
  private readonly yawSensitivity: number
  private readonly pitchSensitivity: number

  /** Orbit return: critically damped–style PD (stiffness / damping). */
  private readonly orbitSpringK: number
  private readonly orbitSpringDamp: number

  /** World-space camera position chase toward ideal orbit point. */
  private readonly posSpringK: number
  private readonly posSpringDamp: number

  /** Roll from yaw rate: targetRoll = clamp(-ωy * gain, ±maxRoll). */
  private readonly rollGain: number
  private readonly maxRoll: number
  private readonly rollSpringK: number
  private readonly rollSpringDamp: number

  private readonly baseFov: number
  private readonly maxFovAdd: number
  private readonly speedForMaxFov: number
  /** Exponential rate (1/s) toward `instantBlend` when speed is increasing. */
  private readonly fovBlendSmoothUp: number
  /** Slower rate when speed drops — FOV eases back toward base. */
  private readonly fovBlendSmoothDown: number
  /** Final gentle follow of `currentFov` toward blend-derived target (1/s). */
  private readonly fovFollowRate: number

  /** World-space linear velocity × this is added to ideal camera anchor (reduces chase lag). */
  private readonly pivotLeadSeconds: number
  /** If smoothed camera falls farther than this from ideal (m), pull it toward ideal. */
  private readonly maxCameraLagM: number
  private readonly lagSnapStrength: number

  private dragging = false

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    options?: {
      pivotLocal?: THREE.Vector3
      defaultPitch?: number
      defaultDistance?: number
      /** Radians; negative biases camera to the car’s left when viewed from behind (+X forward, Y up). */
      defaultYawRest?: number
      /** Added to chase pivot world Y for minimum camera Y (usually negative, e.g. -2.5 to -4). */
      minCameraY?: number
      pitchMin?: number
      pitchMax?: number
      yawSensitivity?: number
      pitchSensitivity?: number
      orbitSpringK?: number
      orbitSpringDamp?: number
      posSpringK?: number
      posSpringDamp?: number
      rollGain?: number
      maxRoll?: number
      rollSpringK?: number
      rollSpringDamp?: number
      baseFov?: number
      maxFovAdd?: number
      speedForMaxFov?: number
      fovBlendSmoothUp?: number
      fovBlendSmoothDown?: number
      fovFollowRate?: number
      pivotLeadSeconds?: number
      maxCameraLagM?: number
      lagSnapStrength?: number
    },
  ) {
    this.camera = camera
    this.canvas = canvas
    this.pivotLocal.copy(options?.pivotLocal ?? new THREE.Vector3(0, 0.45, 0))
    this.defaultPitch = options?.defaultPitch ?? 0.28
    this.defaultDistance = options?.defaultDistance ?? 12
    this.defaultYawRest = options?.defaultYawRest ?? CarConfig.CAMERA_DEFAULT_YAW_BIAS
    this.yawOffset = this.defaultYawRest
    this.distance = this.defaultDistance
    this.pitch = this.defaultPitch
    this.minCameraYFromPivot = options?.minCameraY ?? -2.85
    this.pitchMin = options?.pitchMin ?? -0.45
    this.pitchMax = options?.pitchMax ?? 1.15
    this.yawSensitivity = options?.yawSensitivity ?? 0.005
    this.pitchSensitivity = options?.pitchSensitivity ?? 0.004

    this.orbitSpringK = options?.orbitSpringK ?? 10
    this.orbitSpringDamp = options?.orbitSpringDamp ?? 5.2
    this.posSpringK = options?.posSpringK ?? 118
    this.posSpringDamp = options?.posSpringDamp ?? 30

    this.rollGain = options?.rollGain ?? 0.045
    this.maxRoll = options?.maxRoll ?? 0.14
    this.rollSpringK = options?.rollSpringK ?? 55
    this.rollSpringDamp = options?.rollSpringDamp ?? 12

    this.baseFov = options?.baseFov ?? 60
    this.maxFovAdd = options?.maxFovAdd ?? 14
    this.speedForMaxFov = options?.speedForMaxFov ?? 22
    this.fovBlendSmoothUp = options?.fovBlendSmoothUp ?? 8.5
    this.fovBlendSmoothDown = options?.fovBlendSmoothDown ?? 0.9
    this.fovFollowRate = options?.fovFollowRate ?? 11

    this.pivotLeadSeconds = options?.pivotLeadSeconds ?? 0.12
    this.maxCameraLagM = options?.maxCameraLagM ?? 20
    this.lagSnapStrength = options?.lagSnapStrength ?? 0.42

    this.currentFov = this.baseFov
    this.camera.fov = this.currentFov

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
  }

  setTarget(target: THREE.Object3D | null): void {
    this.target = target
    this.smoothPosInitialized = false
  }

  getTarget(): THREE.Object3D | null {
    return this.target
  }

  update(dt: number, chassis: RAPIER.RigidBody | null): void {
    if (!this.target) return
    const t = Math.max(1e-6, dt)
    this.target.updateWorldMatrix(true, false)

    let lvx = 0
    let lvy = 0
    let lvz = 0
    if (chassis) {
      const lv = chassis.linvel()
      lvx = lv.x
      lvy = lv.y
      lvz = lv.z
    }
    const speedXZ = Math.hypot(lvx, lvz)

    this.pivotWorld.copy(this.pivotLocal)
    this.target.localToWorld(this.pivotWorld)

    if (!this.dragging) {
      this.integrateSpring1D(this.defaultYawRest, this.yawOffset, this.yawVel, t, (x, v) => {
        this.yawOffset = x
        this.yawVel = v
      })
      this.integrateSpring1D(this.defaultDistance, this.distance, this.distVel, t, (x, v) => {
        this.distance = x
        this.distVel = v
      })
      this.distance = Math.max(2.5, this.distance)
      const minPitchForRest = this.computeMinPitchForGround(this.distance)
      const pitchRest = Math.max(this.defaultPitch, minPitchForRest)
      this.integrateSpring1D(pitchRest, this.pitch, this.pitchVel, t, (x, v) => {
        this.pitch = x
        this.pitchVel = v
      })
      this.pitch = THREE.MathUtils.clamp(this.pitch, this.pitchMin, this.pitchMax)
    }

    const minPitchFromGround = this.computeMinPitchForGround(this.distance)

    this.forwardFlat.set(1, 0, 0).applyQuaternion(this.target.quaternion)
    this.forwardFlat.y = 0
    if (this.forwardFlat.lengthSq() < 1e-8) {
      this.forwardFlat.set(0, 0, 1)
    } else {
      this.forwardFlat.normalize()
    }
    this.backFlat.copy(this.forwardFlat).multiplyScalar(-1)
    this.rightFlat.crossVectors(this.worldUp, this.forwardFlat).normalize()

    let pitch = THREE.MathUtils.clamp(this.pitch, this.pitchMin, this.pitchMax)
    const cosY = Math.cos(this.yawOffset)
    const sinY = Math.sin(this.yawOffset)
    const hx = this.backFlat.x * cosY + this.rightFlat.x * sinY
    const hz = this.backFlat.z * cosY + this.rightFlat.z * sinY
    const hLen = Math.hypot(hx, hz) || 1
    const hnx = hx / hLen
    const hnz = hz / hLen

    pitch = Math.max(pitch, minPitchFromGround)
    pitch = Math.min(pitch, this.pitchMax)

    const cosP = Math.cos(pitch)
    const sinP = Math.sin(pitch)
    this.dir.set(hnx * cosP, sinP, hnz * cosP).normalize()

    this.idealCamPos.copy(this.pivotWorld).addScaledVector(this.dir, this.distance)
    const lead = this.pivotLeadSeconds
    this.idealCamPos.x += lvx * lead
    this.idealCamPos.y += lvy * lead
    this.idealCamPos.z += lvz * lead
    const minCamWorldY = this.pivotWorld.y + this.minCameraYFromPivot
    if (this.idealCamPos.y < minCamWorldY) {
      this.idealCamPos.y = minCamWorldY
    }

    if (!this.smoothPosInitialized) {
      this.smoothCamPos.copy(this.idealCamPos)
      this.smoothCamVel.set(0, 0, 0)
      this.smoothPosInitialized = true
    }
    const posKScale = 1 + Math.min(1.35, speedXZ * 0.038)
    this.integrateSpringVec3(this.idealCamPos, this.smoothCamPos, this.smoothCamVel, t, posKScale)

    this.tmpCatchup.subVectors(this.idealCamPos, this.smoothCamPos)
    const lag = this.tmpCatchup.length()
    if (lag > this.maxCameraLagM) {
      const pull = Math.min(this.lagSnapStrength, (lag - this.maxCameraLagM) * 0.06)
      this.smoothCamPos.addScaledVector(this.tmpCatchup, pull / lag)
      this.smoothCamVel.multiplyScalar(0.82)
    }

    this.camera.position.copy(this.smoothCamPos)
    this.camera.lookAt(this.pivotWorld)

    let angVelY = 0
    if (chassis) {
      const av = chassis.angvel()
      angVelY = av.y
    }

    const targetRoll = THREE.MathUtils.clamp(-angVelY * this.rollGain, -this.maxRoll, this.maxRoll)
    this.integrateSpring1D(targetRoll, this.roll, this.rollVel, t, (x, v) => {
      this.roll = x
      this.rollVel = v
    }, this.rollSpringK, this.rollSpringDamp)
    this.camera.rotateZ(this.roll)

    const instantBlend = THREE.MathUtils.clamp(speedXZ / this.speedForMaxFov, 0, 1)
    const blendRate =
      instantBlend > this.fovSpeedBlend ? this.fovBlendSmoothUp : this.fovBlendSmoothDown
    this.fovSpeedBlend += (instantBlend - this.fovSpeedBlend) * (1 - Math.exp(-blendRate * t))
    const targetFov = THREE.MathUtils.lerp(
      this.baseFov,
      this.baseFov + this.maxFovAdd,
      this.fovSpeedBlend,
    )
    const fk = this.fovFollowRate
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-fk * t))
    this.camera.fov = this.currentFov
    this.camera.updateProjectionMatrix()
  }

  /** a = k*(target - x) - d*v; semi-implicit Euler. */
  private integrateSpring1D(
    target: number,
    x: number,
    v: number,
    dt: number,
    apply: (x: number, v: number) => void,
    k = this.orbitSpringK,
    d = this.orbitSpringDamp,
  ): void {
    const a = k * (target - x) - d * v
    const vNew = v + a * dt
    const xNew = x + vNew * dt
    apply(xNew, vNew)
  }

  private integrateSpringVec3(
    target: THREE.Vector3,
    x: THREE.Vector3,
    v: THREE.Vector3,
    dt: number,
    kScale = 1,
  ): void {
    const k = this.posSpringK * kScale
    const d = this.posSpringDamp * Math.min(1.28, 0.72 + 0.28 * kScale)
    for (let i = 0; i < 3; i++) {
      const ti = target.getComponent(i)
      const xi = x.getComponent(i)
      const vi = v.getComponent(i)
      const a = k * (ti - xi) - d * vi
      const vNew = vi + a * dt
      x.setComponent(i, xi + vNew * dt)
      v.setComponent(i, vNew)
    }
  }

  /**
   * Lower bound on orbit pitch so the ideal camera stays at or above
   * `pivot.y + minCameraYFromPivot` for the current distance.
   */
  private computeMinPitchForGround(distForPitch: number): number {
    const dist = Math.max(0.5, distForPitch)
    const need = this.minCameraYFromPivot / dist
    return Math.asin(THREE.MathUtils.clamp(need, -1, 1))
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    this.dragging = true
    this.yawVel = 0
    this.pitchVel = 0
    this.distVel = 0
    this.canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || !this.target) return
    this.yawOffset += e.movementX * this.yawSensitivity
    this.pitch += e.movementY * this.pitchSensitivity
    this.pitch = THREE.MathUtils.clamp(this.pitch, this.pitchMin, this.pitchMax)
    e.preventDefault()
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragging) {
      this.dragging = false
      try {
        this.canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* not captured */
      }
    }
  }
}
