import { McpClient } from '@codemode-lab/mcp-client'
import { generateSurface, schemaSurfaceBytes } from '@codemode-lab/typegen'
import { formatBytes } from '@codemode-lab/meter'
import {
  runCodeArm,
  runDirectArm,
  stepId,
  stringify,
  type ArmOutcome,
  type CodeOutcome,
  type TaskSpec,
} from './engine'
import { EST, bytesAndBand, esc, formatInt, formatPercentBand } from './format'
import { ConsoleView, Ledger, SandboxView, WindowMeter, role, setStatus } from './views'

/**
 * Wiring: markup in, measured numbers out.
 *
 * Every panel on the page runs the same two arms over the same engine, so the
 * headline race and the two tasks where code mode loses cannot drift apart.
 */

interface LabConfig {
  tasks: Record<string, TaskSpec & { caveat?: string; directNote: string; codeNote: string }>
  surfaces: Record<
    string,
    { label: string; toolsListBytes: number; surfaceBytes: number; url: string }
  >
}

const configEl = document.getElementById('lab-config')
if (!configEl?.textContent) throw new Error('lab config is missing')
const config = JSON.parse(configEl.textContent) as LabConfig

/** One panel: a Run button, a direct arm, a code mode arm, and a verdict. */
class TaskPanel {
  private direct: HTMLElement
  private code: HTMLElement
  private directWindow: WindowMeter
  private codeWindow: WindowMeter
  private ledger: Ledger
  private console: ConsoleView
  private sandbox?: SandboxView
  private verdict: HTMLElement
  private buttons: HTMLButtonElement[]
  private ticker?: number
  private running = false

  constructor(
    private root: HTMLElement,
    private task: TaskSpec & { caveat?: string },
  ) {
    this.direct = root.querySelector<HTMLElement>('[data-arm="direct"]')!
    this.code = root.querySelector<HTMLElement>('[data-arm="code"]')!
    this.directWindow = new WindowMeter(this.direct)
    this.codeWindow = new WindowMeter(this.code)
    this.ledger = new Ledger(role(this.direct, 'ledger'))
    this.console = new ConsoleView(role(this.code, 'console'))
    if (this.code.querySelector('[data-role="pile"]')) this.sandbox = new SandboxView(this.code)
    this.verdict = role(root, 'verdict')
    this.buttons = [...document.querySelectorAll<HTMLButtonElement>(`[data-run="${task.id}"]`)]
    for (const button of this.buttons) button.addEventListener('click', () => void this.run())
  }

  private setButtons(label: string, disabled: boolean): void {
    for (const button of this.buttons) {
      button.disabled = disabled
      button.textContent = label
    }
  }

  private resetViews(): void {
    this.ledger.reset()
    this.console.reset()
    this.sandbox?.reset()
    this.directWindow.reset()
    this.codeWindow.reset()
    this.verdict.innerHTML = ''
    for (let i = 0; i < this.task.direct.length; i++) {
      const step = this.task.direct[i]
      this.ledger.add(stepId(i), step.label, `${step.serverId}.${step.tool}`)
    }
  }

  /** A run takes tens of seconds. The clock is how the page says it is still alive. */
  private startClock(): void {
    const started = Date.now()
    const tick = () => {
      const seconds = ((Date.now() - started) / 1000).toFixed(0)
      for (const arm of [this.direct, this.code]) {
        if (arm.dataset.state === 'running') {
          role(arm, 'status').textContent = `running ${seconds} s`
        }
      }
    }
    this.ticker = window.setInterval(tick, 1000)
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.resetViews()
    this.setButtons('running', true)
    setStatus(this.direct, 'running', 'running', 'running')
    setStatus(this.code, 'running', 'running', 'running')
    this.startClock()

    const [direct, code] = await Promise.all([this.runDirect(), this.runCode()])

    window.clearInterval(this.ticker)
    this.renderVerdict(direct, code)
    this.setButtons('Run again', false)
    this.running = false
  }

  private async runDirect(): Promise<ArmOutcome> {
    const outcome = await runDirectArm(this.task, {
      start: (id) => this.ledger.state(id, 'running'),
      progress: (id, wire) => this.ledger.progress(id, wire),
      settle: (id, text, wire, ms) => this.ledger.settle(id, text, wire, ms),
      fail: (id, failure, message) => this.ledger.fail(id, failure, message),
      skip: (id, why) => this.ledger.skip(id, why),
      context: (bytes, provisional) => this.directWindow.set(bytes, { provisional }),
    })

    if (outcome.overflow) setStatus(this.direct, 'overflow', 'bad', 'overflow')
    else if (!outcome.ok) setStatus(this.direct, outcome.failure ?? 'failed', 'bad', 'failed')
    else setStatus(this.direct, 'finished', 'good', 'done')

    this.renderDirectSummary(outcome)
    return outcome
  }

