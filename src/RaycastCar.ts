import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { CarConfig } from './CarConfig.ts'
import { CarGeometry } from './CarGeometry.ts'
import type { MovementInput } from './MovementInput.ts'

/** Horizontal pond bounds + water surface Y (matches desert `Water` plane). */
export type RaycastCarPondZone = {
  surfaceY: number
  halfExtent: number
  centerX: number
  centerZ: number
}

export class RaycastCar {
  readonly group: THREE.Group
  readonly chassisBody: RAPIER.RigidBody
  readonly vehicleController: RAPIER.DynamicRayCastVehicleController

  private readonly wheelsVisual: THREE.Object3D[]
  private readonly wheelBaseLocal: THREE.Quaternion[]
  private readonly wheelSteeringQuat = new THREE.Quaternion()
  private readonly wheelRotationQuat = new THREE.Quaternion()
  private readonly chassisUpLocal = new THREE.Vector3(0, 1, 0)
  private readonly tmpAxle = new THREE.Vector3()
  private readonly tmpConn = new THREE.Vector3()

  /** Spring-smoothed steer angle (rad), applied to front wheels. */
  private steerRad = 0
  private steerRadVel = 0
  /** Filtered steer input in [-1,1], prevents keyboard step jitter. */
  private steerInputFiltered = 0
  /** Filtered speed (m/s) for steer limiter; avoids lock chatter in fast turns. */
  private steerSpeedFiltered = 0

  /** Last throttle (-1, 0, 1) for visual spin when physics wheelRotation stalls. */
  private lastForwardInput = 0
  private lastEngineForce = 0
  private readonly visualSpinRad = [0, 0, 0, 0]
  private readonly prevWheelPhyRot = [0, 0, 0, 0]
  private readonly wdotFiltered = [0, 0, 0, 0]

  private resetSpawnX = 0
  private resetSpawnY = CarConfig.SPAWN_Y
  private resetSpawnZ = 0
  private prevResetHeld = false
  /** When false (e.g. race finished), engine/steer inputs are ignored and the car is braked. */
  private driveEnabled = true

  private readonly chassisHalfY: number
  private readonly pond: RaycastCarPondZone | null
  private readonly forwardAlongX: boolean
  private readonly vehicleChoice: 1 | 2 | 3 | 4 | 5
  private readonly engineForceMult: number
  private readonly suspensionRestMult: number
  private readonly suspensionTravelMult: number
  private readonly suspensionDampMult: number
  private readonly rightingTorqueImpulse: number
  private readonly tmpForwardWorld = new THREE.Vector3()
  private readonly tmpBodyQ = new THREE.Quaternion()

