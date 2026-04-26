import RAPIER, { TriMeshFlags } from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { cuboidInRootSpaceFromMeshes } from './colliderFromWorldAabb.ts'
import { CarConfig } from './CarConfig.ts'
import type { DesertHeightField } from './DesertCacti.ts'
import { mergeTemplateMeshesToGeometry } from './mergeTemplateMeshes.ts'

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const _tmpQ = new THREE.Quaternion()
const _tmpV = new THREE.Vector3()
const _tmpV2 = new THREE.Vector3()
const _tmpS = new THREE.Vector3()
const _hullPos = new THREE.Vector3()
const _ruinsBodyT = new THREE.Vector3()
const _invRuinsBodyQ = new THREE.Quaternion()
const _box = new THREE.Box3()
const _meshBox = new THREE.Box3()

/** Warm desert sand / brown (diffuse); `rocks_3` / `rocks_4` GLBs need an explicit tint. */
const _rock34Sand = new THREE.Color(0xbda078)
const _rock34SandAlt = new THREE.Color(0xa88f68)

/**
 * `rocks_3.glb` and `rocks_4.glb` use neutral materials; tint meshes before merge so instancing keeps it.
 * Indices follow `CarConfig.ROCKS_MODEL_URLS`.
 */
function applySandTintToRockThreeAndFour(templates: THREE.Object3D[]): void {
  const entries: [number, THREE.Color][] = [
    [2, _rock34Sand],
    [3, _rock34SandAlt],
  ]
  for (const [idx, color] of entries) {
    const root = templates[idx]
    if (!root) continue
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial) {
          mat.vertexColors = false
          mat.color.copy(color)
          mat.metalness = 0
          mat.roughness = THREE.MathUtils.clamp(Math.max(mat.roughness, 0.82), 0, 1)
        } else if ('color' in mat && (mat as THREE.MeshBasicMaterial).color instanceof THREE.Color) {
          ;(mat as THREE.MeshBasicMaterial).color.copy(color)
        }
      }
    })
  }
}

/**
 * Triangle mesh collider in Rapier **body** space: `v_body = q^{-1} (p_world - t)` for body at
 * `matrixWorld` = `(t, q, *)`. Matches Three.js mesh triangles including non-uniform hierarchy scale.
 */
function ruinsTrimeshColliderDesc(root: THREE.Object3D): RAPIER.ColliderDesc | null {
  root.updateMatrixWorld(true)
  root.matrixWorld.decompose(_ruinsBodyT, _tmpQ, _tmpS)
  _invRuinsBodyQ.copy(_tmpQ).invert()

  const verts: number[] = []
  const inds: number[] = []
  let base = 0

  root.traverse((obj) => {
    const m = obj as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    const geom = m.geometry
    const posAttr = geom.attributes.position
    if (!posAttr) return
    const idx = geom.index

    const emitVert = (vertexIndex: number) => {
      _tmpV2.fromBufferAttribute(posAttr as THREE.BufferAttribute, vertexIndex).applyMatrix4(m.matrixWorld)
      _tmpV2.sub(_ruinsBodyT).applyQuaternion(_invRuinsBodyQ)
      verts.push(_tmpV2.x, _tmpV2.y, _tmpV2.z)
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

  if (verts.length < 9 || inds.length < 3) return null

  const flags = TriMeshFlags.FIX_INTERNAL_EDGES | TriMeshFlags.MERGE_DUPLICATE_VERTICES
  try {
    return RAPIER.ColliderDesc.trimesh(new Float32Array(verts), Uint32Array.from(inds), flags)
      .setFriction(0.82)
      .setRestitution(0.04)
  } catch {
    return null
  }
}

function convexHullDescForMesh(mesh: THREE.Mesh): RAPIER.ColliderDesc | null {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos || pos.count < 4) return null
  const s = mesh.scale
  const pts = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    _hullPos.fromBufferAttribute(pos, i)
    pts[i * 3] = _hullPos.x * s.x
    pts[i * 3 + 1] = _hullPos.y * s.y
    pts[i * 3 + 2] = _hullPos.z * s.z
  }
  try {
    return RAPIER.ColliderDesc.convexHull(pts)
  } catch {
    return null
  }
}

/** World-space union of all `Mesh` bounds under `root` (avoids huge `Box3` from stray GLTF nodes). */
function unionWorldBoundsFromMeshes(root: THREE.Object3D, out: THREE.Box3): boolean {
  root.updateMatrixWorld(true)
  out.makeEmpty()
  let any = false
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    _meshBox.setFromObject(m)
    if (!_meshBox.isEmpty()) {
      out.union(_meshBox)
      any = true
    }
  })
  return any
}

