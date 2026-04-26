import './style.css'
import * as THREE from 'three'
import { CarConfig } from './CarConfig.ts'
import { CarPhysicsApp } from './CarPhysicsApp.ts'
import { WebGameAudio } from './WebGameAudio.ts'
import { MultiplayerClient, type LobbyPlayer } from './MultiplayerClient.ts'
import { InGameChat } from './InGameChat.ts'

const START_VEHICLE_LS_KEY = 'car-physics-start-vehicle-v1'

function vehicleDisplayName(v: 1 | 2 | 3 | 4 | 5): string {
  if (v === 1) return 'Trail Ranger'
  if (v === 2) return 'Dune Titan'
  if (v === 5) return 'Raptor V'
  if (v === 4) return 'Storm Reaper'
  return 'Wasteland Mk III'
}

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')
if (!canvas) {
  throw new Error('Missing #canvas')
}
document.body.classList.remove('game-running')

const installInteractionLocks = (): void => {
  const prevent = (ev: Event): void => {
    ev.preventDefault()
  }
  window.addEventListener('contextmenu', prevent, { capture: true })
  window.addEventListener('selectstart', prevent, { capture: true })
  window.addEventListener('dragstart', prevent, { capture: true })
  window.addEventListener('gesturestart', prevent as EventListener, { capture: true })
  window.addEventListener('gesturechange', prevent as EventListener, { capture: true })
  window.addEventListener('gestureend', prevent as EventListener, { capture: true })
  document.addEventListener(
    'touchmove',
    (ev) => {
      if (ev.cancelable) ev.preventDefault()
    },
    { passive: false, capture: true },
  )
}
installInteractionLocks()

function showStartPanel(
  which: 'root' | 'single' | 'options' | 'mp-menu' | 'join' | 'lobby',
): void {
  const map: Record<typeof which, string> = {
    root: 'start-panel-root',
    single: 'start-panel-single',
    options: 'start-panel-options',
    'mp-menu': 'start-panel-mp-menu',
    join: 'start-panel-join',
    lobby: 'start-panel-lobby',
  }
  for (const id of Object.values(map)) {
    const el = document.getElementById(id)
    if (el) el.hidden = true
  }
  const active = document.getElementById(map[which])
  if (active) active.hidden = false
  document.body.classList.toggle('mp-lobby', which === 'lobby')
  const chatRoot = document.getElementById('chat-root')
  if (chatRoot) chatRoot.hidden = which !== 'lobby'
}

type StartMode = 'solo' | 'mp'

function errText(code: string): string {
  switch (code) {
    case 'INVALID':
      return 'That room id is not valid. Check the code and try again.'
    case 'NO_ROOM':
      return 'No room exists with that id. Ask the host for the id or make sure the server is running.'
    case 'FULL':
      return 'That room is full (max 4 players).'
    case 'STARTED':
      return 'This match already started (or the countdown is running) — joining is closed.'
    case 'HOST_LEFT':
      return 'The host left the room.'
    case 'ROOM_CLOSED':
      return 'The room was closed.'
    case 'NAME':
      return 'Enter a display name (at least one character, max 20).'
    default:
      return `Something went wrong (${code}). Please try again.`
  }
}

