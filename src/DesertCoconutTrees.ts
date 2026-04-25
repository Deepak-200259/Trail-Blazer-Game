import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js'
import { cuboidInRootSpaceFromMeshes } from './colliderFromWorldAabb.ts'
import { CarConfig } from './CarConfig.ts'
import type { DesertHeightField } from './DesertCacti.ts'
import { mergeTemplateMeshesToGeometry } from './mergeTemplateMeshes.ts'

/** Slightly dull merged materials so palms read softer in bright desert light. */
function softenCoconutMaterials(m: THREE.Material | THREE.Material[]): void {
  const list = Array.isArray(m) ? m : [m]
  for (const mat of list) {
    if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial) {
      mat.color.multiplyScalar(0.9)
      mat.roughness = Math.min(1, mat.roughness + 0.05)
      mat.metalness = Math.min(1, mat.metalness * 0.82)
    } else if ('color' in mat && mat.color instanceof THREE.Color) {
      mat.color.multiplyScalar(0.9)
    }
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stylized palm when `COCONUT_TREE_MODEL_URLS` is empty; add GLBs to that list to use assets. */
export function createProceduralCoconutTree(): THREE.Group {
  const g = new THREE.Group()
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x423022, roughness: 0.94 })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x183420, roughness: 0.91 })
  const nutMat = new THREE.MeshStandardMaterial({ color: 0x342214, roughness: 0.8 })

  const h = 4.8
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, h, 10), trunkMat)
  trunk.position.y = h * 0.5
  trunk.castShadow = true
  trunk.receiveShadow = true
  g.add(trunk)

  const nFrond = 9
  for (let i = 0; i < nFrond; i++) {
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.6, 5), leafMat)
    const a = (i / nFrond) * Math.PI * 2
    frond.position.set(Math.cos(a) * 0.12, h * 0.92, Math.sin(a) * 0.12)
    frond.rotation.order = 'YXZ'
    frond.rotation.y = a
    frond.rotation.x = -1.05
    frond.rotation.z = Math.cos(a) * 0.35
    frond.castShadow = true
    g.add(frond)
  }

  for (let i = 0; i < 3; i++) {
    const nut = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), nutMat)
    const a = (i / 3) * Math.PI * 2 + 0.4
    nut.position.set(Math.cos(a) * 0.38, h * 0.78, Math.sin(a) * 0.38)
    nut.castShadow = true
    g.add(nut)
  }

  return g
}

const _tmpQ = new THREE.Quaternion()
const _tmpV = new THREE.Vector3()
const _tmpS = new THREE.Vector3()

type CoconutPending = {
  x: number
  z: number
  templateIdx: number
  scale: number
  rotY: number
}

export type DesertCoconutTreesOptions = {
  pondSurfaceY: number
  pondCenterX: number
  pondCenterZ: number
  /** Lowest terrain vertex Y (desert mesh); used to restrict spawns to low elevations. */
  terrainMinY: number
  /** If empty, `createProceduralCoconutTree` is used per instance. */
  templates: THREE.Object3D[]
}

/** Uniform random point in an annulus around the pond (area-preserving), plus XY jitter. */
function sampleNearPondXZ(rng: () => number, pondX: number, pondZ: number): { x: number; z: number } {
  const rMin = CarConfig.COCONUT_POND_R_MIN_M
  const rMax = CarConfig.COCONUT_POND_R_MAX_M
  const ang = rng() * Math.PI * 2
  const u = rng()
  const r2 = u * (rMax * rMax - rMin * rMin) + rMin * rMin
  const r = Math.sqrt(r2)
  const j = CarConfig.COCONUT_RING_JITTER_M
  const x = pondX + Math.cos(ang) * r + (rng() * 2 - 1) * j
  const z = pondZ + Math.sin(ang) * r + (rng() * 2 - 1) * j
  return { x, z }
}

/**
 * Sparse coconut palms near the pond: one merged `InstancedMesh` per GLB variant (or one for the
 * procedural fallback), plus a fixed Rapier cuboid per instance.
 */