/** Closest horizontal distance from `(px,pz)` to the XZ footprint of `box` (0 = inside / touching). */
function xzAabbDistanceToPoint(box: THREE.Box3, px: number, pz: number): number {
  const cx = 0.5 * (box.min.x + box.max.x)
  const cz = 0.5 * (box.min.z + box.max.z)
  const hx = 0.5 * (box.max.x - box.min.x)
  const hz = 0.5 * (box.max.z - box.min.z)
  const dx = Math.max(Math.abs(cx - px) - hx, 0)
  const dz = Math.max(Math.abs(cz - pz) - hz, 0)
  return Math.hypot(dx, dz)
}

/** |∇h| in m/m — low values are flat ground. */
function slopeMagnitude(terrain: DesertHeightField, x: number, z: number, eps = 7): number {
  const dx = (terrain.heightAt(x + eps, z) - terrain.heightAt(x - eps, z)) / (2 * eps)
  const dz = (terrain.heightAt(x, z + eps) - terrain.heightAt(x, z - eps)) / (2 * eps)
  return Math.hypot(dx, dz)
}

function rocksMountainKeepProbability(y: number, terrainMinY: number): number {
  const y0 = terrainMinY + CarConfig.ROCKS_MOUNTAIN_SPARSE_START_ABOVE_MIN_M
  const y1 = terrainMinY + CarConfig.ROCKS_MOUNTAIN_SPARSE_FULL_ABOVE_MIN_M
  if (y1 <= y0) return 1
  const t = THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1)
  const sm = t * t * (3 - 2 * t)
  return THREE.MathUtils.lerp(1, CarConfig.ROCKS_MOUNTAIN_KEEP_MIN, sm)
}

/** Lowest sampled terrain height under world-space XZ AABB footprint. */
function lowestTerrainUnderFootprint(terrain: DesertHeightField, box: THREE.Box3): number {
  const minX = box.min.x
  const maxX = box.max.x
  const minZ = box.min.z
  const maxZ = box.max.z
  let minH = Infinity
  const steps = 4
  for (let iz = 0; iz <= steps; iz++) {
    const tz = iz / steps
    const z = THREE.MathUtils.lerp(minZ, maxZ, tz)
    for (let ix = 0; ix <= steps; ix++) {
      const tx = ix / steps
      const x = THREE.MathUtils.lerp(minX, maxX, tx)
      minH = Math.min(minH, terrain.heightAt(x, z))
    }
  }
  return minH
}

export type RuinsExclusionZone = { x: number; z: number; r: number }

/**
 * One large `ruins.glb` on the flattest sampled site, plus scattered `rocks_*.glb` instances.
 * Physics uses `cuboidInRootSpaceFromMeshes` (rigid T/R only, matches Rapier) so cuboids match scaled meshes.
 */
