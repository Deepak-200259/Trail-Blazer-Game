import * as THREE from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { CarConfig } from './CarConfig.ts'

const TEX_BASE = '/textures/'

function configureMap(
  tex: THREE.Texture,
  repeat: number,
  aniso: number,
  colorSpace: THREE.ColorSpace,
): void {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeat, repeat)
  tex.anisotropy = aniso
  tex.colorSpace = colorSpace
  tex.needsUpdate = true
}

/**
 * Loads every file in `public/textures/` for the dirt floor PBR set into one `MeshStandardMaterial`.
 *
 * - **diff** → `map`
 * - **ao** → `aoMap`
 * - **arm** → `roughnessMap` (G) + `metalnessMap` (B), typical PolyHaven-style pack
 * - **disp** → `displacementMap`
 * - **nor_gl** → `normalMap`
 * - **rough** → `bumpMap` (height-like micro variation; roughness already driven by ARM green)
 */
export async function loadDirtFloorMaterial(
  renderer: THREE.WebGLRenderer,
  options?: {
    uvRepeat?: number
    displacementScale?: number
    displacementBias?: number
    bumpScale?: number
  },
): Promise<THREE.MeshStandardMaterial> {
  const repeat = options?.uvRepeat ?? CarConfig.DIRT_FLOOR_UV_REPEAT
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy())
  const texLoader = new THREE.TextureLoader()
  const exrLoader = new EXRLoader()

  const [diff, ao, arm, disp, nor, rough] = await Promise.all([
    texLoader.loadAsync(`${TEX_BASE}dirt_floor_diff_1k.jpg`),
    texLoader.loadAsync(`${TEX_BASE}dirt_floor_ao_1k.jpg`),
    texLoader.loadAsync(`${TEX_BASE}dirt_floor_arm_1k.jpg`),
    texLoader.loadAsync(`${TEX_BASE}dirt_floor_disp_1k.png`),
    exrLoader.loadAsync(`${TEX_BASE}dirt_floor_nor_gl_1k.exr`),
    exrLoader.loadAsync(`${TEX_BASE}dirt_floor_rough_1k.exr`),
  ])

  configureMap(diff, repeat, aniso, THREE.SRGBColorSpace)
  configureMap(ao, repeat, aniso, THREE.NoColorSpace)
  configureMap(arm, repeat, aniso, THREE.NoColorSpace)
  configureMap(disp, repeat, aniso, THREE.NoColorSpace)
  configureMap(nor, repeat, aniso, THREE.NoColorSpace)
  configureMap(rough, repeat, aniso, THREE.NoColorSpace)

  nor.flipY = false
  for (const t of [diff, ao, arm, disp, nor, rough]) {
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.magFilter = THREE.LinearFilter
    t.generateMipmaps = true
  }

  const mat = new THREE.MeshStandardMaterial({
    map: diff,
    aoMap: ao,
    aoMapIntensity: 0.88,
    normalMap: nor,
    /** Low sun exaggerates tangent detail — keep normals subtle to avoid shimmering “crisp” sand. */
    normalScale: new THREE.Vector2(0.52, 0.52),
    roughnessMap: arm,
    roughness: 1,
    metalnessMap: arm,
    metalness: 1,
    displacementMap: disp,
    displacementScale: options?.displacementScale ?? CarConfig.DIRT_FLOOR_DISP_SCALE_FLAT,
    displacementBias: options?.displacementBias ?? 0,
    bumpMap: rough,
    bumpScale: options?.bumpScale ?? 0.0045,
    envMapIntensity: 0.42,
    color: 0xffffff,
  })

  return mat
}

/** `aoMap` uses the second UV set in many Three versions — mirror `uv` into `uv2`. */
export function duplicateUv2ForAoMap(geo: THREE.BufferGeometry): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv) return
  const arr = uv.array
  const c = new Float32Array(arr.length)
  c.set(arr)
  geo.setAttribute('uv2', new THREE.BufferAttribute(c, 2))
}
