import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js'
import { CarConfig } from './CarConfig.ts'
import { duplicateUv2ForAoMap } from './loadDirtFloorMaterial.ts'

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Raw dunes (no spawn pad). */
export function desertTerrainRawHeight(
  noise: SimplexNoise,
  worldX: number,
  worldZ: number,
  noiseScale: number,
  amplitude: number,
  octaves: number,
): number {
  let sum = 0
  let norm = 0
  let amp = 1
  let freq = noiseScale
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise(worldX * freq, worldZ * freq)
    norm += amp
    amp *= 0.52
    freq *= 2.05
  }
  const n = sum / norm
  const shaped = Math.sign(n) * Math.pow(Math.abs(n), 1.15)
  const ps = CarConfig.TERRAIN_NOISE_PATCH_SCALE
  const patch = THREE.MathUtils.clamp((noise.noise(worldX * ps, worldZ * ps) + 1) * 0.5, 0, 1)
  const patchBoost = THREE.MathUtils.lerp(1, CarConfig.TERRAIN_NOISE_PATCH_BOOST, Math.pow(patch, 1.8))
  return shaped * amplitude * patchBoost
}

/**
 * Final surface height for mesh + physics: flat circular pad at origin (elevation = raw noise
 * at (0,0)), smooth blend to full dunes so the vehicle does not roll off spawn.
 */
export function desertTerrainHeight(
  noise: SimplexNoise,
  worldX: number,
  worldZ: number,
  noiseScale: number,
  amplitude: number,
  octaves: number,
): number {
  const hBase = desertTerrainRawHeight(noise, worldX, worldZ, noiseScale, amplitude, octaves)
  const hLow = desertTerrainRawHeight(
    noise,
    worldX,
    worldZ,
    noiseScale * 0.52,
    amplitude * 0.58,
    Math.max(2, Math.floor(octaves * 0.5)),
  )
  const rp = Math.hypot(worldX - CarConfig.POND_CENTER_X, worldZ - CarConfig.POND_CENTER_Z)
  const rs0 = CarConfig.POND_SHORE_SMOOTH_INNER_R
  const rs1 = CarConfig.POND_SHORE_SMOOTH_OUTER_R
  let hPond = hBase
  if (rs1 > rs0 && rp < rs1) {
    const t = THREE.MathUtils.clamp((rp - rs0) / (rs1 - rs0), 0, 1)
    const sm = t * t * t * (t * (t * 6 - 15) + 10)
    const damp = (1 - sm) * CarConfig.POND_SHORE_NOISE_DAMP
    hPond = THREE.MathUtils.lerp(hBase, hLow, damp)
    hPond -= (1 - sm) * CarConfig.POND_BASIN_DEPTH_M
  }
  const r = Math.hypot(worldX, worldZ)
  const half = CarConfig.TERRAIN_HALF_EXTENT
  const ringStart = half * CarConfig.TERRAIN_MOUNTAIN_RING_START_FRAC
  const ringFull = half * CarConfig.TERRAIN_MOUNTAIN_RING_FULL_FRAC
  let mountain = 0
  if (ringFull > ringStart && r > ringStart) {
    const t = THREE.MathUtils.clamp((r - ringStart) / (ringFull - ringStart), 0, 1)
    const ring = t * t * (3 - 2 * t)
    const mns = CarConfig.TERRAIN_MOUNTAIN_NOISE_SCALE
    const n0 = 0.5 + 0.5 * noise.noise(worldX * mns, worldZ * mns)
    const n1 = 0.5 + 0.5 * noise.noise(worldX * mns * 1.9, worldZ * mns * 1.9)
    const ridge = Math.pow(THREE.MathUtils.clamp(n0 * 0.72 + n1 * 0.28, 0, 1), CarConfig.TERRAIN_MOUNTAIN_RIDGE_EXP)
    mountain = CarConfig.TERRAIN_MOUNTAIN_HEIGHT * ring * THREE.MathUtils.lerp(0.55, 1.1, ridge)
  }
  let h = hPond + mountain
  const rs2 = CarConfig.POND_SHORE_EDGE_OUTER_R
  if (rs2 > rs1 && rp < rs2 && rp > rs0) {
    const u = rp <= rs1 ? 0 : (rp - rs1) / (rs2 - rs1)
    const fe = u * u * (3 - 2 * u)
    const natural = hBase + mountain
    h = THREE.MathUtils.lerp(h, natural, fe * CarConfig.POND_SHORE_OUTER_FEATHER)
  }
  const h0 = desertTerrainRawHeight(noise, 0, 0, noiseScale, amplitude, octaves)
  const rin = CarConfig.TERRAIN_SPAWN_PAD_INNER
  const rout = CarConfig.TERRAIN_SPAWN_PAD_OUTER
  if (rout <= rin) return h
  if (r <= rin) return h0
  if (r >= rout) return h
  const t = (r - rin) / (rout - rin)
  const sm = t * t * (3 - 2 * t)
  return THREE.MathUtils.lerp(h0, h, sm)
}

/**
 * Procedural desert: undulating dunes from layered Simplex noise + Rapier trimesh ground.
 */
export class DesertTerrainGround {
  readonly mesh: THREE.Mesh
  /** Lowest terrain vertex Y in the built mesh (world space, same frame as `mesh`). */
  readonly terrainMinY: number
  private readonly noise: SimplexNoise

  constructor(world: RAPIER.World, scene: THREE.Scene, material: THREE.MeshStandardMaterial) {
    const half = CarConfig.TERRAIN_HALF_EXTENT
    const n = CarConfig.TERRAIN_VERTS_PER_SIDE
    const rng = mulberry32(CarConfig.TERRAIN_SEED)
    this.noise = new SimplexNoise({ random: () => rng() })

    const positions: number[] = []
    const indices: number[] = []
    const uvs: number[] = []

    const amp = CarConfig.TERRAIN_AMPLITUDE
    const ns = CarConfig.TERRAIN_NOISE_SCALE
    const oct = CarConfig.TERRAIN_FBM_OCTAVES

    let minY = Infinity
    for (let j = 0; j <= n; j++) {
      const z = (j / n) * half * 2 - half
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * half * 2 - half
        const y = desertTerrainHeight(this.noise, x, z, ns, amp, oct)
        minY = Math.min(minY, y)
        positions.push(x, y, z)
        uvs.push(i / n, j / n)
      }
    }
    this.terrainMinY = minY

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i
        const b = a + 1
        const d = a + (n + 1)
        const c = d + 1
        indices.push(a, d, b, b, d, c)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    duplicateUv2ForAoMap(geo)
    geo.computeVertexNormals()
    try {
      geo.computeTangents()
    } catch {
      /* optional */
    }

    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.receiveShadow = true
    this.mesh.castShadow = false
    scene.add(this.mesh)

    const verts = geo.attributes.position.array as Float32Array
    const idxArr = geo.index!.array
    const ix =
      idxArr instanceof Uint32Array ? idxArr : Uint32Array.from(idxArr as ArrayLike<number>)
    const colliderDesc = RAPIER.ColliderDesc.trimesh(verts, ix)
      .setFriction(1)
      .setRestitution(0.02)
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(colliderDesc, groundBody)
  }

  /** World-space ground height (matches collider). */
  heightAt(worldX: number, worldZ: number): number {
    return desertTerrainHeight(
      this.noise,
      worldX,
      worldZ,
      CarConfig.TERRAIN_NOISE_SCALE,
      CarConfig.TERRAIN_AMPLITUDE,
      CarConfig.TERRAIN_FBM_OCTAVES,
    )
  }
}
