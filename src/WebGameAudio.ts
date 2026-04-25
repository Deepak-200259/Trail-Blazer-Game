import * as THREE from 'three'

const AUDIO_MUTED_LS_KEY = 'car-physics-audio-muted-v1'

export type DrivingAudioSnapshot = {
  speedMps: number
  throttle: number
  steer: number
  brake: number
  groundedRatio: number
  driveEnabled: boolean
  waterWade: number
}

/**
 * Lightweight procedural audio built on Web Audio API:
 * - engine loop (oscillators + low-pass)
 * - skid loop (filtered noise)
 * - one-shot UI/gameplay beeps (checkpoint / finish)
 */
export class WebGameAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private engineGain: GainNode | null = null
  private engineFilter: BiquadFilterNode | null = null
  private engineDrive: WaveShaperNode | null = null
  private engineOscA: OscillatorNode | null = null
  private engineOscB: OscillatorNode | null = null
  private engineOscSub: OscillatorNode | null = null
  private skidGain: GainNode | null = null
  private skidFilter: BiquadFilterNode | null = null
  private skidSource: AudioBufferSourceNode | null = null
  private burstCooldownS = 0
  private prevThrottle = 0
  private muted = WebGameAudio.getStoredMuted()
  private paused = false

  static getStoredMuted(): boolean {
    if (typeof localStorage === 'undefined') return true
    const raw = localStorage.getItem(AUDIO_MUTED_LS_KEY)
    if (raw === null) return true
    return raw === '1'
  }

  static setStoredMuted(muted: boolean): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(AUDIO_MUTED_LS_KEY, muted ? '1' : '0')
  }

  unlockFromUserGesture(): void {
    if (!this.ctx) {
      this.createGraph()
    }
    if (!this.ctx) return
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    WebGameAudio.setStoredMuted(this.muted)
    this.applyMasterGain()
    return this.muted
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    WebGameAudio.setStoredMuted(this.muted)
    this.applyMasterGain()
  }

  isMuted(): boolean {
    return this.muted
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const gain = paused ? 0.0001 : 1
    this.engineGain?.gain.setTargetAtTime(gain, now, 0.03)
    this.skidGain?.gain.setTargetAtTime(gain, now, 0.03)
    this.applyMasterGain()
  }

  updateDriving(snapshot: DrivingAudioSnapshot, dt = 1 / 60): void {
    if (!this.ctx || this.ctx.state !== 'running') return
    const now = this.ctx.currentTime
    const t = 0.06

    const throttle = THREE.MathUtils.clamp(snapshot.throttle, 0, 1)
    const steer = THREE.MathUtils.clamp(snapshot.steer, 0, 1)
    const brake = THREE.MathUtils.clamp(snapshot.brake, 0, 1)
    const grounded = THREE.MathUtils.clamp(snapshot.groundedRatio, 0, 1)
    const speedNorm = THREE.MathUtils.clamp(snapshot.speedMps / 48, 0, 1)
    const drive = snapshot.driveEnabled && !this.paused ? 1 : 0
    const water = THREE.MathUtils.clamp(snapshot.waterWade, 0, 1)
    const stepDt = THREE.MathUtils.clamp(dt, 1 / 240, 0.2)
    this.burstCooldownS = Math.max(0, this.burstCooldownS - stepDt)

    const rpmNorm = THREE.MathUtils.clamp(0.1 + speedNorm * 0.74 + throttle * 0.26, 0, 1)
    const air = 1 - grounded
    const engineHz = THREE.MathUtils.lerp(38, 145, rpmNorm)
    const groundPresence = THREE.MathUtils.lerp(0.55, 1, grounded)
    const engineGainTarget = drive * groundPresence * (0.08 + rpmNorm * 0.23 + throttle * 0.12) * (1 - water * 0.28)
    const engineCutoff =
      THREE.MathUtils.lerp(900, 3400, rpmNorm) * (1 - water * 0.24) * THREE.MathUtils.lerp(0.72, 1, grounded)

    this.engineOscA?.frequency.setTargetAtTime(engineHz, now, t)
    this.engineOscB?.frequency.setTargetAtTime(engineHz * THREE.MathUtils.lerp(1.85, 2.15, throttle), now, t)
    this.engineOscSub?.frequency.setTargetAtTime(engineHz * 0.52, now, t)
    this.engineGain?.gain.setTargetAtTime(engineGainTarget, now, t)
    this.engineFilter?.frequency.setTargetAtTime(engineCutoff, now, t)
    this.engineFilter?.Q.setTargetAtTime(THREE.MathUtils.lerp(1.0, 1.6, throttle) + air * 0.6, now, 0.06)

    const slip = THREE.MathUtils.clamp(speedNorm * (steer * 0.95 + brake * 0.9), 0, 1)
    const skidTarget = slip * grounded * drive * (0.18 + speedNorm * 0.12)
    this.skidGain?.gain.setTargetAtTime(skidTarget, now, 0.045)
    this.skidFilter?.frequency.setTargetAtTime(THREE.MathUtils.lerp(900, 2600, speedNorm), now, 0.05)

    const throttleRise = Math.max(0, throttle - this.prevThrottle)
    if (drive > 0 && throttleRise > 0.2 && this.burstCooldownS <= 0 && speedNorm > 0.04) {
      const intensity = THREE.MathUtils.clamp(0.45 + throttleRise * 1.2 + throttle * 0.5, 0, 1.25)
      this.playBurst(intensity, speedNorm)
      this.burstCooldownS = THREE.MathUtils.lerp(0.12, 0.22, 1 - speedNorm)
    }
    this.prevThrottle = throttle
  }

  playCheckpoint(lastCheckpoint: boolean): void {
    if (!this.ctx || this.ctx.state !== 'running') return
    if (lastCheckpoint) {
      this.playTone(620, 860, 0.12, 0.08, 'triangle')
      this.playTone(760, 1120, 0.15, 0.08, 'triangle', 0.11)
      return
    }
    this.playTone(540, 760, 0.11, 0.075, 'triangle')
  }

  playRaceFinish(): void {
    if (!this.ctx || this.ctx.state !== 'running') return
    this.playTone(500, 840, 0.14, 0.09, 'square')
    this.playTone(700, 1100, 0.18, 0.08, 'triangle', 0.12)
    this.playTone(980, 1360, 0.2, 0.07, 'triangle', 0.22)
  }

  private createGraph(): void {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted || this.paused ? 0 : 1
    this.master.connect(this.ctx.destination)

    this.engineFilter = this.ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 1700
    this.engineFilter.Q.value = 1.25
    this.engineDrive = this.ctx.createWaveShaper()
    this.engineDrive.curve = this.makeDriveCurve(92)
    this.engineDrive.oversample = '4x'
    this.engineGain = this.ctx.createGain()
    this.engineGain.gain.value = 0

    this.engineOscA = this.ctx.createOscillator()
    this.engineOscA.type = 'sawtooth'
    this.engineOscA.frequency.value = 78
    this.engineOscB = this.ctx.createOscillator()
    this.engineOscB.type = 'square'
    this.engineOscB.frequency.value = 150
    this.engineOscSub = this.ctx.createOscillator()
    this.engineOscSub.type = 'triangle'
    this.engineOscSub.frequency.value = 46

    this.engineOscA.connect(this.engineFilter)
    this.engineOscB.connect(this.engineFilter)
    this.engineOscSub.connect(this.engineFilter)
    this.engineFilter.connect(this.engineDrive)
    this.engineDrive.connect(this.engineGain)
    this.engineGain.connect(this.master)
    this.engineOscA.start()
    this.engineOscB.start()
    this.engineOscSub.start()

    this.skidFilter = this.ctx.createBiquadFilter()
    this.skidFilter.type = 'bandpass'
    this.skidFilter.frequency.value = 1400
    this.skidFilter.Q.value = 0.7
    this.skidGain = this.ctx.createGain()
    this.skidGain.gain.value = 0
    this.skidSource = this.createNoiseSource(this.ctx)
    this.skidSource.connect(this.skidFilter)
    this.skidFilter.connect(this.skidGain)
    this.skidGain.connect(this.master)
    this.skidSource.start()
  }

  private createNoiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const dur = 2.0
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur))
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.6
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    return src
  }

  private playBurst(intensity: number, speedNorm: number): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime
    const dur = THREE.MathUtils.lerp(0.07, 0.12, speedNorm)

    const o = this.ctx.createOscillator()
    const og = this.ctx.createGain()
    o.type = 'sawtooth'
    const f0 = THREE.MathUtils.lerp(75, 120, speedNorm)
    o.frequency.setValueAtTime(f0, now)
    o.frequency.exponentialRampToValueAtTime(Math.max(35, f0 * 0.62), now + dur)
    og.gain.setValueAtTime(0.0001, now)
    og.gain.exponentialRampToValueAtTime(0.08 * intensity, now + 0.012)
    og.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    o.connect(og)
    og.connect(this.master)
    o.start(now)
    o.stop(now + dur + 0.03)

    const n = Math.max(1, Math.floor(this.ctx.sampleRate * 0.06))
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.95
    const ns = this.ctx.createBufferSource()
    const nf = this.ctx.createBiquadFilter()
    const ng = this.ctx.createGain()
    ns.buffer = buf
    nf.type = 'bandpass'
    nf.frequency.value = THREE.MathUtils.lerp(700, 1200, speedNorm)
    nf.Q.value = 1.2
    ng.gain.setValueAtTime(0.0001, now)
    ng.gain.exponentialRampToValueAtTime(0.045 * intensity, now + 0.008)
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.055)
    ns.connect(nf)
    nf.connect(ng)
    ng.connect(this.master)
    ns.start(now)
    ns.stop(now + 0.07)
  }

  private makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 2048
    const out = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT))
    const k = Math.max(1, amount)
    const deg = Math.PI / 180
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1
      out[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x))
    }
    return out
  }

  private applyMasterGain(): void {
    if (!this.master || !this.ctx) return
    this.master.gain.setValueAtTime(this.muted || this.paused ? 0 : 1, this.ctx.currentTime)
  }

  private playTone(
    hzStart: number,
    hzEnd: number,
    durS: number,
    gainPeak: number,
    type: OscillatorType,
    delayS = 0,
  ): void {
    if (!this.ctx || !this.master) return
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    const now = this.ctx.currentTime + Math.max(0, delayS)
    o.type = type
    o.frequency.setValueAtTime(Math.max(30, hzStart), now)
    o.frequency.exponentialRampToValueAtTime(Math.max(40, hzEnd), now + Math.max(0.03, durS))
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainPeak), now + Math.max(0.02, durS * 0.2))
    g.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.05, durS))
    o.connect(g)
    g.connect(this.master)
    o.start(now)
    o.stop(now + Math.max(0.06, durS + 0.02))
  }
}
