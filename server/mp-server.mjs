/**
 * Car-physics game server: room codes, ready + 10s countdown, in-game state relay.
 *
 *   npm run mp-server
 *   # MP_PORT=8000
 */
import { WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'

const port = Number(process.env.MP_PORT ?? 8000)
const MAX_PER_ROOM = 4
const CD_MS = 10_000
const HEARTBEAT_MS = 15_000

const wss = new WebSocketServer({ port })
wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `[mp-server] Port ${port} is already in use (another game server or app). Stop that process, or use a free port, e.g.:\n` +
        `  MP_PORT=8001 npm run mp-server\n` +
        `Then set Vite env VITE_MP_URL=ws://127.0.0.1:8001 (or the matching host) so the client uses the same port.`,
    )
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
/**
 * Authoritative session per socket id (`hello.id`).
 * `name` is the display name set on `host` / `join` / `setName` (never read from clients for other ids).
 * @type {Map<string, { ws: import('ws').WebSocket, roomCode: string | null, vehicle: 1 | 2 | 3, name: string, ready: boolean, isHost: boolean, inGame: boolean }>}
 */
const players = new Map()
/** @type {Map<string, { code: string, hostId: string, members: Set<string>, phase: 'lobby' | 'cd' | 'playing', endsAt: number | null, cdTmr: ReturnType<typeof setTimeout> | null }>} */
const rooms = new Map()

const roomChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const MAX_NAME_LEN = 20
/** @type {WeakMap<import('ws').WebSocket, boolean>} */
const wsAlive = new WeakMap()

function sanitizeName(raw) {
  if (raw == null) return ''
  const s = String(raw).replace(/\r|\n/g, ' ').trim()
  if (s.length > MAX_NAME_LEN) return s.slice(0, MAX_NAME_LEN)
  return s
}

/** Prefer `playerName` from the client (canonical); support legacy one-letter `n` etc. */
function nameFromClientPayload(d) {
  if (d == null || typeof d !== 'object') return ''
  return sanitizeName(d.playerName ?? d.n ?? d.name ?? d.displayName ?? d.label)
}

/** @returns {1 | 2 | 3} */
function vehicleFromClient(v) {
  const n = Number(v)
  if (n === 3) return 3
  if (n === 2) return 2
  return 1
}

