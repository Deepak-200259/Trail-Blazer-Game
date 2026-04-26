export class MovementInput {
  forward = 0
  right = 0
  brake = 0
  reset = false
  private keyForward = 0
  private keyRight = 0
  private touchForward = 0
  private touchRight = 0
  private joyPointerId: number | null = null
  private joyZoneEl: HTMLElement | null = null
  private joyKnobEl: HTMLElement | null = null

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    this.bindTouchControls()
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    this.unbindTouchControls()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const k = event.key
    if (k === 'w' || k === 'ArrowUp') this.keyForward = -1
    if (k === 's' || k === 'ArrowDown') this.keyForward = 1
    if (k === 'a' || k === 'ArrowLeft') this.keyRight = 1
    if (k === 'd' || k === 'ArrowRight') this.keyRight = -1
    this.syncOutput()
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const k = event.key
    if (k === 'w' || k === 'ArrowUp') {
      if (this.keyForward < 0) this.keyForward = 0
    }
    if (k === 's' || k === 'ArrowDown') {
      if (this.keyForward > 0) this.keyForward = 0
    }
    if (k === 'a' || k === 'ArrowLeft') {
      if (this.keyRight > 0) this.keyRight = 0
    }
    if (k === 'd' || k === 'ArrowRight') {
      if (this.keyRight < 0) this.keyRight = 0
    }
    this.syncOutput()
  }

  private bindTouchControls(): void {
    this.joyZoneEl = document.getElementById('mobile-joy-zone')
    this.joyKnobEl = document.getElementById('mobile-joy-knob')
    if (!this.joyZoneEl || !this.joyKnobEl) return
    this.joyZoneEl.addEventListener('pointerdown', this.onJoyDown, { passive: false })
    window.addEventListener('pointermove', this.onJoyMove, { passive: false })
    window.addEventListener('pointerup', this.onJoyUp, true)
    window.addEventListener('pointercancel', this.onJoyUp, true)
  }

  private unbindTouchControls(): void {
    this.joyZoneEl?.removeEventListener('pointerdown', this.onJoyDown)
    window.removeEventListener('pointermove', this.onJoyMove)
    window.removeEventListener('pointerup', this.onJoyUp, true)
    window.removeEventListener('pointercancel', this.onJoyUp, true)
  }

  private readonly onJoyDown = (ev: PointerEvent): void => {
    if (!this.joyZoneEl) return
    ev.preventDefault()
    this.joyPointerId = ev.pointerId
    this.joyZoneEl.setPointerCapture(ev.pointerId)
    this.updateJoyAxes(ev.clientX, ev.clientY)
  }

  private readonly onJoyMove = (ev: PointerEvent): void => {
    if (this.joyPointerId !== ev.pointerId) return
    ev.preventDefault()
    this.updateJoyAxes(ev.clientX, ev.clientY)
  }

  private readonly onJoyUp = (ev: PointerEvent): void => {
    if (this.joyPointerId !== ev.pointerId) return
    this.joyPointerId = null
    this.touchForward = 0
    this.touchRight = 0
    if (this.joyKnobEl) this.joyKnobEl.style.transform = 'translate(-50%, -50%)'
    this.syncOutput()
  }

  private updateJoyAxes(clientX: number, clientY: number): void {
    if (!this.joyZoneEl || !this.joyKnobEl) return
    const rect = this.joyZoneEl.getBoundingClientRect()
    const cx = rect.left + rect.width * 0.5
    const cy = rect.top + rect.height * 0.5
    const dx = clientX - cx
    const dy = clientY - cy
    const radius = rect.width * 0.38
    const len = Math.hypot(dx, dy)
    const scale = len > radius ? radius / len : 1
    const clampedX = dx * scale
    const clampedY = dy * scale
    const nx = clampedX / Math.max(1, radius)
    const ny = clampedY / Math.max(1, radius)
    const dead = 0.1
    const fx = Math.abs(nx) < dead ? 0 : nx
    const fy = Math.abs(ny) < dead ? 0 : ny
    this.touchRight = -fx
    this.touchForward = fy
    this.joyKnobEl.style.transform = `translate(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px))`
    this.syncOutput()
  }

  private syncOutput(): void {
    const f = this.keyForward + this.touchForward
    const r = this.keyRight + this.touchRight
    this.forward = Math.max(-1, Math.min(1, f))
    this.right = Math.max(-1, Math.min(1, r))
    this.brake = 0
    this.reset = false
  }
}