  constructor(
    world: RAPIER.World,
    car: THREE.Group,
    wheelsVisual: THREE.Object3D[],
    halfExtents: THREE.Vector3,
    forwardAlongX: boolean,
    chassisColliderDesc: RAPIER.ColliderDesc,
    pond: RaycastCarPondZone | null = null,
  ) {
    this.group = car
    this.wheelsVisual = wheelsVisual
    this.chassisHalfY = halfExtents.y
    this.pond = pond
    this.forwardAlongX = forwardAlongX
    this.vehicleChoice = CarConfig.activeVehicleChoice
    this.engineForceMult = this.vehicleChoice === 2 ? CarConfig.VEHICLE2_ENGINE_FORCE_MULT : 1
    this.suspensionRestMult = this.vehicleChoice === 2 ? CarConfig.VEHICLE2_SUSPENSION_REST_MULT : 1
    this.suspensionTravelMult = this.vehicleChoice === 2 ? CarConfig.VEHICLE2_SUSPENSION_TRAVEL_MULT : 1
    this.suspensionDampMult = this.vehicleChoice === 2 ? CarConfig.VEHICLE2_SUSPENSION_DAMP_MULT : 1
    this.rightingTorqueImpulse = this.vehicleChoice === 2 ? CarConfig.VEHICLE2_RIGHTING_TORQUE_IMPULSE : 0

    const chassisDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(car.position.x, car.position.y, car.position.z)
      .setLinearDamping(0.08)
      .setAngularDamping(CarConfig.CHASSIS_ANGULAR_DAMPING)
    this.chassisBody = world.createRigidBody(chassisDesc)
    const chassisCollider = chassisColliderDesc
      .setMass(CarConfig.CHASSIS_MASS)
      .setRestitution(0.06)
      .setFriction(0.9)
    world.createCollider(chassisCollider, this.chassisBody)
    this.chassisBody.enableCcd(true)

    this.vehicleController = world.createVehicleController(this.chassisBody)
    const wheelDirection = { x: 0, y: -1, z: 0 }
    const wheelAxle = forwardAlongX ? { x: 0, y: 0, z: -1 } : { x: -1, y: 0, z: 0 }

    for (let i = 0; i < 4; i++) {
      const w = wheelsVisual[i]!
      const connection = w.position.clone()
      const r = CarGeometry.estimateWheelRollingRadius(w)
      this.vehicleController.addWheel(
        { x: connection.x, y: connection.y, z: connection.z },
        wheelDirection,
        wheelAxle,
        CarConfig.SUSPENSION_REST_LENGTH * this.suspensionRestMult,
        r,
      )
      this.vehicleController.setWheelSuspensionStiffness(i, 32)
      this.vehicleController.setWheelSuspensionCompression(i, 5.5 * this.suspensionDampMult)
      this.vehicleController.setWheelSuspensionRelaxation(i, 7.5 * this.suspensionDampMult)
      this.vehicleController.setWheelMaxSuspensionTravel(i, 0.22 * this.suspensionTravelMult)
      this.vehicleController.setWheelMaxSuspensionForce(i, 120_000)
      this.vehicleController.setWheelFrictionSlip(i, CarConfig.WHEEL_FRICTION_SLIP)
      this.vehicleController.setWheelSideFrictionStiffness(i, CarConfig.WHEEL_SIDE_FRICTION_STIFFNESS)
      this.vehicleController.setWheelSteering(i, 0)
    }

    this.wheelBaseLocal = wheelsVisual.map((w) => {
      w.updateMatrixWorld(true)
      return w.quaternion.clone()
    })
  }

  setResetSpawn(x: number, y: number, z: number): void {
    this.resetSpawnX = x
    this.resetSpawnY = y
    this.resetSpawnZ = z
  }

  /** Teleport to `setResetSpawn`, clear motion, straighten wheels — same as tapping R once. */
  applySpawnReset(): void {
    this.chassisBody.setTranslation(
      new RAPIER.Vector3(this.resetSpawnX, this.resetSpawnY, this.resetSpawnZ),
      true,
    )
    this.chassisBody.setRotation(new RAPIER.Quaternion(0, 0, 0, 1), true)
    this.chassisBody.setLinvel(new RAPIER.Vector3(0, 0, 0), true)
    this.chassisBody.setAngvel(new RAPIER.Vector3(0, 0, 0), true)
    this.steerRad = 0
    this.steerRadVel = 0
    this.lastForwardInput = 0
    this.lastEngineForce = 0
    this.steerInputFiltered = 0
    this.steerSpeedFiltered = 0
    for (let i = 0; i < 4; i++) {
      this.visualSpinRad[i] = 0
      this.prevWheelPhyRot[i] = this.vehicleController.wheelRotation(i) ?? 0
      this.wdotFiltered[i] = 0
      this.vehicleController.setWheelSteering(i, 0)
    }
    this.driveEnabled = true
  }

  setDriveEnabled(enabled: boolean): void {
    this.driveEnabled = enabled
    if (enabled) {
      this.chassisBody.setLinearDamping(0.08)
      this.chassisBody.setAngularDamping(CarConfig.CHASSIS_ANGULAR_DAMPING)
    }
  }

  getDriveEnabled(): boolean {
    return this.driveEnabled
  }

  /** 0 = dry, 1 = fully wading (chassis low in water, inside pond XZ). */
  getPondWadeFactor(): number {
    return this.pondSubmergeFactor()
  }

  wheelOnGround(index: number): boolean {
    return this.vehicleController.wheelIsInContact(index) ?? false
  }

  private pondSubmergeFactor(): number {
    const p = this.pond
    if (!p) return 0
    const t = this.chassisBody.translation()
    if (Math.abs(t.x - p.centerX) > p.halfExtent || Math.abs(t.z - p.centerZ) > p.halfExtent) {
      return 0
    }
    const bottomY = t.y - this.chassisHalfY
    const depth = p.surfaceY - bottomY
    if (depth <= 0) return 0
    return THREE.MathUtils.clamp(depth / CarConfig.POND_SUBMERGE_FULL_DEPTH_M, 0, 1)
  }

