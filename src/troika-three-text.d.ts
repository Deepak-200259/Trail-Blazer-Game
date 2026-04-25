declare module 'troika-three-text' {
  import type { Material, Mesh } from 'three'

  export class Text extends Mesh {
    text: string
    fontSize: number
    letterSpacing: number
    color: number | string | null
    outlineWidth: number | string
    outlineColor: number | string
    outlineOpacity: number
    strokeWidth: number | string
    strokeColor: number | string
    strokeOpacity: number
    anchorX: number | string
    anchorY: number | string
    depthOffset: number
    material: Material | Material[]
    sync(callback?: () => void): void
    dispose(): void
  }
}