export class DesertRocksAndRuins {
  /**
   * Places many stone arcs as one instanced draw call; each instance gets a fixed trimesh collider.
   * Includes one forced near-water placement when possible.
   */
  static populateStoneArcs(
    world: RAPIER.World,
    scene: THREE.Scene,
    terrain: DesertHeightField,
    template: THREE.Object3D,
    pondSurfaceY?: number,
    avoid: RuinsExclusionZone[] = [],
    ruinsAvoid: RuinsExclusionZone | null = null,
  ): RuinsExclusionZone[] {
    const rng = mulberry32(CarConfig.STONE_ARC_PLACE_SEED)
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const margin = CarConfig.STONE_ARC_EDGE_MARGIN
    const dryMinY =
      pondSurfaceY !== undefined ? pondSurfaceY + CarConfig.STONE_ARC_MIN_CLEARANCE_ABOVE_POND_M : -Infinity
    const terrainMinY =
      pondSurfaceY !== undefined ? pondSurfaceY - CarConfig.POND_SURFACE_ABOVE_MIN_Y : Number.NEGATIVE_INFINITY
    const maxY = terrainMinY + CarConfig.STONE_ARC_MAX_ABOVE_MIN_M
    const minSep = CarConfig.STONE_ARC_MIN_SEPARATION
    const placed: Array<{ x: number; z: number; rotY: number }> = []

    const validCandidate = (x: number, z: number, nearWaterMode: boolean): boolean => {
      if (Math.abs(x) > half - margin || Math.abs(z) > half - margin) return false
      if (Math.hypot(x, z) < CarConfig.STONE_ARC_CLEAR_ORIGIN_RADIUS) return false
      const pondDist = Math.hypot(x - CarConfig.POND_CENTER_X, z - CarConfig.POND_CENTER_Z)
      if (!nearWaterMode && pondDist < CarConfig.STONE_ARC_POND_CLEAR_RADIUS_M) return false
      if (
        nearWaterMode &&
        (pondDist < CarConfig.STONE_ARC_NEAR_WATER_MIN_R || pondDist > CarConfig.STONE_ARC_NEAR_WATER_MAX_R)
      ) {
        return false
      }
      const h = terrain.heightAt(x, z)
      if (h < dryMinY || h > maxY) return false
      if (slopeMagnitude(terrain, x, z, CarConfig.STONE_ARC_SLOPE_SAMPLE_EPS_M) > CarConfig.STONE_ARC_MAX_SLOPE) {
        return false
      }
      if (
        avoid.some((ex) => {
          const dx = x - ex.x
          const dz = z - ex.z
          return dx * dx + dz * dz < ex.r * ex.r
        })
      ) {
        return false
      }
      if (ruinsAvoid) {
        const dx = x - ruinsAvoid.x
        const dz = z - ruinsAvoid.z
        if (dx * dx + dz * dz < CarConfig.STONE_ARC_RUINS_CLEAR_RADIUS_M ** 2) return false
      }
      if (placed.some((p) => Math.hypot(x - p.x, z - p.z) < minSep)) return false
      return true
    }

    for (let i = 0; i < CarConfig.STONE_ARC_NEAR_WATER_TRIES; i++) {
      const a = rng() * Math.PI * 2
      const r = THREE.MathUtils.lerp(
        CarConfig.STONE_ARC_NEAR_WATER_MIN_R,
        CarConfig.STONE_ARC_NEAR_WATER_MAX_R,
        rng(),
      )
      const x = CarConfig.POND_CENTER_X + Math.cos(a) * r
      const z = CarConfig.POND_CENTER_Z + Math.sin(a) * r
      if (!validCandidate(x, z, true)) continue
      placed.push({ x, z, rotY: rng() * Math.PI * 2 })
      break
    }

    let attempts = 0
    while (placed.length < CarConfig.STONE_ARC_COUNT && attempts < CarConfig.STONE_ARC_GENERAL_TRIES) {
      attempts++
      const x = margin + rng() * (half * 2 - margin * 2) - half
      const z = margin + rng() * (half * 2 - margin * 2) - half
      if (!validCandidate(x, z, false)) continue
      placed.push({ x, z, rotY: rng() * Math.PI * 2 })
    }
    if (placed.length === 0) return []

    const merged = mergeTemplateMeshesToGeometry(template)
    const snapMesh = new THREE.Mesh(merged.geometry, merged.material)
    snapMesh.frustumCulled = false
    const instanced = new THREE.InstancedMesh(merged.geometry, merged.material, placed.length)
    instanced.name = 'stone_arc_instanced'
    instanced.castShadow = true
    instanced.receiveShadow = true
    instanced.frustumCulled = false

    const exclusions: RuinsExclusionZone[] = []
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!
      snapMesh.scale.setScalar(CarConfig.STONE_ARC_SCALE)
      snapMesh.rotation.set(0, p.rotY, 0)
      snapMesh.position.set(p.x, 0, p.z)
      snapMesh.updateMatrixWorld(true)
      _box.setFromObject(snapMesh, true)
      const minGroundY = lowestTerrainUnderFootprint(terrain, _box)
      snapMesh.position.y = minGroundY - _box.min.y + CarConfig.STONE_ARC_VERTICAL_BIAS_M
      snapMesh.updateMatrixWorld(true)
      instanced.setMatrixAt(i, snapMesh.matrixWorld)

      snapMesh.matrixWorld.decompose(_tmpV, _tmpQ, _tmpS)
      const triDesc = ruinsTrimeshColliderDesc(snapMesh)
      const colliderDesc =
        triDesc ??
        (() => {
          const { halfExtents, centerLocal } = cuboidInRootSpaceFromMeshes(snapMesh)
          return RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
            .setTranslation(centerLocal.x, centerLocal.y, centerLocal.z)
            .setFriction(0.82)
            .setRestitution(0.04)
        })()
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(_tmpV.x, _tmpV.y, _tmpV.z)
          .setRotation({ x: _tmpQ.x, y: _tmpQ.y, z: _tmpQ.z, w: _tmpQ.w }),
      )
      world.createCollider(colliderDesc, body)