/** Parse WebSocket payload (string, Buffer, Buffer[], ArrayBuffer, or TypedArray) as JSON object or null. */
function parseJsonMessage(raw) {
  try {
    let s
    if (Buffer.isBuffer(raw)) s = raw.toString('utf8')
    else if (Array.isArray(raw) && raw.every((x) => Buffer.isBuffer(x))) s = Buffer.concat(raw).toString('utf8')
    else if (raw instanceof ArrayBuffer) s = Buffer.from(raw).toString('utf8')
    else if (ArrayBuffer.isView(raw)) s = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
    else s = String(raw)
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** Message type: lowercase string (clients may send mixed case). */
function messageType(d) {
  if (d == null || typeof d !== 'object') return ''
  return String(d.t ?? d.type ?? '').toLowerCase()
}

/**
 * Persist display name for one player id (only that connection's row in `players`).
 * @returns {string|null} sanitized non-empty name, or null
 */
function persistPlayerName(playerId, payload) {
  const p = players.get(playerId)
  if (!p) return null
  const n = nameFromClientPayload(payload)
  if (!n) return null
  p.name = n
  return n
}

/** Roster display string for `playerId` from authoritative `players` map. */
function displayNameForPlayerId(playerId) {
  const p = players.get(playerId)
  if (!p) return 'Player'
  const n = sanitizeName(p.name)
  return n.length > 0 ? n : 'Player'
}

function newRoomCode() {
  for (let a = 0; a < 200; a++) {
    let s = ''
    for (let i = 0; i < 6; i++) s += roomChars[Math.floor(Math.random() * roomChars.length)]
    if (!rooms.has(s)) return s
  }
  return randomBytes(4).toString('hex').toUpperCase()
}

function getPlayerIdByWs(ws) {
  for (const [id, p] of players) {
    if (p.ws === ws) return id
  }
  return null
}

function send(ws, o) {
  if (ws.readyState === 1) ws.send(JSON.stringify(o))
}

function otherMemberIds(code, myId) {
  const r = rooms.get(code)
  if (!r) return []
  return [...r.members].filter((x) => x !== myId)
}

/**
 * Full room roster for lobby / `go`: one entry per `r.members` id, names from `players` only.
 * Sorted by player id so every client sees the same order.
 */
function buildRoomPl(r) {
  const pl = []
  for (const mid of r.members) {
    if (typeof mid !== 'string' || mid.length === 0) continue
    const mp = players.get(mid)
    if (!mp) continue
    const nm = displayNameForPlayerId(mid)
    pl.push({
      i: mid,
      v: mp.vehicle,
      playerName: nm,
      n: nm,
      name: nm,
      displayName: nm,
      label: nm,
      r: mp.ready ? 1 : 0,
      h: mid === r.hostId ? 1 : 0,
    })
  }
  pl.sort((a, b) => a.i.localeCompare(b.i))
  return pl
}

function broadcastRoomLobby(roomCode) {
  const r = rooms.get(roomCode)
  if (!r) return
  for (const pid of r.members) {
    const p = players.get(pid)
    if (!p || p.ws.readyState !== 1) continue
    const pl = buildRoomPl(r)
    send(p.ws, {
      t: 'lobby',
      code: r.code,
      ph: r.phase,
      end: r.endsAt,
      pl,
    })
  }
}

function cancelCountdown(room) {
  if (room.cdTmr) {
    clearTimeout(room.cdTmr)
    room.cdTmr = null
  }
  if (room.phase === 'cd') {
    room.phase = 'lobby'
    room.endsAt = null
  }
}

function everyoneReady(room) {
  if (room.members.size < 1) return false
  for (const pid of room.members) {
    const p = players.get(pid)
    if (!p || !p.ready) return false
  }
  return true
}

function startCountdown(room) {
  if (room.phase !== 'lobby') return
  if (!everyoneReady(room)) return
  room.phase = 'cd'
  room.endsAt = Date.now() + CD_MS
  const code = room.code
  if (room.cdTmr) clearTimeout(room.cdTmr)
  room.cdTmr = setTimeout(() => {
    const rr = rooms.get(code)
    if (!rr) return
    if (rr.phase !== 'cd' || !everyoneReady(rr)) {
      if (rr.phase === 'cd') cancelCountdown(rr)
      broadcastRoomLobby(code)
      return
    }
    startGame(code)
  }, CD_MS)
  broadcastRoomLobby(code)
}

function startGame(code) {
  const r = rooms.get(code)
  if (!r) return
  if (r.cdTmr) {
    clearTimeout(r.cdTmr)
    r.cdTmr = null
  }
  r.phase = 'playing'
  r.endsAt = null
  for (const pid of r.members) {
    const p = players.get(pid)
    if (p) p.inGame = true
  }
  const pl = buildRoomPl(r)
  for (const pid of r.members) {
    const p = players.get(pid)
    if (!p || p.ws.readyState !== 1) continue
    const peerIds = otherMemberIds(code, pid)
    send(p.ws, { t: 'go', pr: peerIds, pl })
  }
}

function leaveRoomPlayer(pid) {
  const p = players.get(pid)
  if (!p || !p.roomCode) {
    if (p) p.roomCode = null
    return
  }
  const code = p.roomCode
  p.roomCode = null
  p.ready = false
  const r = rooms.get(code)
  if (!r) return

  r.members.delete(pid)
  p.inGame = false
  p.isHost = false
  if (r.hostId === pid || r.members.size === 0) {
    if (r.cdTmr) {
      clearTimeout(r.cdTmr)
      r.cdTmr = null
    }
    for (const x of r.members) {
      const o = players.get(x)
      if (o) {
        o.roomCode = null
        o.ready = false
        o.inGame = false
        o.isHost = false
        if (o.ws.readyState === 1) {
          send(o.ws, { t: 'err', c: r.hostId === pid ? 'HOST_LEFT' : 'ROOM_CLOSED' })
        }
      }
    }
    rooms.delete(code)
    return
  }
  if (r.phase === 'playing') {
    for (const x of r.members) {
      const o = players.get(x)
      if (o && o.ws.readyState === 1) send(o.ws, { t: 'leave', id: pid })
    }
    return
  }
  if (r.phase === 'cd') {
    if (!everyoneReady(r)) cancelCountdown(r)
  }
  broadcastRoomLobby(code)
}

wss.on('connection', (ws) => {
  wsAlive.set(ws, true)
  ws.on('pong', () => {
    wsAlive.set(ws, true)
  })
  const id = randomBytes(4).toString('hex')
  players.set(id, { ws, roomCode: null, vehicle: 1, name: 'Player', ready: false, isHost: false, inGame: false })
  send(ws, { t: 'hello', id })

  ws.on('message', (raw) => {
    const d = parseJsonMessage(raw)
    if (d == null || typeof d !== 'object') return
    const from = getPlayerIdByWs(ws)
    if (from == null) return
    const me = players.get(from)
    if (!me) return

    const typ = messageType(d)

    if (typ === 'host') {
      const v = vehicleFromClient(d.v)
      const saved = persistPlayerName(from, d)
      if (!saved) {
        send(ws, { t: 'err', c: 'NAME' })
        return
      }
      if (me.roomCode) leaveRoomPlayer(from)
      me.vehicle = v
      me.ready = false
      me.isHost = true
      const code = newRoomCode()
      const r = { code, hostId: from, members: new Set([from]), phase: 'lobby', endsAt: null, cdTmr: null }
      rooms.set(code, r)
      me.roomCode = code
      broadcastRoomLobby(code)
      return
    }

    if (typ === 'setname' || typ === 'set_name') {
      if (!me.roomCode) return
      const r = rooms.get(me.roomCode)
      if (!r || r.phase !== 'lobby') return
      const saved = persistPlayerName(from, d)
      if (!saved) {
        send(ws, { t: 'err', c: 'NAME' })
        return
      }
      broadcastRoomLobby(me.roomCode)
      return
    }

    if (typ === 'setvehicle' || typ === 'set_vehicle') {
      const v = vehicleFromClient(d.v)
      if (!me.roomCode) return
      const r = rooms.get(me.roomCode)
      if (!r || r.phase !== 'lobby') return
      me.vehicle = v
      broadcastRoomLobby(me.roomCode)
      return
    }

    if (typ === 'join') {
      const rawC = String(d.c ?? d.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const v = vehicleFromClient(d.v)
      const saved = persistPlayerName(from, d)
      if (!saved) {
        send(ws, { t: 'err', c: 'NAME' })
        return
      }
      if (rawC.length < 4) {
        send(ws, { t: 'err', c: 'INVALID' })
        return
      }
      const r = rooms.get(rawC)
      if (!r) {
        send(ws, { t: 'err', c: 'NO_ROOM' })
        return
      }
      if (r.members.size >= MAX_PER_ROOM) {
        send(ws, { t: 'err', c: 'FULL' })
        return
      }
      if (r.phase !== 'lobby') {
        send(ws, { t: 'err', c: 'STARTED' })
        return
      }
      if (me.roomCode) leaveRoomPlayer(from)
      me.vehicle = v
      me.ready = false
      me.isHost = false
      r.members.add(from)
      me.roomCode = r.code
      broadcastRoomLobby(r.code)
      return
    }

    if (typ === 'ready') {
      if (!me.roomCode) return
      const r = rooms.get(me.roomCode)
      if (!r) return
      if (r.phase === 'playing') return
      me.ready = d.r === true
      if (r.phase === 'cd' && !me.ready) {
        cancelCountdown(r)
        broadcastRoomLobby(me.roomCode)
        return
      }
      if (r.phase === 'lobby' && everyoneReady(r)) {
        startCountdown(r)
      } else {
        broadcastRoomLobby(me.roomCode)
      }
      return
    }

    if (typ === 'leaveroom' || typ === 'leave_room') {
      if (me.roomCode) leaveRoomPlayer(from)
      return
    }

    if (typ === 'state') {
      if (!me.roomCode || me.inGame !== true) return
      const r = rooms.get(me.roomCode)
      if (!r || r.phase !== 'playing') return
      const out = { t: 'st', i: from, p: d.p, q: d.q, v: d.v, veh: d.veh }
      const s = JSON.stringify(out)
      for (const pid of r.members) {
        if (pid === from) continue
        const o = players.get(pid)
        if (o && o.inGame && o.ws.readyState === 1) o.ws.send(s)
      }
      return
    }
  })

  ws.on('close', () => {
    wsAlive.delete(ws)
    const p = players.get(id)
    if (p && p.roomCode) {
      leaveRoomPlayer(id)
    }
    players.delete(id)
  })
})

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue
    const alive = wsAlive.get(ws) ?? false
    if (!alive) {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      continue
    }
    wsAlive.set(ws, false)
    try {
      ws.ping()
    } catch {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
  }
}, HEARTBEAT_MS)
heartbeatTimer.unref?.()

wss.on('listening', () => {
  // eslint-disable-next-line no-console
  console.log(`[car-physics] game server ws://0.0.0.0:${port} (max ${MAX_PER_ROOM} / room, ${CD_MS / 1000}s start delay)`)
})