  private async runCode(): Promise<CodeOutcome> {
    const outcome = await runCodeArm(
      this.task,
      {
        out: (id, tool, bytes) =>
          this.console.line('log', `call out: ${tool} (${formatBytes(bytes)} of arguments)`),
        progress: (id, label, wire) => this.sandbox?.grow(id, label, wire / 2, false),
        landed: (id, label, bytes) => this.sandbox?.grow(id, label, bytes, true),
        totalIn: (bytes) => this.sandbox?.totalIn(bytes),
        log: (level, text) => this.console.line(level, text),
        context: (bytes) => this.codeWindow.set(bytes, { small: true }),
      },
      this.code.querySelector<HTMLElement>('[data-role="sandbox-mount"]') ?? undefined,
    )

    if (outcome.ok) {
      setStatus(this.code, 'finished', 'good', 'done')
      this.sandbox?.crossedOut(outcome.resultBytes)
      this.console.line('log', `returned ${formatBytes(outcome.resultBytes)} to the model`)
    } else {
      setStatus(this.code, outcome.failure ?? 'failed', 'bad', 'failed')
      this.console.line('error', `${outcome.failure ?? 'failed'}: ${firstLine(outcome.message)}`)
    }

    this.renderCodeSummary(outcome)
    return outcome
  }

  private renderDirectSummary(outcome: ArmOutcome): void {
    const rows = [
      ['tool definitions', formatBytes(this.task.definitionBytes)],
      ['payload text', formatBytes(outcome.payloadBytes)],
      ['into the window', bytesAndBand(outcome.contextBytes)],
      ['window used', `${esc(formatPercentBand(outcome.contextBytes))} of 200K${EST}`],
      ['calls made', `${outcome.calls} of ${this.task.direct.length}`],
      ['wall clock', `${(outcome.ms / 1000).toFixed(1)} s`],
    ]
    let note = ''
    if (outcome.overflow) {
      note = `<p class="verdict"><b>Overflow.</b> One payload filled the window. The remaining ${
        this.task.direct.length - outcome.calls
      } call${this.task.direct.length - outcome.calls === 1 ? ' was' : 's were'} never sent, because there is nowhere to put the answer.</p>`
    } else if (!outcome.ok) {
      note = `<p class="verdict"><b>${esc(outcome.failure ?? 'failed')}.</b> ${esc(firstLine(outcome.message))}</p>`
    }
    role(this.direct, 'summary').innerHTML = kv(rows) + note
  }

  private renderCodeSummary(outcome: CodeOutcome): void {
    const ratio =
      outcome.resultBytes > 0 ? Math.round(outcome.payloadBytes / outcome.resultBytes) : 0
    const rows = [
      ['typed surface', formatBytes(this.task.surfaceBytes)],
      ['program', formatBytes(this.task.programBytes)],
      ['value returned', formatBytes(outcome.resultBytes)],
      ['into the window', bytesAndBand(outcome.contextBytes)],
      ['window used', `${esc(formatPercentBand(outcome.contextBytes))} of 200K${EST}`],
      [
        'inside the sandbox',
        `${formatBytes(outcome.payloadBytes)} over ${outcome.calls} call${outcome.calls === 1 ? '' : 's'}`,
      ],
      ['wall clock', `${(outcome.ms / 1000).toFixed(1)} s`],
    ]
    if (ratio > 1) {
      rows.push(['bytes in to bytes out', `${ratio.toLocaleString('en-GB')} to 1`])
    }
    const reason = outcome.ok
      ? ''
      : `<p class="verdict"><b>${esc(outcome.failure ?? 'failed')}.</b> ${esc(firstLine(outcome.message))}</p>`
    const value = outcome.ok
      ? `<div class="code-head"><b>returned to the model</b><span>${esc(formatBytes(outcome.resultBytes))}</span></div><pre class="code">${esc(
          truncate(stringify(outcome.value), 2400),
        )}</pre>`
      : ''
    role(this.code, 'summary').innerHTML = kv(rows) + reason + value
  }

