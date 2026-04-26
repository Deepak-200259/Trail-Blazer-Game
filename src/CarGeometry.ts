import RAPIER, { TriMeshFlags } from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { CarConfig, type ChassisColliderMode, type TyrePlacementConfig } from './CarConfig.ts'

const _bodyInv = new THREE.Matrix4()
const _vChassis = new THREE.Vector3()

export class CarGeometry {
  static computeChassisCuboid(
    root: THREE.Object3D,
    bodyFrame: THREE.Object3D,
  ): { halfExtents: THREE.Vector3; centerOffset: THREE.Vector3 } {
    const box = new THREE.Box3()
    let any = false
    root.updateWorldMatrix(true, true)
    root.traverse((obj) => {
      const m = obj as THREE.Mesh
      if (!m.isMesh) return
      const b = new THREE.Box3().setFromObject(m)
      if (!any) {
        box.copy(b)
        any = true
      } else {
        box.union(b)
      }
    })
    if (!any) {
      return {
        halfExtents: new THREE.Vector3(1, 0.5, 2),
        centerOffset: new THREE.Vector3(0, 0, 0),
      }
    }
    const size = new THREE.Vector3()
    const centerWorld = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(centerWorld)
    const centerLocal = centerWorld.clone()
    bodyFrame.worldToLocal(centerLocal)
    return {
      halfExtents: new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2),
      centerOffset: centerLocal,
    }
  }

  private static cuboidColliderFallback(
    R: typeof RAPIER,
    halfExtents: THREE.Vector3,
    centerOffset: THREE.Vector3,
  ): RAPIER.ColliderDesc {
    return R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setTranslation(
      centerOffset.x,
      centerOffset.y,
      centerOffset.z,
    )
  }

  /**
   * Chassis collider in `bodyFrame` local space (typically the car `THREE.Group` = rigid body).
   * Call after any visual pivot fix (e.g. `jeepRoot.position.sub(centerOffset)`) so vertices match runtime poses.
   */
  static buildChassisColliderDesc(
    R: typeof RAPIER,
    meshRoot: THREE.Object3D,
    bodyFrame: THREE.Object3D,
    mode: ChassisColliderMode,
    halfExtents: THREE.Vector3,
    centerOffset: THREE.Vector3,
  ): RAPIER.ColliderDesc {
    if (mode === 'cuboid') {
      return CarGeometry.cuboidColliderFallback(R, halfExtents, centerOffset)
    }

    bodyFrame.updateMatrixWorld(true)
    _bodyInv.copy(bodyFrame.matrixWorld).invert()
    meshRoot.updateMatrixWorld(true)

    if (mode === 'convexHull') {
      const pts: number[] = []
      meshRoot.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (!m.isMesh || !m.geometry) return
        const pos = m.geometry.attributes.position as THREE.BufferAttribute | undefined
        if (!pos) return
        m.updateMatrixWorld(true)
        for (let i = 0; i < pos.count; i++) {
          _vChassis.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(_bodyInv)
          pts.push(_vChassis.x, _vChassis.y, _vChassis.z)
        }
      })
      if (pts.length < 9) {
        return CarGeometry.cuboidColliderFallback(R, halfExtents, centerOffset)
      }
      const hull = R.ColliderDesc.convexHull(new Float32Array(pts))
      return hull ?? CarGeometry.cuboidColliderFallback(R, halfExtents, centerOffset)
    }

    const verts: number[] = []
    const inds: number[] = []
    let base = 0
    meshRoot.traverse((obj) => {
      const m = obj as THREE.Mesh
      if (!m.isMesh || !m.geometry) return
      const geom = m.geometry
      const posAttr = geom.attributes.position as THREE.BufferAttribute | undefined
      if (!posAttr) return
      const idx = geom.index

      const emitVert = (vertexIndex: number) => {
        _vChassis.fromBufferAttribute(posAttr, vertexIndex).applyMatrix4(m.matrixWorld).applyMatrix4(_bodyInv)
        verts.push(_vChassis.x, _vChassis.y, _vChassis.z)
      }

      m.updateMatrixWorld(true)
      if (idx) {
        for (let i = 0; i + 2 < idx.count; i += 3) {
          emitVert(idx.getX(i))
          emitVert(idx.getX(i + 1))
          emitVert(idx.getX(i + 2))
          inds.push(base, base + 1, base + 2)
          base += 3
        }
      } else {
        for (let i = 0; i + 2 < posAttr.count; i += 3) {
          emitVert(i)
          emitVert(i + 1)
          emitVert(i + 2)
          inds.push(base, base + 1, base + 2)
          base += 3
        }
      }
    })

    if (verts.length < 9 || inds.length < 3) {
      return CarGeometry.cuboidColliderFallback(R, halfExtents, centerOffset)
    }

    const flags = TriMeshFlags.FIX_INTERNAL_EDGES | TriMeshFlags.MERGE_DUPLICATE_VERTICES
    try {
      return R.ColliderDesc.trimesh(new Float32Array(verts), Uint32Array.from(inds), flags)
    } catch {
      return CarGeometry.cuboidColliderFallback(R, halfExtents, centerOffset)
    }
  }

  static estimateWheelRollingRadius(wheel: THREE.Object3D): number {
    wheel.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(wheel)
    if (box.isEmpty()) return 0.25
    const size = new THREE.Vector3()
    box.getSize(size)
    const s = [size.x, size.y, size.z].sort((a, b) => a - b)
    const diameterApprox = Math.min(s[1]!, s[2]!)
    return Math.max(0.1, (diameterApprox * 0.5) * CarConfig.PHYSICS_TYRE_RADIUS_SCALE)
  }

  static addTyresToCar(
    car: THREE.Group,
    tyreTemplate: THREE.Object3D,
    halfExtents: THREE.Vector3,
    centerOffset: THREE.Vector3,
    /** When set, use this instead of the active (local) vehicle’s tyre layout. */
    placementOverride: TyrePlacementConfig | null = null,
  ): THREE.Object3D[] {
    const proto = tyreTemplate.clone(true)
    proto.scale.set(1, 1, 1)
    proto.updateMatrixWorld(true)
    const protoBox = new THREE.Box3().setFromObject(proto)
    const protoSize = new THREE.Vector3()
    protoBox.getSize(protoSize)
    const ref = Math.max(protoSize.x, protoSize.y, protoSize.z, 1e-6)
    const hx = halfExtents.x
    const hz = halfExtents.z
    const forwardAlongX = hx >= hz
    const lateralHalf = forwardAlongX ? hz : hx
    const tp = placementOverride ?? CarConfig.tyrePlacementForActiveChassis()
    const baseTargetTyreSize = lateralHalf * 2 * tp.widthFrac
    const baseScale = baseTargetTyreSize / ref
    proto.scale.setScalar(baseScale)
    proto.updateMatrixWorld(true)
    const chassisBottomY = centerOffset.y - halfExtents.y

    const frontLateralSpan = lateralHalf * (tp.frontLateralFrac ?? tp.lateralFrac)
    const rearLateralSpan = lateralHalf * (tp.rearLateralFrac ?? tp.lateralFrac)
    let alongFront: number
    let alongRear: number
    if (forwardAlongX) {
      alongFront = centerOffset.x + hx * tp.alongFrontFrac
      alongRear = centerOffset.x - hx * tp.alongRearFrac
    } else {
      alongFront = centerOffset.z - hz * tp.alongFrontFrac
      alongRear = centerOffset.z + hz * tp.alongRearFrac
    }

    const tyreLayout: { lateralSign: number; axle: 'front' | 'rear' }[] = [
      { lateralSign: -1, axle: 'front' },
      { lateralSign: 1, axle: 'front' },
      { lateralSign: -1, axle: 'rear' },
      { lateralSign: 1, axle: 'rear' },
    ]

    const wheels: THREE.Object3D[] = []

    for (const slot of tyreLayout) {
      const along = slot.axle === 'front' ? alongFront : alongRear
      const lateralSpan = slot.axle === 'front' ? frontLateralSpan : rearLateralSpan
      const lat = slot.lateralSign * lateralSpan
      const tyre = proto.clone(true)
      const axleWidthMul = slot.axle === 'front' ? (tp.frontWidthMul ?? 1) : (tp.rearWidthMul ?? 1)
      tyre.scale.multiplyScalar(axleWidthMul)
      if (forwardAlongX) {
        tyre.position.set(along, 0, centerOffset.z + lat)
      } else {
        tyre.position.set(centerOffset.x + lat, 0, along)
      }
      tyre.updateMatrixWorld(true)
      const b = new THREE.Box3().setFromObject(tyre)
      const axleExtraDropY = slot.axle === 'front' ? (tp.frontExtraDropY ?? tp.extraDropY) : (tp.rearExtraDropY ?? tp.extraDropY)
      tyre.position.y += chassisBottomY - b.min.y - axleExtraDropY
      if (slot.lateralSign < 0) {
        tyre.rotateY(tp.leftYaw)
      }
      car.add(tyre)
      wheels.push(tyre)
      tyre.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true
          m.receiveShadow = true
        }
      })
    }
    return wheels
  }
}