/** Single player / multiplayer entry, or MP lobby until `go`. */
async function waitForAppStart(): Promise<StartMode> {
  const readStoredVehicle = (): 1 | 2 | 3 | 4 | 5 => {
    return CarConfig.normalizeVehicleWire(localStorage.getItem(START_VEHICLE_LS_KEY))
  }

  let vSingle: 1 | 2 | 3 | 4 | 5 = readStoredVehicle()
  /** Chosen in the multiplayer lobby; also used for the initial host/join request. */
  let vLobby: 1 | 2 | 3 | 4 | 5 = readStoredVehicle()
  CarConfig.setActiveVehicleChoice(vSingle)

  if (CarConfig.SCENE_MODE !== 'driving') {
    const el = document.getElementById('start-overlay')
    el?.classList.add('start-overlay--hidden')
    el?.setAttribute('aria-hidden', 'true')
    return 'solo'
  }

  let optionsFrom: 'root' | 'single' = 'root'
  let mpClient: MultiplayerClient | null = null
  let lobbyRaf = 0
  let lastLobby: { code: string; ph: string; end: number | null; pl: LobbyPlayer[] } | null = null

  const root = document.getElementById('start-panel-root')
  const panelSingle = document.getElementById('start-panel-single')
  const panelOptions = document.getElementById('start-panel-options')
  const panelMpMenu = document.getElementById('start-panel-mp-menu')
  const panelJoin = document.getElementById('start-panel-join')
  const panelLobby = document.getElementById('start-panel-lobby')
  const mpFlowLoading = document.getElementById('mp-flow-loading')
  const mpFlowLoadingTitle = document.getElementById('mp-flow-loading-title')
  const nameModal = document.getElementById('mp-name-modal')
  const nameModalHint = document.getElementById('mp-name-modal-hint')
  const nameInput = document.getElementById('mp-name-input') as HTMLInputElement | null
  const nameModalErr = document.getElementById('mp-name-modal-err') as HTMLElement | null
  const nameConfirm = document.getElementById('mp-name-confirm') as HTMLButtonElement | null
  const nameCancel = document.getElementById('mp-name-cancel') as HTMLButtonElement | null
  const startSingleplayer = document.getElementById('start-singleplayer') as HTMLButtonElement | null
  const startModeMp = document.getElementById('start-mode-mp') as HTMLButtonElement | null
  const startOptionsRoot = document.getElementById('start-options-root') as HTMLButtonElement | null
  const startQuit = document.getElementById('start-quit') as HTMLButtonElement | null
  const startSinglePlay = document.getElementById('start-single-play') as HTMLButtonElement | null
  const startSingleOptions = document.getElementById('start-single-options') as HTMLButtonElement | null
  const startSingleBack = document.getElementById('start-single-back') as HTMLButtonElement | null
  const vehiclePrev = document.getElementById('start-vehicle-prev') as HTMLButtonElement | null
  const vehicleNext = document.getElementById('start-vehicle-next') as HTMLButtonElement | null
  const vehicleTrack = document.getElementById('start-vehicle-track') as HTMLElement | null
  const soundToggle = document.getElementById('start-sound-toggle') as HTMLButtonElement | null
  const optionsBack = document.getElementById('start-options-back') as HTMLButtonElement | null
  const mpMenuHost = document.getElementById('mp-menu-host') as HTMLButtonElement | null
  const mpMenuJoin = document.getElementById('mp-menu-join') as HTMLButtonElement | null
  const mpMenuBack = document.getElementById('mp-menu-back') as HTMLButtonElement | null
  const mpMenuErr = document.getElementById('mp-menu-err') as HTMLElement | null
  const joinCode = document.getElementById('join-room-code') as HTMLInputElement | null
  const joinSubmit = document.getElementById('join-submit') as HTMLButtonElement | null
  const joinBack = document.getElementById('join-back') as HTMLButtonElement | null
  const joinErr = document.getElementById('join-err') as HTMLElement | null
  const lobbyCode = document.getElementById('lobby-code') as HTMLElement | null
  const lobbyCopy = document.getElementById('lobby-copy') as HTMLButtonElement | null
  const lobbyList = document.getElementById('lobby-list') as HTMLUListElement | null
  const lobbyCountdown = document.getElementById('lobby-countdown') as HTMLElement | null
  const lobbyStatus = document.getElementById('lobby-status') as HTMLElement | null
  const lobbyReady = document.getElementById('lobby-ready') as HTMLButtonElement | null
  const lobbyLeave = document.getElementById('lobby-leave') as HTMLButtonElement | null
  const lobbyPrev = document.getElementById('lobby-vehicle-prev') as HTMLButtonElement | null
  const lobbyNext = document.getElementById('lobby-vehicle-next') as HTMLButtonElement | null
  const lobbyTrack = document.getElementById('lobby-vehicle-track') as HTMLElement | null
  const chatRoot = document.getElementById('chat-root') as HTMLElement | null
  const chatLog = document.getElementById('chat-log') as HTMLElement | null
  const chatComposer = document.getElementById('chat-composer') as HTMLElement | null
  const chatInput = document.getElementById('chat-input') as HTMLInputElement | null
  const chatBtn = document.getElementById('chat-mobile-btn') as HTMLButtonElement | null
  const chatDot = document.getElementById('chat-notify-dot') as HTMLElement | null

  if (
    !root ||
    !panelSingle ||
    !panelOptions ||
    !panelMpMenu ||
    !panelJoin ||
    !panelLobby ||
    !mpFlowLoading ||
    !mpFlowLoadingTitle ||
    !startSingleplayer ||
    !startModeMp ||
    !startOptionsRoot ||
    !startQuit ||
    !startSinglePlay ||
    !startSingleOptions ||
    !startSingleBack ||
    !vehiclePrev ||
    !vehicleNext ||
    !vehicleTrack ||
    !soundToggle ||
    !optionsBack ||
    !mpMenuHost ||
    !mpMenuJoin ||
    !mpMenuBack ||
    !mpMenuErr ||
    !joinCode ||
    !joinSubmit ||
    !joinBack ||
    !joinErr ||
    !lobbyCode ||
    !lobbyCopy ||
    !lobbyList ||
    !lobbyCountdown ||
    !lobbyStatus ||
    !lobbyReady ||
    !lobbyLeave ||
    !lobbyPrev ||
    !lobbyNext ||
    !lobbyTrack ||
    !chatRoot ||
    !chatLog ||
    !chatComposer ||
    !chatInput ||
    !chatBtn ||
    !chatDot ||
    !nameModal ||
    !nameModalHint ||
    !nameInput ||
    !nameModalErr ||
    !nameConfirm ||
    !nameCancel
  ) {
    return 'solo'
  }

  const soundText = soundToggle.querySelector('.pause-switch-text')
  if (!soundText) {
    return 'solo'
  }

  const syncSingleTrack = (): void => {
    const frac = ((vSingle - 1) / 5) * 100
    vehicleTrack.style.transform = `translateX(-${frac}%)`
  }
  const syncLobbyTrack = (): void => {
    const frac = ((vLobby - 1) / 5) * 100
    lobbyTrack.style.transform = `translateX(-${frac}%)`
  }
  const syncSoundToggle = (): void => {
    const soundOn = !WebGameAudio.getStoredMuted()
    soundToggle.setAttribute('aria-pressed', soundOn ? 'true' : 'false')
    soundText.textContent = soundOn ? 'ON' : 'OFF'
  }
  syncSingleTrack()
  syncLobbyTrack()
  syncSoundToggle()

  const lobbyChat = new InGameChat({
    root: chatRoot,
    logEl: chatLog,
    composerEl: chatComposer,
    inputEl: chatInput,
    mobileBtn: chatBtn,
    notifyDotEl: chatDot,
    localName: CarConfig.getSessionMultiplayerDisplayName() || 'You',
    sendFn: (text: string) => {
      if (!mpClient?.connected) return false
      return mpClient.sendChat(text)
    },
  })
  lobbyChat.setEnabled(false)

  const clearLobbyRaf = (): void => {
    if (lobbyRaf) {
      cancelAnimationFrame(lobbyRaf)
      lobbyRaf = 0
    }
  }

  const renderLobby = (): void => {
    if (lastLobby == null) return
    if (lobbyCode) lobbyCode.textContent = lastLobby.code
    const lid = mpClient?.localId ?? null
    const self = lid != null ? lastLobby.pl.find((p) => p.i === lid) : undefined
    if (self) {
      vLobby = self.v
      localStorage.setItem(START_VEHICLE_LS_KEY, String(vLobby))
      CarConfig.setActiveVehicleChoice(vLobby)
      syncLobbyTrack()
    }
    if (lobbyList) {
      lobbyList.textContent = ''
      for (const p of lastLobby.pl) {
        const li = document.createElement('li')
        const isHost = p.h === 1
        const vLabel = vehicleDisplayName(p.v)
        const who = String(p.n ?? '')
          .trim()
          .slice(0, 20) || 'Player'
        li.textContent = `${who} · ${vLabel} · ${isHost ? 'host · ' : ''}${p.r === 1 ? 'ready' : 'not ready'}`
        lobbyList.appendChild(li)
      }
    }
    if (lobbyCountdown) {
      if (lastLobby.ph === 'cd' && lastLobby.end != null) {
        lobbyCountdown.hidden = false
        clearLobbyRaf()
        const endT = lastLobby.end
        const upd = (): void => {
          if (lastLobby?.ph !== 'cd' || lastLobby.end == null) {
            clearLobbyRaf()
            if (lobbyCountdown) lobbyCountdown.hidden = true
            return
          }
          const sec = Math.max(0, Math.ceil((endT - Date.now()) / 1000))
          lobbyCountdown.textContent = `Starting in ${sec}s…`
          if (sec <= 0) {
            clearLobbyRaf()
            return
          }
          lobbyRaf = requestAnimationFrame(upd)
        }
        lobbyRaf = requestAnimationFrame(upd)
      } else {
        clearLobbyRaf()
        lobbyCountdown.hidden = true
      }
    }
    if (lobbyReady) {
      if (self) {
        lobbyReady.textContent = self.r === 1 ? 'Unready' : 'Ready'
      } else {
        lobbyReady.textContent = 'Ready'
      }
    }
    if (lobbyStatus) {
      let s = ''
      if (lastLobby.ph === 'cd') s = 'Get ready — match starting soon.'
      else if (lastLobby.pl.length >= 1) s = 'All players must ready, then 10s countdown starts.'
      lobbyStatus.textContent = s
    }
    if (lobbyPrev && lobbyNext) {
      const canPickV = lastLobby.ph === 'lobby'
      lobbyPrev.disabled = !canPickV
      lobbyNext.disabled = !canPickV
    }
  }

  return new Promise<StartMode>((resolve) => {
    let appStarted = false
    let activeWs = ''
    let lastRoomCode = ''
    let lastWasHost = false
    let lastDisplayName = ''
    let mpFlowContext: 'host' | 'join' | null = null
    let roomOpTimeout: ReturnType<typeof setTimeout> | null = null
    const clearRoomOpTimeout = (): void => {
      if (roomOpTimeout == null) return
      clearTimeout(roomOpTimeout)
      roomOpTimeout = null
    }
    const showMpFlowLoading = (title: string, ctx: 'host' | 'join'): void => {
      mpFlowContext = ctx
      mpFlowLoadingTitle.textContent = title
      mpFlowLoading.removeAttribute('hidden')
      mpFlowLoading.style.removeProperty('display')
    }
    const hideMpFlowLoading = (): void => {
      mpFlowContext = null
      mpFlowLoading.setAttribute('hidden', '')
      mpFlowLoading.style.setProperty('display', 'none')
    }
    const lockAll = (): void => {
      startSingleplayer.disabled = true
      startModeMp.disabled = true
      startOptionsRoot.disabled = true
      startQuit.disabled = true
      startSinglePlay.disabled = true
      startSingleOptions.disabled = true
      startSingleBack.disabled = true
      vehiclePrev.disabled = true
      vehicleNext.disabled = true
      mpMenuHost.disabled = true
      mpMenuJoin.disabled = true
      mpMenuBack.disabled = true
      joinSubmit.disabled = true
      joinBack.disabled = true
      lobbyPrev.disabled = true
      lobbyNext.disabled = true
      lobbyReady.disabled = true
      lobbyLeave.disabled = true
      nameInput.disabled = true
      nameConfirm.disabled = true
      nameCancel.disabled = true
    }

    const startOverlayForName = document.getElementById('start-overlay')

    const showMpNameModal = (hint: string): Promise<string | null> =>
      new Promise((resolve) => {
        nameModalHint.textContent = hint
        nameModalErr.textContent = ''
        nameModalErr.hidden = true
        nameInput.value = CarConfig.getSessionMultiplayerDisplayName()
        nameInput.disabled = false
        nameConfirm.disabled = false
        nameCancel.disabled = false
        startOverlayForName?.classList.add('start-overlay--name-modal-open')
        if (nameModal.parentElement !== document.body) {
          document.body.appendChild(nameModal)
        }
        nameModal.classList.add('mp-name-modal--top-layer')
        nameModal.removeAttribute('hidden')

        const captureClick = true
        const cleanup = (): void => {
          nameConfirm.removeEventListener('click', onConfirm, captureClick)
          nameCancel.removeEventListener('click', onCancel, captureClick)
          nameInput.removeEventListener('keydown', onKey)
        }
        const finish = (v: string | null): void => {
          nameModal.setAttribute('hidden', '')
          nameModal.classList.remove('mp-name-modal--top-layer')
          if (startOverlayForName && nameModal.parentElement === document.body) {
            startOverlayForName.insertBefore(nameModal, startOverlayForName.firstChild)
          }
          startOverlayForName?.classList.remove('start-overlay--name-modal-open')
          cleanup()
          resolve(v)
        }
        const onConfirm = (): void => {
          const t = nameInput.value.replace(/[\r\n]/g, ' ').trim().slice(0, 20)
          if (t.length < 1) {
            nameModalErr.textContent = 'Please enter a name to continue.'
            nameModalErr.hidden = false
            return
          }
          CarConfig.setSessionMultiplayerDisplayName(t)
          finish(t)
        }
        const onCancel = (): void => {
          finish(null)
        }
        const onKey = (e: KeyboardEvent): void => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onConfirm()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }
        nameConfirm.addEventListener('click', onConfirm, captureClick)
        nameCancel.addEventListener('click', onCancel, captureClick)
        nameInput.addEventListener('keydown', onKey)
        void nameInput.focus()
      })

    const finishSolo = (): void => {
      if (appStarted) return
      appStarted = true
      lobbyChat.setEnabled(false)
      lobbyChat.dispose()
      clearLobbyRaf()
      CarConfig.setMultiplayerSession(null)
      lockAll()
      resolve('solo')
    }

    const finishMp = (): void => {
      if (appStarted) return
      appStarted = true
      lobbyChat.setEnabled(false)
      lobbyChat.dispose()
      clearLobbyRaf()
      lockAll()
      resolve('mp')
    }

    const applySessionNameToLocalRow = (c: MultiplayerClient, pl: LobbyPlayer[]): LobbyPlayer[] => {
      const lid = c.localId
      if (lid == null) return pl
      const mine = CarConfig.getSessionMultiplayerDisplayName()
      if (mine === '') return pl
      return pl.map((p) => (p.i === lid ? { ...p, n: mine } : p))
    }

    const resetMp = (): void => {
      lobbyChat.setEnabled(false)
      lobbyChat.clearHistory()
      clearLobbyRaf()
      clearRoomOpTimeout()
      lastLobby = null
      // Do not clear `setSessionMultiplayerDisplayName` here: `ensureMp()` always calls
      // `resetMp()` before connect, and that would wipe the name set in the modal
      // before `createRoom` / lobby / `applySessionNameToLocalRow` (everything showed "Player").
      activeWs = ''
      if (mpClient) {
        try {
          mpClient.leaveRoom()
        } catch {
          /* ignore */
        }
        mpClient.disconnect()
        mpClient = null
      }
    }

    const tryQuickRejoin = async (reason: string): Promise<boolean> => {
      if (appStarted) return false
      const code = String(lastRoomCode).trim().toUpperCase()
      const name = CarConfig.getSessionMultiplayerDisplayName().trim() || lastDisplayName.trim()
      if (lastWasHost || code.length < 4 || name.length < 1) return false
      showMpFlowLoading('Reconnecting to room…', 'join')
      clearRoomOpTimeout()
      const c = await ensureMp()
      if (!c) {
        hideMpFlowLoading()
        return false
      }
      CarConfig.setSessionMultiplayerDisplayName(name)
      if (!c.joinRoom(code, vLobby, name)) {
        hideMpFlowLoading()
        return false
      }
      roomOpTimeout = window.setTimeout(() => {
        roomOpTimeout = null
        if (lastLobby != null) return
        hideMpFlowLoading()
        showStartPanel('mp-menu')
        mpMenuErr.textContent = `${reason} Quick rejoin timed out.`
      }, 12_000)
      return true
    }

    const attachMultiplayerClientHandlers = (c: MultiplayerClient): void => {
      c.onLobby = (m) => {
        clearRoomOpTimeout()
        try {
          if (lastRoomCode !== '' && lastRoomCode !== m.code) {
            lobbyChat.clearHistory()
          }
          const pl = applySessionNameToLocalRow(c, m.pl)
          lastLobby = { code: m.code, ph: m.ph, end: m.end, pl }
          lastRoomCode = m.code
          joinErr.textContent = ''
          mpMenuErr.textContent = ''
          showStartPanel('lobby')
          lobbyChat.setEnabled(true)
          renderLobby()
        } finally {
          hideMpFlowLoading()
        }
      }
      c.onServerError = (code) => {
        clearRoomOpTimeout()
        if (code === 'HOST_LEFT' || code === 'ROOM_CLOSED') {
          if (lobbyStatus) lobbyStatus.textContent = errText(code)
          if (appStarted) {
            CarConfig.notifyMultiplayerRoomEndedInGame()
          }
          if (!appStarted) {
            const reason =
              code === 'HOST_LEFT'
                ? 'Host left or server restarted.'
                : 'Room closed by server.'
            void (async () => {
              const ok = await tryQuickRejoin(reason)
              if (ok) return
              resetMp()
              showStartPanel('mp-menu')
              mpMenuErr.textContent = `${reason} ${lastWasHost ? 'Host again to continue.' : 'Ask host for a new code.'}`
            })()
            return
          }
          resetMp()
          showStartPanel('mp-menu')
          return
        }
        if (appStarted) return
        const t = errText(code)
        const flow = mpFlowContext
        hideMpFlowLoading()
        if (flow === 'host') {
          mpMenuErr.textContent = t
          showStartPanel('mp-menu')
        } else if (flow === 'join') {
          joinErr.textContent = t
          showStartPanel('join')
        } else {
          if (code === 'NO_ROOM' || code === 'FULL' || code === 'STARTED' || code === 'INVALID' || code === 'NAME') {
            joinErr.textContent = t
            showStartPanel('join')
          } else {
            joinErr.textContent = t
            mpMenuErr.textContent = t
            showStartPanel('mp-menu')
          }
        }
      }
      c.onConnectionLost = (info) => {
        if (appStarted) return
        clearRoomOpTimeout()
        void (async () => {
          const ok = await tryQuickRejoin('Connection lost.')
          if (ok) return
          hideMpFlowLoading()
          resetMp()
          if (lobbyStatus) lobbyStatus.textContent = 'Connection lost — try again.'
          showStartPanel('mp-menu')
          mpMenuErr.textContent =
            `Disconnected from server (close ${info.code}${info.clean ? ', clean' : ''}). ` +
            'If this happens repeatedly, the host may have left or the server may have restarted.'
        })()
      }
      c.onChat = (fromId, fromName, message) => {
        if (appStarted) return
        if (fromId === c.localId) return
        lobbyChat.addRemoteMessage(fromName, message)
      }
      c.onGameStart = (pr, plFromGo) => {
        if (appStarted) return
        clearRoomOpTimeout()
        CarConfig.setMultiplayerRaceStartPerf(performance.now() + CarConfig.MP_RACE_COUNTDOWN_MS)
        CarConfig.setPreconnectedMultiplayerClient(c)
        const plRaw =
          plFromGo.length > 0
            ? plFromGo
            : lastLobby != null
              ? lastLobby.pl
              : []
        const pl = applySessionNameToLocalRow(c, plRaw)
        if (c.localId) {
          CarConfig.setGameStartMultiplayerSnapshot({
            localId: c.localId,
            peerOrder: pr,
            pl,
          })
        } else {
          CarConfig.setGameStartMultiplayerSnapshot({ localId: '', peerOrder: pr, pl: [] })
        }
        CarConfig.setGameStartPeerIds(pr)
        finishMp()
      }
    }

    const ensureMp = async (): Promise<MultiplayerClient | null> => {
      mpMenuErr.textContent = ''
      const u = CarConfig.getDefaultMultiplayerWsUrl()
      if (mpClient?.connected && u === activeWs) {
        attachMultiplayerClientHandlers(mpClient)
        return mpClient
      }
      resetMp()
      const c = new MultiplayerClient()
      attachMultiplayerClientHandlers(c)
      try {
        await c.connect(u)
        mpClient = c
        activeWs = u
        return c
      } catch (e) {
        mpMenuErr.textContent = e instanceof Error ? e.message : 'Could not connect.'
        return null
      }
    }

    startSingleplayer.addEventListener('click', () => {
      showStartPanel('single')
    })
    startModeMp.addEventListener('click', () => {
      showStartPanel('mp-menu')
    })
    startOptionsRoot.addEventListener('click', () => {
      optionsFrom = 'root'
      showStartPanel('options')
      syncSingleTrack()
      syncSoundToggle()
    })
    startSinglePlay.addEventListener('click', () => {
      CarConfig.setActiveVehicleChoice(vSingle)
      localStorage.setItem(START_VEHICLE_LS_KEY, String(vSingle))
      finishSolo()
    }, { once: true })
    startSingleOptions.addEventListener('click', () => {
      optionsFrom = 'single'
      showStartPanel('options')
      syncSingleTrack()
      syncSoundToggle()
    })
    startSingleBack.addEventListener('click', () => {
      showStartPanel('root')
    })
    optionsBack.addEventListener('click', () => {
      showStartPanel(optionsFrom)
    })
    const cycleV = (which: 'single' | 'lobby', dir: 'next' | 'prev'): void => {
      const step = dir === 'next' ? 1 : -1
      if (which === 'single') {
        let n = vSingle + step
        if (n > 5) n = 1
        if (n < 1) n = 5
        vSingle = n as 1 | 2 | 3 | 4 | 5
        localStorage.setItem(START_VEHICLE_LS_KEY, String(vSingle))
        CarConfig.setActiveVehicleChoice(vSingle)
        syncSingleTrack()
        return
      }
      let n = vLobby + step
      if (n > 5) n = 1
      if (n < 1) n = 5
      vLobby = n as 1 | 2 | 3 | 4 | 5
      localStorage.setItem(START_VEHICLE_LS_KEY, String(vLobby))
      CarConfig.setActiveVehicleChoice(vLobby)
      syncLobbyTrack()
      mpClient?.setLobbyVehicle(vLobby)
    }
    vehicleNext.addEventListener('click', () => {
      cycleV('single', 'next')
    })
    vehiclePrev.addEventListener('click', () => {
      cycleV('single', 'prev')
    })
    lobbyNext.addEventListener('click', () => {
      cycleV('lobby', 'next')
    })
    lobbyPrev.addEventListener('click', () => {
      cycleV('lobby', 'prev')
    })
    soundToggle.addEventListener('click', () => {
      WebGameAudio.setStoredMuted(!WebGameAudio.getStoredMuted())
      syncSoundToggle()
    })
    startQuit.addEventListener('click', () => {
      window.close()
      window.location.href = 'about:blank'
    })
    mpMenuBack.addEventListener('click', () => {
      hideMpFlowLoading()
      resetMp()
      showStartPanel('root')
    })
    mpMenuHost.addEventListener('click', () => {
      void (async () => {
        joinErr.textContent = ''
        mpMenuErr.textContent = ''
        const displayName = await showMpNameModal("You'll host the room. Enter the name others see above your car.")
        if (displayName == null) return
        lastDisplayName = displayName
        lastWasHost = true
        lastRoomCode = ''
        showMpFlowLoading('Creating room…', 'host')
        clearRoomOpTimeout()
        vLobby = readStoredVehicle()
        const c = await ensureMp()
        if (!c) {
          hideMpFlowLoading()
          return
        }
        CarConfig.setSessionMultiplayerDisplayName(displayName)
        CarConfig.setActiveVehicleChoice(vLobby)
        localStorage.setItem(START_VEHICLE_LS_KEY, String(vLobby))
        if (!c.createRoom(vLobby, displayName)) {
          hideMpFlowLoading()
          mpMenuErr.textContent = 'Not connected. Try again.'
          showStartPanel('mp-menu')
          return
        }
        roomOpTimeout = window.setTimeout(() => {
          roomOpTimeout = null
          if (lastLobby != null) return
          hideMpFlowLoading()
          mpMenuErr.textContent =
            'No lobby response. Run `npm run mp-server` (default port 8000) and `npm run dev` together. In dev the client uses the Vite WebSocket proxy `/_mp`; for production or `preview` use port 8000 on the game host or set VITE_MP_URL.'
          showStartPanel('mp-menu')
        }, 20_000)
      })()
    })
    mpMenuJoin.addEventListener('click', () => {
      void (async () => {
        showMpFlowLoading('Connecting to server…', 'join')
        joinErr.textContent = ''
        mpMenuErr.textContent = ''
        const c = await ensureMp()
        if (!c) {
          hideMpFlowLoading()
          return
        }
        hideMpFlowLoading()
        showStartPanel('join')
      })()
    })
    joinCode.addEventListener('input', () => {
      const clean = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
      if (joinCode.value !== clean) joinCode.value = clean
    })
    joinSubmit.addEventListener('click', () => {
      if (!mpClient) {
        joinErr.textContent = 'Not connected. Open Multiplayer and try again.'
        return
      }
      void (async () => {
        const cj = mpClient
        if (!cj) {
          joinErr.textContent = 'Not connected. Open Multiplayer and try again.'
          return
        }
        joinErr.textContent = ''
        mpMenuErr.textContent = ''
        const raw = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
        if (raw.length < 4) {
          joinErr.textContent = 'Enter a valid room id (4 or more characters).'
          return
        }
        const displayName = await showMpNameModal('Enter the name others see above your car in-game.')
        if (displayName == null) return
        lastDisplayName = displayName
        lastWasHost = false
        lastRoomCode = raw
        showMpFlowLoading('Joining room…', 'join')
        clearRoomOpTimeout()
        CarConfig.setActiveVehicleChoice(vLobby)
        localStorage.setItem(START_VEHICLE_LS_KEY, String(vLobby))
        if (!cj.joinRoom(raw, vLobby, displayName)) {
          hideMpFlowLoading()
          joinErr.textContent = 'Not connected. Try again.'
          return
        }
        roomOpTimeout = window.setTimeout(() => {
          roomOpTimeout = null
          if (lastLobby != null) return
          hideMpFlowLoading()
          joinErr.textContent = 'No response from server when joining. Is the game server running?'
          showStartPanel('join')
        }, 20_000)
      })()
    })
    joinBack.addEventListener('click', () => {
      hideMpFlowLoading()
      showStartPanel('mp-menu')
    })
    lobbyCopy.addEventListener('click', () => {
      if (!lastLobby?.code) return
      void navigator.clipboard.writeText(lastLobby.code)
      if (lobbyStatus) lobbyStatus.textContent = 'Room id copied.'
    })
    lobbyReady.addEventListener('click', () => {
      const c = mpClient
      if (!c?.localId || !lastLobby) return
      const me = lastLobby.pl.find((p) => p.i === c.localId)
      const r = me?.r === 1
      c.setReady(!r)
    })
    lobbyLeave.addEventListener('click', () => {
      hideMpFlowLoading()
      resetMp()
      showStartPanel('mp-menu')
    })
  })
}

