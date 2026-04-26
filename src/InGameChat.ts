type ChatSendFn = (text: string) => boolean

type ChatRow = { from: string; text: string; self: boolean; ts: number }

const MAX_CHAT_LEN = 140
const MAX_CHAT_ROWS = 120

export class InGameChat {
  private readonly root: HTMLElement
  private readonly logEl: HTMLElement
  private readonly composerEl: HTMLElement
  private readonly inputEl: HTMLInputElement
  private readonly mobileBtn: HTMLButtonElement
  private readonly notifyDotEl: HTMLElement
  private readonly sendFn: ChatSendFn
  private enabled = false
  private open = false
  private rows: ChatRow[] = []
  private readonly localName: string
  private unreadCount = 0

  constructor(opts: {
    root: HTMLElement
    logEl: HTMLElement
    composerEl: HTMLElement
    inputEl: HTMLInputElement
    mobileBtn: HTMLButtonElement
    notifyDotEl: HTMLElement
    localName: string
    sendFn: ChatSendFn
  }) {
    this.root = opts.root
    this.logEl = opts.logEl
    this.composerEl = opts.composerEl
    this.inputEl = opts.inputEl
    this.mobileBtn = opts.mobileBtn
    this.notifyDotEl = opts.notifyDotEl
    this.localName = (opts.localName || 'You').trim().slice(0, 20) || 'You'
    this.sendFn = opts.sendFn
    this.root.classList.remove('chat-root--open')
    this.logEl.hidden = true
    this.composerEl.hidden = true
    this.mobileBtn.addEventListener('click', () => this.toggleComposer())
    this.inputEl.addEventListener('keydown', this.onInputKeyDown, true)
    document.addEventListener('keydown', this.onGlobalKeyDown, true)
    this.inputEl.addEventListener('input', () => {
      const t = this.inputEl.value.replace(/[\r\n]/g, ' ').slice(0, MAX_CHAT_LEN)
      if (t !== this.inputEl.value) this.inputEl.value = t
    })
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.root.hidden = !on
    if (!on) this.closeComposer()
    this.unreadCount = 0
    this.syncUnreadDot()
  }

  addRemoteMessage(from: string, text: string): void {
    const cleanText = String(text ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, MAX_CHAT_LEN)
    if (cleanText.length < 1) return
    const cleanFrom = String(from ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 20) || 'Player'
    this.pushRow({ from: cleanFrom, text: cleanText, self: false, ts: Date.now() })
    if (!this.open) {
      this.unreadCount++
      this.syncUnreadDot()
    }
  }

  clearHistory(): void {
    this.rows = []
    this.unreadCount = 0
    this.syncUnreadDot()
    this.renderRows()
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onGlobalKeyDown, true)
    this.inputEl.removeEventListener('keydown', this.onInputKeyDown, true)
  }

  private readonly onGlobalKeyDown = (ev: KeyboardEvent): void => {
    if (!this.enabled) return
    if (ev.key !== 'Enter') return
    const target = ev.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    ev.preventDefault()
    this.openComposer()
  }

  private readonly onInputKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      this.closeComposer()
      return
    }
    if (ev.key !== 'Enter') return
    ev.preventDefault()
    ev.stopPropagation()
    const text = this.inputEl.value.replace(/[\r\n]/g, ' ').trim().slice(0, MAX_CHAT_LEN)
    if (text.length < 1) {
      this.closeComposer()
      return
    }
    if (this.sendFn(text)) {
      this.pushRow({ from: this.localName, text, self: true, ts: Date.now() })
    }
    this.inputEl.value = ''
    this.closeComposer()
  }

  private toggleComposer(): void {
    if (this.open) this.closeComposer()
    else this.openComposer()
  }

  private openComposer(): void {
    if (!this.enabled) return
    this.open = true
    this.root.classList.add('chat-root--open')
    this.logEl.hidden = false
    this.composerEl.hidden = false
    this.mobileBtn.setAttribute('aria-pressed', 'true')
    this.unreadCount = 0
    this.syncUnreadDot()
    this.renderRows()
    this.inputEl.value = ''
    this.inputEl.focus()
  }

  private closeComposer(): void {
    this.open = false
    this.root.classList.remove('chat-root--open')
    this.logEl.hidden = true
    this.composerEl.hidden = true
    this.mobileBtn.setAttribute('aria-pressed', 'false')
    this.inputEl.blur()
  }

  private pushRow(row: ChatRow): void {
    this.rows.push(row)
    if (this.rows.length > MAX_CHAT_ROWS) this.rows = this.rows.slice(this.rows.length - MAX_CHAT_ROWS)
    this.renderRows()
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  private renderRows(): void {
    this.logEl.textContent = ''
    for (const row of this.rows) {
      const line = document.createElement('div')
      line.className = row.self ? 'chat-line chat-line--self' : 'chat-line'
      line.textContent = `${row.from}: ${row.text}`
      this.logEl.appendChild(line)
    }
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  private syncUnreadDot(): void {
    this.notifyDotEl.hidden = !(this.enabled && this.unreadCount > 0)
  }
}