  private renderVerdict(direct: ArmOutcome, code: CodeOutcome): void {
    const parts: string[] = []
    if (direct.overflow) {
      parts.push(
        `<p><b>Code mode wins this one.</b> Direct tool calling stopped after ${direct.calls} of ${
          this.task.direct.length
        } calls with ${esc(formatPercentBand(direct.contextBytes))} of a 200K window used. ` +
          `Code mode pulled ${esc(formatBytes(code.payloadBytes))} into the sandbox and returned ${esc(
            formatBytes(code.resultBytes),
          )}.</p>`,
      )
    } else if (direct.ok && code.ok) {
      const larger = Math.max(direct.contextBytes, code.contextBytes)
      const gap = Math.abs(direct.contextBytes - code.contextBytes) / larger
      // Under a fifth apart is a tie. Calling a 100 byte difference a win would be
      // the same overclaiming this project exists to argue against.
      const headline =
        gap < 0.2
          ? 'No real difference in volume'
          : code.contextBytes < direct.contextBytes
            ? 'Code mode put fewer bytes in the window'
            : 'Direct tool calling put fewer bytes in the window'
      parts.push(
        `<p><b>${headline}.</b> Direct: ${esc(formatBytes(direct.contextBytes))} in context over ${
          direct.calls
        } call${direct.calls === 1 ? '' : 's'}. Code mode: ${esc(
          formatBytes(code.contextBytes),
        )} in context, plus a sandbox round trip and a program the model had to write first.</p>`,
      )
    } else {
      parts.push(
        `<p><b>The run did not finish.</b> Direct arm: ${esc(direct.failure ?? 'ok')}. Code mode arm: ${esc(
          code.failure ?? 'ok',
        )}. The failure class is named above. Try again: DeepWiki can be slow on a cache miss.</p>`,
      )
    }
    if (this.task.caveat) parts.push(`<p>${this.task.caveat}</p>`)
    this.verdict.innerHTML = `<div class="panel loud">${parts.join('')}</div>`
  }
}

function kv(rows: string[][]): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

/**
 * A failure is reported as a class plus one line. A stack trace from inside the
 * sandbox points at the guest, not at anything the reader can act on.
 */
function firstLine(text: string | undefined): string {
  if (!text) return 'no message'
  const line = text.split('\n')[0].trim()
  return line.length > 200 ? `${line.slice(0, 200)} ...` : line
}

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n... ${text.length - max} more characters`
}

for (const [id, task] of Object.entries(config.tasks)) {
  const root = document.querySelector<HTMLElement>(`[data-task="${id}"]`)
  if (root) new TaskPanel(root, task)
}

/* ------------------------------------------------------------------- tabs */

for (const group of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        const selected = other === tab
        other.setAttribute('aria-selected', String(selected))
        const panel = document.getElementById(other.getAttribute('aria-controls') ?? '')
        if (panel) panel.hidden = !selected
      }
    })
  })
}

/* --------------------------------------------------------- surface refresh */

/**
 * Prove the surface panel is not a screenshot.
 *
 * The bytes rendered at build time came from a capture. This button fetches
 * `tools/list` again, right now, and regenerates the surface with the same typegen
 * package the CLI uses. If a server changed its schemas, the numbers move.
 */
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-refresh-surface]')) {
  button.addEventListener('click', async () => {
    const serverId = button.dataset.refreshSurface!
    const panel = document.querySelector<HTMLElement>(`[data-surface="${serverId}"]`)
    const spec = config.surfaces[serverId]
    if (!panel || !spec) return
    const status = role(panel, 'surface-status')
    button.disabled = true
    status.textContent = 'fetching tools/list ...'
    try {
      const client = new McpClient({ url: spec.url, name: spec.label })
      const tools = await client.connect()
      const surface = generateSurface(serverId, tools)
      const rawBytes = schemaSurfaceBytes(tools)
      role(panel, 'raw-json').textContent = JSON.stringify({ tools }, null, 2)
      role(panel, 'surface-source').textContent = surface.source
      role(panel, 'raw-bytes').textContent = `${formatInt(rawBytes)} B`
      role(panel, 'surface-bytes').textContent = `${formatInt(surface.bytes)} B`
      role(panel, 'surface-delta').textContent = deltaLabel(rawBytes, surface.bytes)
      status.textContent = `live, ${tools.length} tools, fetched just now`
    } catch (error) {
      status.textContent = `transport: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      button.disabled = false
    }
  })
}

function deltaLabel(raw: number, surface: number): string {
  const delta = Math.round(((surface - raw) / raw) * 100)
  return `${delta > 0 ? '+' : ''}${delta} percent`
}