const mode = await waitForAppStart()
CarConfig.setSessionMultiplayer(mode === 'mp')
document.body.classList.remove('mp-lobby')

const startOverlay = document.getElementById('start-overlay')
startOverlay?.classList.add('start-overlay--hidden')
startOverlay?.setAttribute('aria-hidden', 'true')

const loadingOverlay = document.getElementById('loading-overlay')
const loadingBarFill = document.getElementById('loading-bar-fill')
const loadingProgressText = document.getElementById('loading-progress-text')
const hudWrap = document.getElementById('hud-wrap')
if (loadingOverlay) loadingOverlay.hidden = false

let loadingVisual = 0
const setLoadingProgressRatio = (ratio: number): void => {
  loadingVisual = Math.max(loadingVisual, THREE.MathUtils.clamp(ratio, 0, 1))
  const pct = Math.round(loadingVisual * 100)
  if (loadingBarFill) loadingBarFill.style.width = `${pct}%`
  if (loadingProgressText) loadingProgressText.textContent = `${pct}%`
}

let managerLoaded = 0
let managerTotal = 1
const syncCombinedLoadingFromManager = (loaded: number, total: number): void => {
  managerLoaded = Math.max(managerLoaded, loaded)
  managerTotal = Math.max(managerTotal, total, 1)
  const assetPhase = managerLoaded / managerTotal
  setLoadingProgressRatio(assetPhase * 0.92)
}

setLoadingProgressRatio(0)
THREE.DefaultLoadingManager.onStart = (_url, loaded, total) => syncCombinedLoadingFromManager(loaded, total)
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => syncCombinedLoadingFromManager(loaded, total)
THREE.DefaultLoadingManager.onLoad = () => setLoadingProgressRatio(0.92)
THREE.DefaultLoadingManager.onError = () => {
  if (loadingProgressText) loadingProgressText.textContent = 'Loading issue...'
}

if (mode === 'solo') {
  CarConfig.setPreconnectedMultiplayerClient(null)
  CarConfig.setGameStartPeerIds([])
  CarConfig.setMultiplayerSession(null)
}

const app = new CarPhysicsApp(canvas)
await app.init()

setLoadingProgressRatio(1)
if (loadingOverlay) loadingOverlay.hidden = true
if (CarConfig.SCENE_MODE === 'driving' && hudWrap) hudWrap.classList.remove('hud-off')
app.start()
document.body.classList.add('game-running')
if (CarConfig.SCENE_MODE === 'driving') {
  canvas.style.pointerEvents = 'auto'
}
