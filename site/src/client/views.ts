import { formatBytes, esc, EST, formatPercentBand, percentOfWindow, formatBand } from './format'

/** Find a required element inside a root, and fail loudly if the markup drifted. */
export function role<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const el = root.querySelector<T>(`[data-role="${name}"]`)
  if (!el) throw new Error(`missing [data-role="${name}"]`)
  return el
}

/**
 * The context window bar.
 *
 * It is driven by two different kinds of number and says which is which. Bytes of
 * text already received are exact. Bytes still arriving are only known as wire
 * bytes, which include SSE framing, so that part is halved and drawn hatched until
 * the call ends and the exact text count replaces it.
 */
export class WindowMeter {
  private fill: HTMLElement
  private read: HTMLElement
  private pct: HTMLElement

  constructor(root: ParentNode) {
    this.fill = role(root, 'window-fill')
    this.read = role(root, 'window-read')
    this.pct = role(root, 'window-pct')
  }

  set(bytes: number, opts: { provisional?: boolean; small?: boolean } = {}): void {
    const { low, high } = percentOfWindow(bytes)
    const width = Math.min(100, high)
    this.fill.style.width = `${width}%`
    this.fill.classList.toggle('provisional', Boolean(opts.provisional))
    this.fill.classList.toggle('small', Boolean(opts.small))
    this.read.textContent = formatBytes(bytes)
    this.pct.innerHTML =
      low < 1 ? `under 1 percent${EST}` : `${esc(formatPercentBand(bytes))} of 200K${EST}`
  }

  reset(): void {
    this.fill.style.width = '0%'
    this.fill.classList.remove('provisional', 'small')
    this.read.textContent = '0 B'
    this.pct.innerHTML = 'idle'
  }
}

export type CallState = 'pending' | 'running' | 'done' | 'error' | 'skipped'

/** One row per tool call, with a bar that moves while the body streams in. */
export class Ledger {
  private rows = new Map<string, HTMLElement>()

  constructor(
    private host: HTMLElement,
    /** Bar width reference. A 1.6 MB payload fills the row. */
    private scaleBytes = 1.6 * 1024 * 1024,
  ) {}

  reset(): void {
    this.host.innerHTML = ''
    this.rows.clear()
  }

  add(id: string, label: string, note: string): void {
    const el = document.createElement('div')
    el.className = 'call'
    el.dataset.state = 'pending'
    el.innerHTML = `
      <div class="call-top">
        <span class="call-repo">${esc(label)}</span>
        <span class="call-bytes" data-role="bytes">queued</span>
      </div>
      <div class="call-bar"><i data-role="bar"></i></div>
      <div class="call-note" data-role="note">${esc(note)}</div>`
    this.host.appendChild(el)
    this.rows.set(id, el)
  }

  state(id: string, state: CallState): void {
    const el = this.rows.get(id)
    if (el) el.dataset.state = state
  }

  /** Bytes still on the wire. Labelled as wire bytes, because that is what they are. */
  progress(id: string, wireBytes: number): void {
    const el = this.rows.get(id)
    if (!el) return
    el.dataset.state = 'running'
    role(el, 'bytes').textContent = `${formatBytes(wireBytes)} on the wire`
    role(el, 'bar').style.width = `${Math.min(100, (wireBytes / this.scaleBytes) * 100)}%`
  }

  /** Exact text bytes, once the call has ended. */
  settle(id: string, textBytes: number, wireBytes: number, ms: number): void {
    const el = this.rows.get(id)
    if (!el) return
    el.dataset.state = 'done'
    role(el, 'bytes').textContent = `${formatBytes(textBytes)} text`
    role(el, 'bar').style.width = `${Math.min(100, (textBytes / this.scaleBytes) * 100)}%`
    role(el, 'note').innerHTML =
      `wire ${esc(formatBytes(wireBytes))} · text ${esc(formatBytes(textBytes))} · ` +
      `${esc(formatBand(textBytes))}${EST} · ${(ms / 1000).toFixed(1)} s`
  }

  fail(id: string, cls: string, message: string): void {
    const el = this.rows.get(id)
    if (!el) return
    el.dataset.state = 'error'
    role(el, 'bytes').textContent = cls
    role(el, 'note').textContent = message
  }

  skip(id: string, why: string): void {
    const el = this.rows.get(id)
    if (!el) return
    el.dataset.state = 'skipped'
    role(el, 'bytes').textContent = 'never sent'
    role(el, 'note').textContent = why
  }
}

/**
 * The sandbox picture.
 *
 * Payloads pile up on the inside. One small slab leaves. The reader should be able
 * to work out the mechanism from the shapes alone, without reading a number.
 */
export class SandboxView {
  private pile: HTMLElement
  private out: HTMLElement
  private inTotal: HTMLElement
  private slabs = new Map<string, HTMLElement>()
  private scaleBytes = 1.5 * 1024 * 1024

  constructor(root: ParentNode) {
    this.pile = role(root, 'pile')
    this.out = role(root, 'out')
    this.inTotal = role(root, 'in-total')
  }

  reset(): void {
    this.pile.innerHTML = '<p class="pile-empty">nothing inside yet</p>'
    this.out.textContent = '0 B'
    this.inTotal.textContent = '0 B'
    this.slabs.clear()
  }

  private slab(id: string, label: string): HTMLElement {
    let el = this.slabs.get(id)
    if (!el) {
      const empty = this.pile.querySelector('.pile-empty')
      if (empty) empty.remove()
      el = document.createElement('div')
      el.className = 'slab'
      el.textContent = label
      this.pile.appendChild(el)
      this.slabs.set(id, el)
    }
    return el
  }

  grow(id: string, label: string, bytes: number, exact: boolean): void {
    const el = this.slab(id, label)
    el.style.width = `${Math.max(2, Math.min(100, (bytes / this.scaleBytes) * 100))}%`
    el.textContent = `${label} ${formatBytes(bytes)}${exact ? '' : ' (arriving)'}`
  }

  totalIn(bytes: number): void {
    this.inTotal.textContent = formatBytes(bytes)
  }

  crossedOut(bytes: number): void {
    this.out.textContent = formatBytes(bytes)
  }
}

/** Program output, one line at a time, so a reader can watch it think. */
export class ConsoleView {
  constructor(private host: HTMLElement) {}

  reset(): void {
    this.host.textContent = ''
  }

  line(level: string, text: string): void {
    const el = document.createElement('span')
    if (level !== 'log') el.className = level
    el.textContent = `${text}\n`
    this.host.appendChild(el)
    this.host.scrollTop = this.host.scrollHeight
  }
}

export function setStatus(arm: HTMLElement, text: string, tone: string, state: string): void {
  const badge = role(arm, 'status')
  badge.textContent = text
  badge.dataset.tone = tone
  arm.dataset.state = state
}
