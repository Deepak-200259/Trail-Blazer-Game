import * as THREE from 'three'

const _invQ = new THREE.Quaternion()
const _corner = new THREE.Vector3()
const _halfOut = new THREE.Vector3()
const _centerOut = new THREE.Vector3()
const _tmpV = new THREE.Vector3()
const _tmpQ = new THREE.Quaternion()
const _tmpS = new THREE.Vector3()
const _vRoot = new THREE.Vector3()
const _localBox = new THREE.Box3()
const _size = new THREE.Vector3()
/** Rigid transform only (Rapier bodies have no stored scale). */
const _rigidWorld = new THREE.Matrix4()
const _rigidWorldInv = new THREE.Matrix4()
const _unitScale = new THREE.Vector3(1, 1, 1)

/**
 * Axis-aligned box in **Rapier rigid-body space** (translation + rotation from
 * `root.matrixWorld.decompose`, scale = 1) that contains every mesh vertex in world space.
 *
 * Using `invert(matrixWorld)` instead would cancel object scale for a single `Mesh` root and
 * produce a cuboid sized to **unscaled** geometry while the renderer still applies scale.
 */
export function cuboidInRootSpaceFromMeshes(root: THREE.Object3D): {
  halfExtents: THREE.Vector3
  centerLocal: THREE.Vector3
} {
  root.updateMatrixWorld(true)
  root.matrixWorld.decompose(_tmpV, _tmpQ, _tmpS)
  _rigidWorld.compose(_tmpV, _tmpQ, _unitScale)
  _rigidWorldInv.copy(_rigidWorld).invert()
  _localBox.makeEmpty()
  let any = false
  root.traverse((obj) => {
    const m = obj as THREE.Mesh
    if (!m.isMesh || !m.geometry?.attributes.position) return
    const pos = m.geometry.attributes.position as THREE.BufferAttribute
    m.updateMatrixWorld(true)
    const wm = m.matrixWorld
    /** Same vertex basis as `Box3.setFromObject(mesh, true)` (morph + skin for `SkinnedMesh`). */
    for (let i = 0; i < pos.count; i++) {
      m.getVertexPosition(i, _vRoot)
      _vRoot.applyMatrix4(wm).applyMatrix4(_rigidWorldInv)
      _localBox.expandByPoint(_vRoot)
      any = true
    }
  })
  if (!any) {
    return {
      halfExtents: _halfOut.set(0.35, 2.5, 0.35),
      centerLocal: _centerOut.set(0, 1.25, 0),
    }
  }
  _localBox.getSize(_size)
  _localBox.getCenter(_centerOut)
  return {
    halfExtents: _halfOut.set(
      Math.max(0.04, _size.x * 0.5),
      Math.max(0.04, _size.y * 0.5),
      Math.max(0.04, _size.z * 0.5),
    ),
    centerLocal: _centerOut.clone(),
  }
}

/**
 * Rapier cuboid is axis-aligned in rigid-body space. Builds the smallest body-local AABB that
 * contains all eight corners of a **world** AABB (e.g. from `Box3.setFromObject(mesh, true)`).
 */
export function cuboidFromWorldMeshBounds(
  worldBox: THREE.Box3,
  bodyTranslation: THREE.Vector3,
  bodyRotation: THREE.Quaternion,
): { halfExtents: THREE.Vector3; centerLocal: THREE.Vector3 } {
  if (worldBox.isEmpty()) {
    return {
      halfExtents: _halfOut.set(0.25, 0.5, 0.25),
      centerLocal: _centerOut.set(0, 0.25, 0),
    }
  }
  const invQ = _invQ.copy(bodyRotation).invert()
  const lb = new THREE.Box3()
  lb.makeEmpty()
  const mn = worldBox.min
  const mx = worldBox.max
  const xs: [number, number] = [mn.x, mx.x]
  const ys: [number, number] = [mn.y, mx.y]
  const zs: [number, number] = [mn.z, mx.z]
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        _corner.set(x, y, z).sub(bodyTranslation).applyQuaternion(invQ)
        lb.expandByPoint(_corner)
      }
    }
  }
  const size = new THREE.Vector3()
  lb.getSize(size)
  lb.getCenter(_centerOut)
  const hx = Math.max(0.04, size.x * 0.5)
  const hy = Math.max(0.04, size.y * 0.5)
  const hz = Math.max(0.04, size.z * 0.5)
  return { halfExtents: _halfOut.set(hx, hy, hz), centerLocal: _centerOut.clone() }
}