      _box.setFromObject(snapMesh, true)
      _box.getCenter(_tmpV)
      const exR =
        0.5 * Math.hypot(_box.max.x - _box.min.x, _box.max.z - _box.min.z) + CarConfig.STONE_ARC_EXCLUSION_PAD_M
      exclusions.push({ x: _tmpV.x, z: _tmpV.z, r: exR })
    }
    instanced.instanceMatrix.needsUpdate = true
    scene.add(instanced)
    return exclusions
  }

  /** Places one large wizard statue as a landmark; returns exclusion disc, or `null` if skipped. */
  static placeWizardStatue(
    world: RAPIER.World,
    scene: THREE.Scene,
    terrain: DesertHeightField,
    template: THREE.Object3D,
    pondSurfaceY?: number,
    avoid?: RuinsExclusionZone | null,
  ): RuinsExclusionZone | null {
    const rng = mulberry32(CarConfig.WIZARD_STATUE_PLACE_SEED)
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const margin = CarConfig.WIZARD_STATUE_EDGE_MARGIN
    const dryMinY =
      pondSurfaceY !== undefined ? pondSurfaceY + CarConfig.WIZARD_STATUE_MIN_CLEARANCE_ABOVE_POND_M : -Infinity

    let bestX = 0
    let bestZ = 0
    let bestSlope = 1e9
    const tries = Math.max(700, Math.floor(CarConfig.RUINS_FLAT_SEARCH_TRIES * 0.72))
    for (let i = 0; i < tries; i++) {
      const x = margin + rng() * (half * 2 - margin * 2) - half
      const z = margin + rng() * (half * 2 - margin * 2) - half
      if (Math.hypot(x, z) < CarConfig.WIZARD_STATUE_CLEAR_ORIGIN_RADIUS) continue
      if (
        Math.hypot(x - CarConfig.POND_CENTER_X, z - CarConfig.POND_CENTER_Z) <
        CarConfig.WIZARD_STATUE_POND_CLEAR_RADIUS_M
      ) {
        continue
      }
      if (terrain.heightAt(x, z) < dryMinY) continue
      if (avoid) {
        const dx = x - avoid.x
        const dz = z - avoid.z
        if (dx * dx + dz * dz < avoid.r * avoid.r) continue
      }
      const sl = slopeMagnitude(terrain, x, z, CarConfig.WIZARD_STATUE_SLOPE_SAMPLE_EPS_M)
      if (sl < bestSlope) {
        bestSlope = sl
        bestX = x
        bestZ = z
      }
    }
    if (bestSlope > CarConfig.WIZARD_STATUE_MAX_SLOPE) return null

    const root = template.clone(true)
    root.scale.set(1, 1, 1)
    root.rotation.set(0, 0, 0)
    root.position.set(0, 0, 0)
    if (!unionWorldBoundsFromMeshes(root, _box)) return null
    _box.getSize(_tmpS)
    const foot0 = Math.max(_tmpS.x, _tmpS.z, 0.08)
    const targetFoot =
      THREE.MathUtils.lerp(
        CarConfig.WIZARD_STATUE_TARGET_FOOTPRINT_MIN_M,
        CarConfig.WIZARD_STATUE_TARGET_FOOTPRINT_MAX_M,
        rng(),
      ) * THREE.MathUtils.lerp(0.92, 1.08, rng())
    const s = THREE.MathUtils.clamp(
      targetFoot / foot0,
      CarConfig.WIZARD_STATUE_SCALE_MIN,
      CarConfig.WIZARD_STATUE_SCALE_MAX,
    )
    root.scale.setScalar(s)
    root.position.set(bestX, 6, bestZ)
    root.updateMatrixWorld(true)
    unionWorldBoundsFromMeshes(root, _box)
    root.position.y = terrain.heightAt(bestX, bestZ) - _box.min.y + CarConfig.WIZARD_STATUE_VERTICAL_BIAS_M
    root.lookAt(new THREE.Vector3(0, root.position.y, 0))
    root.updateMatrixWorld(true)

    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
      }
    })
    scene.add(root)

    root.matrixWorld.decompose(_tmpV, _tmpQ, _tmpS)
    const { halfExtents, centerLocal } = cuboidInRootSpaceFromMeshes(root)
    const radius = Math.max(halfExtents.x, halfExtents.z)
    const colliderDesc = RAPIER.ColliderDesc.cylinder(halfExtents.y, radius)
      .setTranslation(centerLocal.x, centerLocal.y, centerLocal.z)
      .setFriction(0.82)
      .setRestitution(0.03)
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(_tmpV.x, _tmpV.y, _tmpV.z)
        .setRotation({ x: _tmpQ.x, y: _tmpQ.y, z: _tmpQ.z, w: _tmpQ.w }),
    )
    world.createCollider(colliderDesc, body)

    unionWorldBoundsFromMeshes(root, _box)
    _box.getCenter(_tmpV)
    const exR =
      0.5 * Math.hypot(_box.max.x - _box.min.x, _box.max.z - _box.min.z) +
      CarConfig.WIZARD_STATUE_EXCLUSION_PAD_M
    return { x: _tmpV.x, z: _tmpV.z, r: exR }
  }

  /**
   * Places a single cloned ruins root; returns a horizontal exclusion disc for rock scatter, or `null` if skipped.
   */
  static placeRuins(
    world: RAPIER.World,
    scene: THREE.Scene,
    terrain: DesertHeightField,
    template: THREE.Object3D,
    pondSurfaceY?: number,
  ): RuinsExclusionZone | null {
    const rng = mulberry32(CarConfig.RUINS_PLACE_SEED)
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const margin = CarConfig.RUINS_EDGE_MARGIN
    const dryMinY =
      pondSurfaceY !== undefined ? pondSurfaceY + CarConfig.RUINS_MIN_CLEARANCE_ABOVE_POND_M : -Infinity

    let bestX = 0
    let bestZ = 0
    let bestSlope = 1e9

    for (let i = 0; i < CarConfig.RUINS_FLAT_SEARCH_TRIES; i++) {
      const x = margin + rng() * (half * 2 - margin * 2) - half
      const z = margin + rng() * (half * 2 - margin * 2) - half
      if (Math.hypot(x, z) < CarConfig.RUINS_CLEAR_ORIGIN_RADIUS) continue
      if (
        Math.hypot(x - CarConfig.POND_CENTER_X, z - CarConfig.POND_CENTER_Z) <
        CarConfig.RUINS_POND_CLEAR_RADIUS_M
      ) {
        continue
      }
      if (terrain.heightAt(x, z) < dryMinY) continue
      const sl = slopeMagnitude(terrain, x, z, CarConfig.RUINS_SLOPE_SAMPLE_EPS_M)
      if (sl < bestSlope) {
        bestSlope = sl
        bestX = x
        bestZ = z
      }
    }

    if (bestSlope > CarConfig.RUINS_MAX_SLOPE) return null

    const root = template.clone(true)
    root.scale.set(1, 1, 1)
    root.rotation.set(0, 0, 0)
    root.position.set(0, 0, 0)
    if (!unionWorldBoundsFromMeshes(root, _box)) return null
    _box.getSize(_tmpS)
    const foot0 = Math.max(_tmpS.x, _tmpS.z, 0.08)
    const targetFoot =
      THREE.MathUtils.lerp(CarConfig.RUINS_TARGET_FOOTPRINT_MIN_M, CarConfig.RUINS_TARGET_FOOTPRINT_MAX_M, rng()) *
      THREE.MathUtils.lerp(0.92, 1.08, rng())
    const s = THREE.MathUtils.clamp(
      targetFoot / foot0,
      CarConfig.RUINS_SCALE_MIN,
      CarConfig.RUINS_SCALE_MAX,
    )
    root.scale.setScalar(s)
    root.rotation.set(0, rng() * Math.PI * 2, 0)
    root.position.set(bestX, 7, bestZ)
    root.updateMatrixWorld(true)
    unionWorldBoundsFromMeshes(root, _box)
    const yGround = terrain.heightAt(bestX, bestZ)
    root.position.y = yGround - _box.min.y + CarConfig.RUINS_VERTICAL_BIAS_M
    root.updateMatrixWorld(true)

    if (!unionWorldBoundsFromMeshes(root, _box)) {
      return null
    }
    if (xzAabbDistanceToPoint(_box, 0, 0) < CarConfig.SPAWN_FIXED_COLLIDER_CLEAR_M) {
      return null
    }

    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
      }
    })
    scene.add(root)

    root.updateMatrixWorld(true)
    root.matrixWorld.decompose(_tmpV, _tmpQ, _tmpS)
    const triDesc = ruinsTrimeshColliderDesc(root)
    const colliderDesc =
      triDesc ??
      (() => {
        const { halfExtents, centerLocal } = cuboidInRootSpaceFromMeshes(root)
        return RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
          .setTranslation(centerLocal.x, centerLocal.y, centerLocal.z)
          .setFriction(0.82)
          .setRestitution(0.04)
      })()

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(_tmpV.x, _tmpV.y, _tmpV.z)
        .setRotation({ x: _tmpQ.x, y: _tmpQ.y, z: _tmpQ.z, w: _tmpQ.w }),
    )
    world.createCollider(colliderDesc, body)

    unionWorldBoundsFromMeshes(root, _box)
    _box.getCenter(_tmpV)
    const exR =
      0.5 * Math.hypot(_box.max.x - _box.min.x, _box.max.z - _box.min.z) + CarConfig.RUINS_EXCLUSION_PAD_M
    return { x: _tmpV.x, z: _tmpV.z, r: exR }
  }

  /** One `InstancedMesh` per rock GLB; each instance gets a fixed body + body-local AABB cuboid. */
  static scatterRocks(
    world: RAPIER.World,
    scene: THREE.Scene,
    terrain: DesertHeightField,
    templates: THREE.Object3D[],
    pondSurfaceY: number | undefined,
    ruinsExclusion: RuinsExclusionZone | null,
    extraExclusions: RuinsExclusionZone[] = [],
    hardExclusions: RuinsExclusionZone[] = [],
  ): void {
    if (templates.length === 0) return

    applySandTintToRockThreeAndFour(templates)
    const merged = templates.map((t) => mergeTemplateMeshesToGeometry(t))
    const rng = mulberry32(CarConfig.ROCKS_PLACE_SEED)
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const margin = CarConfig.ROCKS_EDGE_MARGIN
    const dryMinY =
      pondSurfaceY !== undefined ? pondSurfaceY + CarConfig.ROCKS_MIN_CLEARANCE_ABOVE_POND_M : -Infinity
    const terrainMinY =
      pondSurfaceY !== undefined ? pondSurfaceY - CarConfig.POND_SURFACE_ABOVE_MIN_Y : Number.NEGATIVE_INFINITY
    const count = CarConfig.ROCKS_PLACEMENT_COUNT
    const minSep = CarConfig.ROCKS_MIN_SEPARATION
    const slopeMax = CarConfig.ROCKS_MAX_SLOPE_FOR_PLACEMENT
    const slopeEps = CarConfig.ROCKS_SLOPE_SAMPLE_EPS_M
    const placed: [number, number][] = []
    let attempts = 0
    const maxAttempts = count * 420

    while (placed.length < count && attempts < maxAttempts) {
      attempts++
      const x = margin + rng() * (half * 2 - margin * 2) - half
      const z = margin + rng() * (half * 2 - margin * 2) - half
      if (Math.hypot(x, z) < CarConfig.ROCKS_CLEAR_ORIGIN_RADIUS) continue
      if (
        Math.hypot(x - CarConfig.POND_CENTER_X, z - CarConfig.POND_CENTER_Z) <
        CarConfig.ROCKS_POND_CLEAR_RADIUS_M
      ) {
        continue
      }
      const h = terrain.heightAt(x, z)
      if (h < dryMinY) continue
      if (slopeMagnitude(terrain, x, z, slopeEps) > slopeMax) continue
      if (rng() > rocksMountainKeepProbability(h, terrainMinY)) continue
      if (ruinsExclusion) {
        const dx = x - ruinsExclusion.x
        const dz = z - ruinsExclusion.z
        if (dx * dx + dz * dz < ruinsExclusion.r * ruinsExclusion.r) continue
      }
      if (
        extraExclusions.some((ex) => {
          const dx = x - ex.x
          const dz = z - ex.z
          return dx * dx + dz * dz < ex.r * ex.r
        })
      ) {
        continue
      }
      if (
        hardExclusions.some((ex) => {
          const dx = x - ex.x
          const dz = z - ex.z
          return dx * dx + dz * dz < ex.r * ex.r
        })
      ) {
        continue
      }
      if (placed.some(([px, pz]) => Math.hypot(x - px, z - pz) < minSep)) continue
      placed.push([x, z])
    }

    type Pending = { x: number; z: number; templateIdx: number; scale: number; rotY: number }
    const pending: Pending[] = []
    for (let i = 0; i < placed.length; i++) {
      const [x, z] = placed[i]!
      pending.push({
        x,
        z,
        templateIdx: Math.floor(rng() * templates.length) % templates.length,
        scale: THREE.MathUtils.lerp(CarConfig.ROCKS_SCALE_MIN, CarConfig.ROCKS_SCALE_MAX, rng()),
        rotY: rng() * Math.PI * 2,
      })
    }

    /** One scratch mesh per template: merged geometry in root space, same frame as `InstancedMesh`. */
    const snapMeshes = templates.map(
      (_, k) => new THREE.Mesh(merged[k]!.geometry, merged[k]!.material),
    )
    for (const sm of snapMeshes) sm.frustumCulled = false

    for (let k = 0; k < templates.length; k++) {
      const group = pending.filter((p) => p.templateIdx === k)
      const n = group.length
      if (n === 0) continue

      const { geometry, material } = merged[k]!
      const snapMesh = snapMeshes[k]!

      const instanced = new THREE.InstancedMesh(geometry, material, n)
      instanced.name = `rocks_instanced_${k}`
      instanced.castShadow = true
      instanced.receiveShadow = true
      /** Default bounds are local; instances are world-scattered — avoid incorrect culling. */
      instanced.frustumCulled = false

      for (let j = 0; j < n; j++) {
        const p = group[j]!
        snapMesh.scale.setScalar(p.scale)
        snapMesh.rotation.set(0, p.rotY, 0)
        snapMesh.position.set(p.x, 0, p.z)
        snapMesh.updateMatrixWorld(true)

        _box.setFromObject(snapMesh, true)
        const yGround = terrain.heightAt(p.x, p.z)
        snapMesh.position.y = yGround - _box.min.y + CarConfig.ROCKS_VERTICAL_BIAS_M
        snapMesh.updateMatrixWorld(true)

        instanced.setMatrixAt(j, snapMesh.matrixWorld)

        snapMesh.matrixWorld.decompose(_tmpV, _tmpQ, _tmpS)
        const hull = convexHullDescForMesh(snapMesh)
        const colliderDesc =
          hull ??
          (() => {
            const { halfExtents, centerLocal } = cuboidInRootSpaceFromMeshes(snapMesh)
            return RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setTranslation(
              centerLocal.x,
              centerLocal.y,
              centerLocal.z,
            )
          })()
        colliderDesc.setFriction(0.78).setRestitution(0.06)

        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed()
            .setTranslation(_tmpV.x, _tmpV.y, _tmpV.z)
            .setRotation({ x: _tmpQ.x, y: _tmpQ.y, z: _tmpQ.z, w: _tmpQ.w }),
        )
        world.createCollider(colliderDesc, body)
      }

      instanced.instanceMatrix.needsUpdate = true
      scene.add(instanced)
    }
  }
}
