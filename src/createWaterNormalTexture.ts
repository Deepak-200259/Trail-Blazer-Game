import * as THREE from 'three'

const WATER_NORMALS_URL = 'https://threejs.org/examples/textures/waternormals.jpg'

/**
 * Official three.js normal map (fine ripples); falls back to procedural noise if load fails.
 */
export function loadWaterNormalMap(): Promise<THREE.Texture> {
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    loader.load(
      WATER_NORMALS_URL,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.colorSpace = THREE.NoColorSpace
        tex.repeat.set(16, 16)
        tex.anisotropy = 8
        resolve(tex)
      },
      undefined,
      () => {
        const fallback = createWaterNormalTexture(512)
        fallback.repeat.set(12, 12)
        resolve(fallback)
      },
    )
  })
}

/** High-frequency tangent-space normals when `waternormals.jpg` is unavailable. */
export function createWaterNormalTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D canvas unsupported')
  }
  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const nx =
        Math.sin(x * 0.38) * 0.18 +
        Math.sin((x + y * 1.07) * 0.21) * 0.14 +
        Math.sin((x * 0.71 - y) * 0.31) * 0.09
      const ny =
        Math.cos(y * 0.36) * 0.18 +
        Math.cos((y - x * 0.93) * 0.24) * 0.12 +
        Math.sin((x + y) * 0.42) * 0.08
      const nz = 1
      const len = Math.hypot(nx, ny, nz)
      d[i] = (nx / len) * 0.5 * 255 + 128
      d[i + 1] = (ny / len) * 0.5 * 255 + 128
      d[i + 2] = (nz / len) * 0.5 * 255 + 128
      d[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  return tex
}