export class DesertCoconutTrees {
  static populate(
    world: RAPIER.World,
    scene: THREE.Scene,
    terrain: DesertHeightField,
    opts: DesertCoconutTreesOptions,
  ): void {
    const rng = mulberry32(CarConfig.COCONUT_PLACE_SEED)
    const patchRng = mulberry32(CarConfig.COCONUT_PATCH_NOISE_SEED)
    const patchNoise = new SimplexNoise({ random: () => patchRng() })

    const { pondSurfaceY, pondCenterX, pondCenterZ, terrainMinY } = opts
    const templates = opts.templates
    const templateRoots =
      templates.length > 0 ? templates : [createProceduralCoconutTree()]
    const merged = templateRoots.map((t) => mergeTemplateMeshesToGeometry(t))

    const dryMin = pondSurfaceY + CarConfig.COCONUT_MIN_CLEARANCE_ABOVE_POND_M
    const lowCut = terrainMinY + CarConfig.COCONUT_LOW_TERRAIN_BAND_M
    const keepProb = CarConfig.COCONUT_PLACE_KEEP_PROB
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const margin = CarConfig.COCONUT_EDGE_MARGIN
    const clearR = CarConfig.COCONUT_CLEAR_ORIGIN_RADIUS
    const minSep = CarConfig.COCONUT_MIN_SEPARATION
    const count = CarConfig.COCONUT_TREE_COUNT
    const ns = CarConfig.COCONUT_PATCH_NOISE_SCALE
    const patchMin = CarConfig.COCONUT_PATCH_NOISE_MIN

    const placed: [number, number][] = []
    let attempts = 0
    const maxAttempts = count * 1400

    while (placed.length < count && attempts < maxAttempts) {
      attempts++
      const { x, z } = sampleNearPondXZ(rng, pondCenterX, pondCenterZ)
      if (Math.abs(x) > half - margin || Math.abs(z) > half - margin) continue
      if (Math.hypot(x, z) < clearR) continue
      const h = terrain.heightAt(x, z)
      if (h < dryMin) continue
      if (h > lowCut) continue
      const patch = (patchNoise.noise(x * ns, z * ns) + 1) * 0.5
      if (patch < patchMin) continue
      if (rng() > keepProb) continue
      if (placed.some(([px, pz]) => Math.hypot(x - px, z - pz) < minSep)) continue
      placed.push([x, z])
    }

    const pending: CoconutPending[] = []
    for (let i = 0; i < placed.length; i++) {
      const [x, z] = placed[i]!
      pending.push({
        x,
        z,
        templateIdx: i % templateRoots.length,
        scale: THREE.MathUtils.lerp(CarConfig.COCONUT_SCALE_MIN, CarConfig.COCONUT_SCALE_MAX, rng()),
        rotY: rng() * Math.PI * 2,
      })
    }

    const snapMesh = new THREE.Mesh(merged[0]!.geometry, merged[0]!.material)
    snapMesh.frustumCulled = false
    const embed = CarConfig.COCONUT_ROOT_EMBED_BELOW_SURFACE_M

    for (let k = 0; k < templateRoots.length; k++) {
      const group = pending.filter((p) => p.templateIdx === k)
      const n = group.length
      if (n === 0) continue

      const { geometry, material } = merged[k]!
      softenCoconutMaterials(material)
      snapMesh.geometry = geometry
      snapMesh.material = material

      const instanced = new THREE.InstancedMesh(geometry, material, n)
      instanced.castShadow = true
      instanced.receiveShadow = true
      instanced.frustumCulled = true

      for (let j = 0; j < n; j++) {
        const p = group[j]!
        snapMesh.scale.setScalar(p.scale)
        snapMesh.rotation.set(0, p.rotY, 0)
        snapMesh.position.set(p.x, 0, p.z)
        snapMesh.updateMatrixWorld(true)

        const box = new THREE.Box3().setFromObject(snapMesh, true)
        const yGround = terrain.heightAt(p.x, p.z)
        snapMesh.position.y = yGround - box.min.y - embed
        snapMesh.updateMatrixWorld(true)

        instanced.setMatrixAt(j, snapMesh.matrixWorld)

        const { halfExtents, centerLocal } = cuboidInRootSpaceFromMeshes(snapMesh)
        snapMesh.matrixWorld.decompose(_tmpV, _tmpQ, _tmpS)
        const colliderDesc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
          .setTranslation(centerLocal.x, centerLocal.y, centerLocal.z)
          .setFriction(0.65)
          .setRestitution(0.04)

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