  applyInput(input: MovementInput, dt: number): void {
    if (input.reset && !this.prevResetHeld) {
      this.applySpawnReset()
      this.prevResetHeld = true
      return
    }
    if (!input.reset) this.prevResetHeld = false

    const t = Math.max(1e-6, dt)

    if (!this.driveEnabled) {
      const wade = this.pondSubmergeFactor()
      this.chassisBody.setLinearDamping(8 + wade * 2)
      this.chassisBody.setAngularDamping(7)
      for (let i = 0; i < 4; i++) {
        this.vehicleController.setWheelEngineForce(i, 0)
        this.vehicleController.setWheelBrake(i, CarConfig.MAX_BRAKE_FORCE * 12)
      }
      const decay = Math.exp(-12 * t)
      this.steerRad *= decay
      this.steerRadVel *= decay
      for (const i of CarConfig.WHEEL_STEER_INDICES) {
        this.vehicleController.setWheelSteering(i, this.steerRad)
      }
      this.vehicleController.setWheelSteering(2, 0)
      this.vehicleController.setWheelSteering(3, 0)
      this.lastForwardInput = 0
      this.lastEngineForce = 0
      return
    }

    if (input.forward !== 0 && this.chassisBody.isSleeping()) {
      this.chassisBody.wakeUp()
    }

    const wade = this.pondSubmergeFactor()
    this.chassisBody.setLinearDamping(0.08 + wade * CarConfig.POND_LINEAR_DAMP_EXTRA)

    const engineForce = input.forward * CarConfig.MAX_ENGINE_FORCE * this.engineForceMult
    const engineMul = THREE.MathUtils.lerp(1, CarConfig.POND_MIN_ENGINE_MULT, wade)
    const perWheel = engineForce * 0.5 * engineMul
    for (let i = 0; i < 4; i++) {
      this.vehicleController.setWheelEngineForce(i, perWheel)
    }

    const lv = this.chassisBody.linvel()
    const speedXZ = Math.hypot(lv.x, lv.z)
    const speedAlpha = 1 - Math.exp(-t / CarConfig.STEER_SPEED_FILTER_TAU)
    this.steerSpeedFiltered += (speedXZ - this.steerSpeedFiltered) * speedAlpha
    const steerScale = CarConfig.steerSpeedScale(this.steerSpeedFiltered)
    const maxEffective = CarConfig.MAX_STEER_ANGLE * steerScale
    const steerInAlpha = 1 - Math.exp(-t / CarConfig.STEER_INPUT_FILTER_TAU)
    this.steerInputFiltered += (input.right - this.steerInputFiltered) * steerInAlpha
    const targetSteer = maxEffective * this.steerInputFiltered
    const k = CarConfig.STEER_SPRING_K
    const d = CarConfig.STEER_SPRING_DAMP
    const accel = k * (targetSteer - this.steerRad) - d * this.steerRadVel
    this.steerRadVel += accel * t
    this.steerRad += this.steerRadVel * t
    this.steerRad = THREE.MathUtils.clamp(this.steerRad, -maxEffective, maxEffective)

    for (const i of CarConfig.WHEEL_STEER_INDICES) {
      this.vehicleController.setWheelSteering(i, this.steerRad)
    }
    this.vehicleController.setWheelSteering(2, 0)
    this.vehicleController.setWheelSteering(3, 0)

    const wheelBrake = input.brake * CarConfig.MAX_BRAKE_FORCE
    for (let i = 0; i < 4; i++) {
      this.vehicleController.setWheelBrake(i, wheelBrake)
    }

    this.lastForwardInput = input.forward
    this.lastEngineForce = engineForce

    if (this.rightingTorqueImpulse > 0 && input.right !== 0) {
      const rot = this.chassisBody.rotation()
      this.tmpBodyQ.set(rot.x, rot.y, rot.z, rot.w)
      this.tmpForwardWorld
        .set(this.forwardAlongX ? 1 : 0, 0, this.forwardAlongX ? 0 : -1)
        .applyQuaternion(this.tmpBodyQ)
      const bodyUpY = new THREE.Vector3(0, 1, 0).applyQuaternion(this.tmpBodyQ).y
      // When mostly upside-down, steering left/right also applies roll impulse to help self-right.
      if (bodyUpY < -0.15) {
        const s = Math.sign(input.right)
        const t = this.rightingTorqueImpulse * s
        this.chassisBody.applyTorqueImpulse(
          new RAPIER.Vector3(this.tmpForwardWorld.x * t, this.tmpForwardWorld.y * t, this.tmpForwardWorld.z * t),
          true,
        )
      }
    }
  }

