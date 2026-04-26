import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js'
import { cuboidInRootSpaceFromMeshes } from './colliderFromWorldAabb.ts'
import { CarConfig } from './CarConfig.ts'
import { mergeTemplateMeshesToGeometry } from './mergeTemplateMeshes.ts'

export type DesertHeightField = {
  heightAt(worldX: number, worldZ: number): number
}
type TerrainWithMesh = DesertHeightField & { mesh: THREE.Mesh }

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** ~0–1 field: low = barren, high = preferred placement (layered Simplex on XZ). */
function cactusPlacementMask(noise: SimplexNoise, worldX: number, worldZ: number): number {
  const s = CarConfig.CACTUS_NOISE_SCALE
  let n = noise.noise(worldX * s, worldZ * s)
  const w = CarConfig.CACTUS_NOISE_FBM_WEIGHT
  if (w > 0) {
    n = (n + w * noise.noise(worldX * s * 2.05, worldZ * s * 2.05)) / (1 + w)
  }
  return THREE.MathUtils.clamp((n + 1) * 0.5, 0, 1)
}

/** |∇h| in m/m. Larger values are steeper/curvier terrain. */
function slopeMagnitude(terrain: DesertHeightField, x: number, z: number, eps: number): number {
  const dx = (terrain.heightAt(x + eps, z) - terrain.heightAt(x - eps, z)) / (2 * eps)
  const dz = (terrain.heightAt(x, z + eps) - terrain.heightAt(x, z - eps)) / (2 * eps)
  return Math.hypot(dx, dz)
}

function mountainKeepProbability(y: number, terrainMinY: number): number {
  const y0 = terrainMinY + CarConfig.CACTUS_MOUNTAIN_SPARSE_START_ABOVE_MIN_M
  const y1 = terrainMinY + CarConfig.CACTUS_MOUNTAIN_SPARSE_FULL_ABOVE_MIN_M
  if (y1 <= y0) return 1
  const t = THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1)
  const sm = t * t * (3 - 2 * t)
  return THREE.MathUtils.lerp(1, CarConfig.CACTUS_MOUNTAIN_KEEP_MIN, sm)
}

const _tmpQ = new THREE.Quaternion()
const _tmpQ2 = new THREE.Quaternion()
const _tmpV = new THREE.Vector3()
const _tmpN = new THREE.Vector3()
const _tmpP = new THREE.Vector3()
const _tmpS = new THREE.Vector3()
const _rayOrigin = new THREE.Vector3()
const _rayDown = new THREE.Vector3(0, -1, 0)
const _raycaster = new THREE.Raycaster()
const _hullPos = new THREE.Vector3()

