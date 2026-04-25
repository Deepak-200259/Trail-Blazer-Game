export class MovementInput {
  forward = 0
  right = 0
  brake = 0
  reset = false

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const k = event.key
    if (k === 'w' || k === 'ArrowUp') this.forward = -1
    if (k === 's' || k === 'ArrowDown') this.forward = 1
    if (k === 'a' || k === 'ArrowLeft') this.right = 1
    if (k === 'd' || k === 'ArrowRight') this.right = -1
    if (k === 'r' || k === 'R') this.reset = true
    if (k === ' ') {
      event.preventDefault()
      this.brake = 1
    }
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const k = event.key
    if (k === 'w' || k === 's' || k === 'ArrowUp' || k === 'ArrowDown') this.forward = 0
    if (k === 'a' || k === 'd' || k === 'ArrowLeft' || k === 'ArrowRight') this.right = 0
    if (k === 'r' || k === 'R') this.reset = false
    if (k === ' ') this.brake = 0
  }
}