  updateWheelMeshes(dt: number): void {
    const t = Math.max(1e-6, dt)
    const thresh = CarConfig.WHEEL_PHY_SPIN_SYNC_THRESHOLD
    const spinRate = CarConfig.VISUAL_THROTTLE_SPIN_RATE
    const dCap = CarConfig.WHEEL_ROT_DELTA_CAP
    const tau = CarConfig.WHEEL_WDOT_FILTER_TAU
    const filterAlpha = 1 - Math.exp(-t / tau)

    this.wheelsVisual.forEach((wheel, index) => {
      const axle = this.vehicleController.wheelAxleCs(index)
      if (!axle) return
      this.tmpAxle.set(axle.x, axle.y, axle.z).normalize()

      const conn = this.vehicleController.wheelChassisConnectionPointCs(index)
      const suspension = this.vehicleController.wheelSuspensionLength(index) ?? 0
      const steering = this.vehicleController.wheelSteering(index) ?? 0
      const phyRot = this.vehicleController.wheelRotation(index) ?? 0
      let d = phyRot - this.prevWheelPhyRot[index]!
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      d = THREE.MathUtils.clamp(d, -dCap, dCap)
      const rawWdot = Math.abs(d) / t
      this.wdotFiltered[index]! += (rawWdot - this.wdotFiltered[index]!) * filterAlpha
      this.prevWheelPhyRot[index] = phyRot

      const inContact = this.vehicleController.wheelIsInContact(index)
      const phyDriving = inContact && this.wdotFiltered[index]! > thresh

      if (phyDriving) {
        this.visualSpinRad[index] = 0
      } else if (this.lastForwardInput !== 0 && Math.abs(this.lastEngineForce) > 1e-3) {
        this.visualSpinRad[index]! += Math.sign(this.lastEngineForce) * spinRate * t
      }

      const rotationRad = phyRot + this.visualSpinRad[index]!

      if (conn) {
        this.tmpConn.set(conn.x, conn.y, conn.z)
        this.tmpConn.y -= suspension
        wheel.position.copy(this.tmpConn)
      }

      this.wheelRotationQuat.setFromAxisAngle(this.tmpAxle, rotationRad)
      this.wheelSteeringQuat.setFromAxisAngle(this.chassisUpLocal, steering)
      const base = this.wheelBaseLocal[index]!
      wheel.quaternion.copy(base)
      wheel.quaternion.premultiply(this.wheelRotationQuat)
      wheel.quaternion.premultiply(this.wheelSteeringQuat)
    })
  }

  syncGroupFromPhysics(): void {
    const t = this.chassisBody.translation()
    this.group.position.set(t.x, t.y, t.z)
    const r = this.chassisBody.rotation()
    this.group.quaternion.set(r.x, r.y, r.z, r.w)
  }

  /**
   * Clamps horizontal speed to `MAX_SPEED_KMH` (vertical velocity unchanged).
   * @param maxScale Multiplies the dry/pond cap (e.g. >1 in MP so brief collision spikes are not erased).
   */
  enforceGroundSpeedCap(maxScale = 1): void {
    const wade = this.pondSubmergeFactor()
    const dryMax = CarConfig.MAX_SPEED_KMH / 3.6
    const pondMax = CarConfig.POND_MAX_SPEED_KMH / 3.6
    const maxMps = THREE.MathUtils.lerp(dryMax, pondMax, wade) * maxScale
    const lv = this.chassisBody.linvel()
    const sxz = Math.hypot(lv.x, lv.z)
    if (sxz <= maxMps || sxz < 1e-8) return
    const scale = maxMps / sxz
    this.chassisBody.setLinvel(new RAPIER.Vector3(lv.x * scale, lv.y, lv.z * scale), true)
  }
}