function raycastGround(
  terrain: DesertHeightField,
  x: number,
  z: number,
  outPoint: THREE.Vector3,
  outNormal: THREE.Vector3,
): boolean {
  const t = terrain as Partial<TerrainWithMesh>
  if (!(t.mesh instanceof THREE.Mesh)) return false
  const yGuess = terrain.heightAt(x, z)
  _rayOrigin.set(x, yGuess + 420, z)
  _raycaster.set(_rayOrigin, _rayDown)
  const hit = _raycaster.intersectObject(t.mesh, false)[0]
  if (!hit) return false
  outPoint.copy(hit.point)
  if (hit.face) {
    outNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize()
  } else {
    outNormal.set(0, 1, 0)
  }
  return true
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

type CactusPending = {
  x: number
  z: number
  mask: number
  templateIdx: number
  scale: number
  rotY: number
}

/**
 * Scatter cacti: one merged `InstancedMesh` per template variant + independent fixed Rapier
 * cuboid bodies per instance.
 */
export class DesertCacti {
  static populate(
    world: RAPIER.World,
    scene: THREE.Scene,
    terrain: DesertHeightField,
    templates: THREE.Object3D[],
    pondSurfaceY?: number,
    sparseExclusions: Array<{ x: number; z: number; r: number }> = [],
    hardExclusions: Array<{ x: number; z: number; r: number }> = [],
  ): void {
    if (templates.length === 0) return

    const merged = templates.map((t) => mergeTemplateMeshesToGeometry(t))
    const rng = mulberry32(CarConfig.CACTUS_PLACE_SEED)
    const densityRng = mulberry32(CarConfig.CACTUS_NOISE_SEED)
    const densityNoise = new SimplexNoise({ random: () => densityRng() })
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const margin = CarConfig.CACTUS_EDGE_MARGIN
    const clearR = CarConfig.CACTUS_CLEAR_ORIGIN_RADIUS
    const minSep = CarConfig.CACTUS_MIN_SEPARATION
    const count = CarConfig.CACTUS_PLACEMENT_COUNT
    const emptyBelow = CarConfig.CACTUS_NOISE_EMPTY_BELOW
    const intExp = CarConfig.CACTUS_NOISE_INTENSITY_EXP
    const intFloor = CarConfig.CACTUS_NOISE_INTENSITY_FLOOR
    const acceptGain = CarConfig.CACTUS_NOISE_ACCEPTANCE_GAIN
    const slopeMax = CarConfig.CACTUS_MAX_SLOPE_FOR_PLACEMENT
    const slopeEps = CarConfig.CACTUS_SLOPE_SAMPLE_EPS_M
    const placed: [number, number, number][] = []

    const dryMinY =
      pondSurfaceY !== undefined
        ? pondSurfaceY + CarConfig.CACTUS_MIN_CLEARANCE_ABOVE_POND_M
        : -Infinity
    const terrainMinY =
      pondSurfaceY !== undefined ? pondSurfaceY - CarConfig.POND_SURFACE_ABOVE_MIN_Y : Number.NEGATIVE_INFINITY

    let attempts = 0
    const maxAttempts = count * 1300

    while (placed.length < count && attempts < maxAttempts) {
      attempts++
      const x = margin + rng() * (half * 2 - margin * 2) - half
      const z = margin + rng() * (half * 2 - margin * 2) - half
      if (Math.hypot(x, z) < clearR) continue
      if (
        hardExclusions.some((ex) => {
          const dx = x - ex.x
          const dz = z - ex.z
          return dx * dx + dz * dz < ex.r * ex.r
        })
      ) {
        continue
      }
      const h = terrain.heightAt(x, z)
      if (h < dryMinY) continue
      if (slopeMagnitude(terrain, x, z, slopeEps) > slopeMax) continue
      if (rng() > mountainKeepProbability(h, terrainMinY)) continue
      if (
        sparseExclusions.some((ex) => {
          const d = Math.hypot(x - ex.x, z - ex.z)
          if (d >= ex.r * 1.7) return false
          const keep = THREE.MathUtils.lerp(0.08, 1, THREE.MathUtils.clamp(d / (ex.r * 1.7), 0, 1))
          return rng() > keep
        })
      ) {
        continue
      }

      const mask = cactusPlacementMask(densityNoise, x, z)
      if (mask < emptyBelow) continue

      const shaped = Math.pow(THREE.MathUtils.clamp(mask, 0, 1), intExp)
      const intensity = THREE.MathUtils.lerp(intFloor, 1, shaped)
      if (rng() > Math.min(1, intensity * acceptGain)) continue

      if (placed.some(([px, , pz]) => Math.hypot(x - px, z - pz) < minSep)) continue
      placed.push([x, mask, z])
    }

    const pending: CactusPending[] = []
    for (let i = 0; i < placed.length; i++) {
      const [x, mask, z] = placed[i]!
      const templateIdx = i % templates.length
      const tMask =
        emptyBelow >= 1 - 1e-6 ? 1 : THREE.MathUtils.inverseLerp(emptyBelow, 1, mask)
      const cl = THREE.MathUtils.clamp(tMask, 0, 1)
      const scaleMul = THREE.MathUtils.lerp(1, CarConfig.CACTUS_SCALE_MASK_BOOST, cl)
      const scale =
        THREE.MathUtils.lerp(CarConfig.CACTUS_SCALE_MIN, CarConfig.CACTUS_SCALE_MAX, rng()) * scaleMul
      const rotY = rng() * Math.PI * 2
      pending.push({ x, z, mask, templateIdx, scale, rotY })
    }

    const snapMesh = new THREE.Mesh(merged[0]!.geometry, merged[0]!.material)
    snapMesh.frustumCulled = false

    for (let k = 0; k < templates.length; k++) {
      const group = pending.filter((p) => p.templateIdx === k)
      const n = group.length
      if (n === 0) continue

      const { geometry, material } = merged[k]!
      snapMesh.geometry = geometry
      snapMesh.material = material
      geometry.computeBoundingBox()
      const minY = geometry.boundingBox?.min.y ?? 0

      const instanced = new THREE.InstancedMesh(geometry, material, n)
      instanced.castShadow = true
      instanced.receiveShadow = true
      instanced.frustumCulled = true

      for (let j = 0; j < n; j++) {
        const p = group[j]!
        snapMesh.scale.setScalar(p.scale)
        if (raycastGround(terrain, p.x, p.z, _tmpP, _tmpN)) {
          _tmpQ.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, _tmpN)
          _tmpQ2.setFromAxisAngle(_tmpN, p.rotY)
          snapMesh.quaternion.copy(_tmpQ2.multiply(_tmpQ))
          const bottomTarget = _tmpP.addScaledVector(_tmpN, -CarConfig.CACTUS_GROUND_SINK_M)
          snapMesh.position.copy(bottomTarget).addScaledVector(_tmpN, -minY * p.scale)
        } else {
          snapMesh.rotation.set(0, p.rotY, 0)
          snapMesh.position.set(p.x, terrain.heightAt(p.x, p.z) - minY * p.scale - CarConfig.CACTUS_GROUND_SINK_M, p.z)
        }
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
        colliderDesc.setFriction(0.75).setRestitution(0.05)

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
