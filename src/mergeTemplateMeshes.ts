import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

export type MergedTemplateGeometry = {
  geometry: THREE.BufferGeometry
  /** Single material, or one entry per merged draw group (same order as `mergeGeometries(..., true)`). */
  material: THREE.Material | THREE.Material[]
}

/** Copy one indexed triangle list into a new compact indexed `BufferGeometry`. */
function sliceIndexedTriangles(
  src: THREE.BufferGeometry,
  indexStart: number,
  indexCount: number,
): THREE.BufferGeometry {
  const index = src.getIndex()
  if (!index || indexCount <= 0) {
    return src.clone()
  }

  const oldToNew = new Map<number, number>()
  const newIndices: number[] = []
  for (let i = 0; i < indexCount; i++) {
    const oldI = index.getX(indexStart + i)
    let ni = oldToNew.get(oldI)
    if (ni === undefined) {
      ni = oldToNew.size
      oldToNew.set(oldI, ni)
    }
    newIndices.push(ni)
  }

  const nv = oldToNew.size
  const out = new THREE.BufferGeometry()
  for (const name of Object.keys(src.attributes)) {
    const attr = src.attributes[name]
    if (!(attr instanceof THREE.BufferAttribute)) continue
    const itemSize = attr.itemSize
    const ArrayCtor = attr.array.constructor as new (n: number) => ArrayBufferView
    const arr = new ArrayCtor(nv * itemSize)
    const dst = new THREE.BufferAttribute(arr as THREE.BufferAttribute['array'], itemSize, attr.normalized)
    oldToNew.forEach((newIdx, oldIdx) => {
      for (let c = 0; c < itemSize; c++) {
        dst.setComponent(newIdx, c, attr.getComponent(oldIdx, c))
      }
    })
    out.setAttribute(name, dst)
  }

  out.setIndex(newIndices)
  return out
}

/**
 * Merge all `Mesh` geometries under `rootTemplate` into one `BufferGeometry` in the root’s
 * local frame. Multiple materials are preserved via geometry groups + `material` as an array
 * (suitable for `InstancedMesh`).
 */
export function mergeTemplateMeshesToGeometry(rootTemplate: THREE.Object3D): MergedTemplateGeometry {
  const root = rootTemplate.clone(true)
  root.updateMatrixWorld(true)
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const rel = new THREE.Matrix4()
  const parts: THREE.BufferGeometry[] = []
  const materialsList: THREE.Material[] = []

  root.traverse((obj) => {
    const m = obj as THREE.Mesh
    if (!m.isMesh || !m.geometry) return

    const gBase = m.geometry.clone()
    rel.multiplyMatrices(invRoot, m.matrixWorld)
    gBase.applyMatrix4(rel)

    const rawMats = m.material
    const matArr: THREE.Material[] = Array.isArray(rawMats)
      ? (rawMats as THREE.Material[])
      : [rawMats as THREE.Material]

    if (Array.isArray(rawMats) && gBase.groups.length > 0) {
      for (const grp of gBase.groups) {
        const mat = matArr[grp.materialIndex ?? 0]
        if (!mat) continue
        const slice = sliceIndexedTriangles(gBase, grp.start, grp.count)
        parts.push(slice)
        materialsList.push(mat.clone() as THREE.Material)
      }
    } else {
      const g = gBase
      g.clearGroups()
      parts.push(g)
      const mat0 = matArr[0] ?? new THREE.MeshStandardMaterial({ color: 0x889977 })
      materialsList.push(mat0.clone() as THREE.Material)
    }
  })

  if (parts.length === 0) {
    return {
      geometry: new THREE.BoxGeometry(0.4, 1.2, 0.4),
      material: new THREE.MeshStandardMaterial({ color: 0x448844 }),
    }
  }

  const multiPart = parts.length > 1
  const merged = mergeGeometries(parts, multiPart)
  if (!merged) {
    return {
      geometry: new THREE.BoxGeometry(0.4, 1.2, 0.4),
      material: new THREE.MeshStandardMaterial({ color: 0x448844 }),
    }
  }

  if (!multiPart) {
    mergeVertices(merged, 4e-4)
  }
  merged.computeVertexNormals()
  merged.computeBoundingBox()

  const material: THREE.Material | THREE.Material[] =
    materialsList.length === 1 ? materialsList[0]! : materialsList

  return { geometry: merged, material }
}
