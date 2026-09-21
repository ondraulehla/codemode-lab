import { Meter, utf8Bytes } from '@codemode-lab/meter'
import type { FailureClass, RunResult, SandboxToHost, ToolTable } from './protocol.js'

/**
 * The half of the bridge that lives on the host side.
 *
 * It is transport-agnostic on purpose: the iframe and the worker differ only in
 * how bytes move, not in what the accounting means. Every tool call that crosses
 * this boundary is measured here, and `RunResult.value` is the only thing that
 * comes back, which is the claim the demo is built to make visible.
 */
export interface BridgeOptions {
  tools: ToolTable
  meter?: Meter
  timeoutMs?: number
  onLog?: (level: string, text: string) => void
  /**
   * Transport handshake lines to keep out of both `onLog` and `RunResult.logs`.
   *
   * Filtering in the transport only was not enough: logs were pushed here first,
   * so the callback stream was clean while `result.logs` still began with the
   * handshake. Anything reading the result, including the demo page, showed it as
   * the program's first line of output.
   */
  internalLogs?: string[]
  /** Fires on every crossing, so a UI can animate the boundary. */
  onBoundary?: (ev: BoundaryEvent) => void
}

export interface BoundaryEvent {
  direction: 'in' | 'out'
  tool: string
  bytes: number
  id: number
}

export class Bridge {
  private started = 0
  private logs: { level: string; text: string }[] = []
  private settle?: (r: RunResult) => void
  private finished = false

  constructor(
    private opts: BridgeOptions,
    /** Transport-specific send. Set by the concrete sandbox. */
    private post: (msg: unknown) => void,
  ) {}

  get toolIds(): string[] {
    return Object.keys(this.opts.tools)
  }

  begin(): Promise<RunResult> {
    this.started = Date.now()
    return new Promise<RunResult>((resolve) => {
      this.settle = resolve
    })
  }

  /** Feed one message from the sandbox. Transports call this and nothing else. */
  handle(msg: SandboxToHost & { failure?: FailureClass }): void {
    if (msg.kind === 'log') {
      if (this.opts.internalLogs?.includes(msg.text)) return
      this.logs.push({ level: msg.level, text: msg.text })
      this.opts.onLog?.(msg.level, msg.text)
      return
    }

    if (msg.kind === 'done') {
      this.finish({
        ok: msg.ok,
        value: msg.value,
        error: msg.error,
        stack: msg.stack,
        logs: this.logs,
        ms: Date.now() - this.started,
        // The sandbox decides the class. classify() only covers messages that
        // never reached the guest, such as a transport death.
        failure: msg.failure ?? classify(msg.error),
      })
      return
    }

    if (msg.kind === 'call') void this.dispatch(msg.id, msg.tool, msg.args)
  }

  private async dispatch(id: number, tool: string, args: unknown): Promise<void> {
    const impl = this.opts.tools[tool]
    const argBytes = utf8Bytes(safeJson(args))
    this.opts.onBoundary?.({ direction: 'out', tool, bytes: argBytes, id })

    if (!impl) {
      this.post({ kind: 'result', id, ok: false, error: `unknown tool: ${tool}` })
      return
    }

    try {
      const value = await impl(args)
      const bytes = utf8Bytes(safeJson(value))
      // This is the number the whole project is about: what the tool returned,
      // measured before the program has had a chance to shrink it.
      this.opts.onBoundary?.({ direction: 'in', tool, bytes, id })
      this.post({ kind: 'result', id, ok: true, value })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.onBoundary?.({ direction: 'in', tool, bytes: utf8Bytes(message), id })
      this.post({ kind: 'result', id, ok: false, error: message })
    }
  }

  /** Called by a transport when the sandbox dies without saying `done`. */
  fail(error: string, failure: FailureClass = 'bridge'): void {
    this.finish({
      ok: false,
      error,
      logs: this.logs,
      ms: Date.now() - this.started,
      failure,
    })
  }

  private finish(r: RunResult): void {
    if (this.finished) return
    this.finished = true
    this.settle?.(r)
  }
}

/**
 * Last-resort classification for failures the sandbox never got to report.
 *
 * Only messages the HOST produced reach this. Anything the guest sent already
 * carries an explicit class, because reading a class out of a message is how this
 * went wrong: the Node sandbox loads from a data URL, so every stack frame quoted
 * the whole guest, the guest's own source contains the word SyntaxError, and every
 * failure came back classified as a syntax error.
 */
function classify(error?: string): FailureClass | undefined {
  if (!error) return undefined
  if (error.startsWith('timeout') || error.includes('hard timeout')) return 'timeout'
  if (error.includes('egress-denied')) return 'egress-denied'
  if (error.includes('unknown tool')) return 'tool-error'
  return 'bridge'
}

/** Byte-count anything, including values that will not stringify. */
function safeJson(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/**
 * Wrap MCP clients into a tool table the sandbox can call.
 *
 * The returned functions are the ONLY capability the program has. It cannot open
 * a socket, read a file or reach a server that is not in this table. Narrowing
 * the table is how you narrow what a compromised program can do.
 */
export function toolTableFrom(
  servers: Record<
    string,
    { callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }> }
  >,
  allow?: Record<string, string[]>,
): ToolTable {
  const table: ToolTable = {}
  for (const [serverId, client] of Object.entries(servers)) {
    const permitted = allow?.[serverId]
    for (const toolName of permitted ?? []) {
      table[`${serverId}.${toolName}`] = async (args) => {
        const res = await client.callTool(toolName, (args ?? {}) as Record<string, unknown>)
        return extractPlainText(res)
      }
    }
  }
  return table
}

function extractPlainText(res: { content: unknown[] }): string {
  return (res.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}
