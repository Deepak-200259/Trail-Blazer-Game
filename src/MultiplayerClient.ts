/**
 * WebSocket client for the game server: lobby/rooms, then in-game state relay. Browser `WebSocket` only.
 */
export type MultiplayerVehicle = 1 | 2 | 3

export type MultiplayerKinematics = {
  readonly px: number
  readonly py: number
  readonly pz: number
  readonly qx: number
  readonly qy: number
  readonly qz: number
  readonly qw: number
  readonly vx: number
  readonly vy: number
  readonly vz: number
  readonly vehicle: MultiplayerVehicle
}

export type LobbyPlayer = { i: string; v: MultiplayerVehicle; n: string; r: 0 | 1; h: 0 | 1 }

const MAX_LOBBY_NAME_LEN = 20

/** Normalize one roster row (wire may use `playerName`, `n`, `name`…; missing → Player). */
export function normalizeLobbyPlayer(p: {
  i?: string
  n?: string
  name?: string
  v?: number
  r?: number
  h?: number
}): LobbyPlayer {
  const ext = p as { playerName?: string; displayName?: string; label?: string }
  const raw = ext.playerName ?? p.n ?? p.name ?? ext.displayName ?? ext.label
  const n =
    (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '')
      .replace(/\r|\n/g, ' ')
      .trim()
      .slice(0, MAX_LOBBY_NAME_LEN) || 'Player'
  const vn = Number((p as { v?: unknown }).v)
  const v: MultiplayerVehicle = vn === 3 ? 3 : vn === 2 ? 2 : 1
  return {
    i: String(p.i ?? ''),
    v,
    n,
    r: p.r === 1 ? 1 : 0,
    h: p.h === 1 ? 1 : 0,
  }
}

type HelloMsg = { t: 'hello'; id: string }
type LegacyWelcome = { t: 'welcome'; id: string; peers: string[] }
type LobbyMsg = { t: 'lobby'; code: string; ph: 'lobby' | 'cd' | 'playing'; end: number | null; pl: LobbyPlayer[] }
type GoMsg = { t: 'go'; pr: string[]; pl?: LobbyPlayer[] }
type ErrMsg = { t: 'err'; c: string }
type ServerState = {
  t: 'st'
  i: string
  p: [number, number, number]
  q: [number, number, number, number]
  v: [number, number, number]
  veh: MultiplayerVehicle
}
type ServerJoin = { t: 'join'; id: string }
type ServerLeave = { t: 'leave'; id: string }

export class MultiplayerClient {
  private ws: WebSocket | null = null
  private userDisconnect = false
  private everHello = false
  /** After `go`, only forward kinematics. */
  inGame = false

  localId: string | null = null
  onHello?: (id: string) => void
  /** @deprecated use lobby server */
  onWelcome?: (peerIds: string[]) => void
  onJoin?: (id: string) => void
  onLeave?: (id: string) => void
  onLobby?: (m: { code: string; ph: 'lobby' | 'cd' | 'playing'; end: number | null; pl: LobbyPlayer[] }) => void
  /** `pl` is the full room roster (same as lobby) when the server supports it; use for names at game start. */
  onGameStart?: (peerIds: string[], pl: LobbyPlayer[]) => void
  onPeerKinematics?: (id: string, k: MultiplayerKinematics) => void
  onServerError?: (code: string) => void
  onConnectionLost?: () => void

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  private send(t: string, o: Record<string, unknown> = {}): boolean {
    const w = this.ws
    if (w == null || w.readyState !== WebSocket.OPEN) return false
    try {
      w.send(JSON.stringify({ t, ...o }))
      return true
    } catch {
      return false
    }
  }

  private static prepDisplayName(displayName: string): string {
    return String(displayName ?? '')
      .replace(/\r|\n/g, ' ')
      .trim()
      .slice(0, MAX_LOBBY_NAME_LEN)
  }

  /**
   * Room create / join: send `n` and `name` (same value) so the server always receives a
   * display name; values are always strings (JSON.stringify omits `n` if undefined).
   * @returns false if the socket is not open or the name is empty.
   */
  createRoom(vehicle: MultiplayerVehicle, displayName: string): boolean {
    const w = this.ws
    if (w == null || w.readyState !== WebSocket.OPEN) return false
    const playerName = MultiplayerClient.prepDisplayName(displayName)
    if (playerName.length < 1) return false
    try {
      // `playerName` is the canonical key (avoids one-letter `n` issues in some runtimes);
      // duplicates keep old servers / parsers happy.
      w.send(
        JSON.stringify({
          t: 'host',
          v: vehicle,
          playerName,
          n: playerName,
          name: playerName,
        }),
      )
      return true
    } catch {
      return false
    }
  }

  joinRoom(code: string, vehicle: MultiplayerVehicle, displayName: string): boolean {
    const w = this.ws
    if (w == null || w.readyState !== WebSocket.OPEN) return false
    const roomCode = String(code)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
    const playerName = MultiplayerClient.prepDisplayName(displayName)
    if (playerName.length < 1) return false
    try {
      w.send(
        JSON.stringify({
          t: 'join',
          c: roomCode,
          v: vehicle,
          playerName,
          n: playerName,
          name: playerName,
        }),
      )
      return true
    } catch {
      return false
    }
  }

  setReady(ready: boolean): void {
    this.send('ready', { r: ready })
  }

  /** In lobby only: change vehicle before the match starts. */
  setLobbyVehicle(vehicle: MultiplayerVehicle): void {
    this.send('setVehicle', { v: vehicle })
  }

  leaveRoom(): void {
    this.send('leaveRoom')
  }

