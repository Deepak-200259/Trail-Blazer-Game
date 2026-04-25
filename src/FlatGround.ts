import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { CarConfig } from './CarConfig.ts'
import { duplicateUv2ForAoMap } from './loadDirtFloorMaterial.ts'

/** Infinite slab at y = 0 with PBR dirt floor from `public/textures/`. */
export class FlatGround {
  readonly mesh: THREE.Mesh

  constructor(world: RAPIER.World, scene: THREE.Scene, material: THREE.MeshStandardMaterial) {
    const hxz = CarConfig.GROUND_HALF_EXTENT_XZ
    const hy = CarConfig.GROUND_HALF_EXTENT_Y
    const planeSize = hxz * 2
    const seg = CarConfig.GROUND_PLANE_SEGMENTS

    const geo = new THREE.PlaneGeometry(planeSize, planeSize, seg, seg)
    duplicateUv2ForAoMap(geo)
    geo.computeVertexNormals()
    try {
      geo.computeTangents()
    } catch {
      /* optional; large planes can fail on degenerate tris in some builds */
    }

    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.position.set(0, 0, 0)
    this.mesh.receiveShadow = true
    scene.add(this.mesh)

    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hxz, hy, hxz)
        .setTranslation(0, -hy, 0)
        .setFriction(1),
      groundBody,
    )
  }

  /** Flat reference plane at y = 0. */
  heightAt(worldX: number, worldZ: number): number {
    void worldX
    void worldZ
    return 0
  }
}