  /**
   * Lobby only: update this connection's display name on the server and refresh roster for everyone.
   * Same wire shape as create/join (`playerName` + legacy keys).
   */
  setLobbyDisplayName(displayName: string): boolean {
    const playerName = MultiplayerClient.prepDisplayName(displayName)
    if (playerName.length < 1) return false
    return this.send('setName', {
      playerName,
      n: playerName,
      name: playerName,
    })
  }

  setInGameMode(on: boolean): void {
    this.inGame = on
  }

  connect(url: string): Promise<void> {
    this.inGame = false
    this.userDisconnect = false
    this.everHello = false
    if (this.ws) {
      const prev = this.ws
      this.ws = null
      this.localId = null
      prev.close()
    }
    return new Promise((resolve, reject) => {
      let connectDone = false
      let to: ReturnType<typeof setTimeout> | undefined
      const fail = (e: Error): void => {
        if (connectDone) return
        connectDone = true
        if (to !== undefined) clearTimeout(to)
        reject(e)
      }

      const ok = (): void => {
        if (connectDone) return
        connectDone = true
        if (to !== undefined) clearTimeout(to)
        resolve()
      }

      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch (e) {
        reject(e instanceof Error ? e : new Error('WebSocket construct failed'))
        return
      }
      this.ws = socket

      to = window.setTimeout(() => {
        if (connectDone) return
        if (this.ws === socket) {
          this.ws = null
          try {
            socket.close()
          } catch {
            /* ignore */
          }
        }
        fail(new Error('WebSocket open timeout'))
      }, 12_000)

      const onFrameText = (raw: string): void => {
        if (this.ws !== socket) return
        type In =
          | HelloMsg
          | LegacyWelcome
          | LobbyMsg
          | GoMsg
          | ErrMsg
          | ServerState
          | ServerJoin
          | ServerLeave
        let m: In
        try {
          m = JSON.parse(raw) as In
        } catch {
          return
        }
        if (m.t === 'hello' || m.t === 'welcome') {
          if (this.everHello) return
          this.everHello = true
          const hi = m as { id?: string; i?: string; peers?: string[] }
          const sessionId = hi.id ?? hi.i
          if (sessionId == null || String(sessionId) === '') {
            fail(new Error('Invalid server hello (missing id)'))
            return
          }
          this.localId = String(sessionId)
          this.onHello?.(this.localId)
          if (m.t === 'welcome' && m.peers != null && m.peers.length > 0) {
            this.onWelcome?.(m.peers)
          } else {
            this.onWelcome?.([])
          }
          ok()
          return
        }
        if (m.t === 'lobby') {
          const lobby = m as LobbyMsg
          const pl = (Array.isArray(lobby.pl) ? lobby.pl : []).map((p) => normalizeLobbyPlayer(p))
          this.onLobby?.({ code: lobby.code, ph: lobby.ph, end: lobby.end, pl })
          return
        }
        if (m.t === 'err') {
          this.onServerError?.(m.c)
          return
        }
        if (m.t === 'go') {
          this.inGame = true
          const g = m as GoMsg
          const pl = (Array.isArray(g.pl) ? g.pl : []).map((p) => normalizeLobbyPlayer(p))
          this.onGameStart?.(g.pr, pl)
          return
        }
        if (m.t === 'join' && this.inGame) {
          this.onJoin?.(m.id)
          return
        }
        if (m.t === 'leave') {
          const leaver =
            (m as { id?: string; i?: string }).id ?? (m as { i?: string }).i
          if (leaver != null && String(leaver).length > 0) {
            this.onLeave?.(String(leaver))
          }
          return
        }
        if (m.t === 'st' && this.inGame) {
          this.onPeerKinematics?.(m.i, {
            px: m.p[0],
            py: m.p[1],
            pz: m.p[2],
            qx: m.q[0],
            qy: m.q[1],
            qz: m.q[2],
            qw: m.q[3],
            vx: m.v[0],
            vy: m.v[1],
            vz: m.v[2],
            vehicle: m.veh,
          })
        }
      }
      socket.addEventListener('message', (ev) => {
        if (this.ws !== socket) return
        const d = ev.data
        if (typeof d === 'string') {
          onFrameText(d)
          return
        }
        if (d instanceof ArrayBuffer) {
          try {
            onFrameText(new TextDecoder().decode(d))
          } catch {
            return
          }
          return
        }
        if (d instanceof Blob) {
          void d.text().then((raw) => onFrameText(raw))
        }
      })
      socket.addEventListener('error', () => {
        if (this.ws !== socket) return
        if (!this.everHello) fail(new Error('WebSocket error'))
      })
      socket.addEventListener('close', () => {
        if (this.ws !== socket) return
        if (to !== undefined) clearTimeout(to)
        this.ws = null
        const was = this.everHello
        this.everHello = false
        this.localId = null
        this.inGame = false
        if (!was && !connectDone) {
          fail(new Error('WebSocket closed before hello'))
          return
        }
        if (was && !this.userDisconnect) {
          this.onConnectionLost?.()
        }
      })
    })
  }

  sendKinematics(k: MultiplayerKinematics): void {
    const ws = this.ws
    if (ws == null || ws.readyState !== WebSocket.OPEN || !this.inGame) return
    ws.send(
      JSON.stringify({
        t: 'state',
        p: [k.px, k.py, k.pz],
        q: [k.qx, k.qy, k.qz, k.qw],
        v: [k.vx, k.vy, k.vz],
        veh: k.vehicle,
      }),
    )
  }

  disconnect(): void {
    this.userDisconnect = true
    this.inGame = false
    this.everHello = false
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
    this.localId = null
  }
}
