import { McpClient, McpError, extractText } from '@codemode-lab/mcp-client'
import { Meter, utf8Bytes } from '@codemode-lab/meter'
import type { BoundaryEvent, ToolTable } from '@codemode-lab/runtime'
import { runInIframeSandbox } from '@codemode-lab/runtime/browser'
import { PROVISIONAL_WIRE_TO_TEXT, WINDOW_TOKENS, tokenBand } from '../lib/tokens'

/**
 * Both arms of one task, run from the visitor's own browser.
 *
 * No model runs here. The arms differ only in where the payload lands: in the
 * page's context budget, or inside a sandbox that returns a small value. That is
 * the one claim this page is built to test, so the engine keeps the two paths as
 * close as it can and measures both with the same meter.
 */

export interface StepSpec {
  serverId: string
  tool: string
  args: Record<string, unknown>
  label: string
  /** Name of a rule that builds this step's arguments from the previous result. */
  argsFrom?: string
}

export interface TaskSpec {
  id: string
  title: string
  question: string
  why: string
  expectCodeModeWins: boolean
  timeoutMs: number
  program: string
  programBytes: number
  direct: StepSpec[]
  urls: Record<string, string>
  allow: Record<string, string[]>
  /** Raw `tools/list` bytes for the servers this task uses. */
  definitionBytes: number
  /** Typed surface bytes for the same servers, from typegen. */
  surfaceBytes: number
}

export interface ArmOutcome {
  ok: boolean
  /** Everything that would enter the model's context window. */
  contextBytes: number
  /** The part of that which is tool output. */
  payloadBytes: number
  calls: number
  ms: number
  overflow: boolean
  failure?: string
  message?: string
}

/**
 * Dependent arguments, mirrored from the task programs.
 *
 * `tasks/sequential-pair/program.js` pulls the library id out of the first result
 * with this regex. The direct arm has to do the same work, or the comparison is
 * between two different questions.
 */
const ARG_RULES: Record<string, (previous: string) => Record<string, unknown>> = {
  'context7-library-id': (previous) => {
    const match = previous.match(/\/[a-z0-9._-]+\/[a-z0-9._-]+/i)
    return {
      libraryId: match ? match[0] : '/vercel/next.js',
      query: 'app router server actions',
    }
  },
}

export interface DirectHooks {
  start(id: string): void
  progress(id: string, wireBytes: number): void
  settle(id: string, textBytes: number, wireBytes: number, ms: number): void
  fail(id: string, failure: string, message: string): void
  skip(id: string, why: string): void
  context(bytes: number, provisional: boolean): void
}

/** Ledger row ids. The view creates rows under the same ids before the run. */
export function stepId(index: number): string {
  return `step-${index}`
}

/**
 * Direct tool calling: every result lands in the context window.
 *
 * The arm stops as soon as the window cannot hold what has already arrived. It
 * does not pretend to continue, because a real agent could not.
 */
export async function runDirectArm(task: TaskSpec, hooks: DirectHooks): Promise<ArmOutcome> {
  const started = performance.now()
  const meter = new Meter()
  const clients = new Map<string, McpClient>()
  let committedText = 0
  let calls = 0
  let previous = ''
  let active: string | null = null

  const contextNow = (inFlightWire: number, provisional: boolean) =>
    hooks.context(
      task.definitionBytes + committedText + inFlightWire / PROVISIONAL_WIRE_TO_TEXT,
      provisional,
    )

  contextNow(0, false)

  const clientFor = (serverId: string): McpClient => {
    let client = clients.get(serverId)
    if (!client) {
      client = new McpClient({
        url: task.urls[serverId],
        name: serverId,
        meter,
        // Steps run one after another, so the byte count always belongs to `active`.
        onProgress: (bytes) => {
          if (!active) return
          hooks.progress(active, bytes)
          contextNow(bytes, true)
        },
      })
      clients.set(serverId, client)
    }
    return client
  }

  for (let i = 0; i < task.direct.length; i++) {
    const step = task.direct[i]
    const id = stepId(i)
    active = id
    hooks.start(id)

    const args = step.argsFrom ? ARG_RULES[step.argsFrom](previous) : step.args
    const callStarted = performance.now()

    try {
      const result = await clientFor(step.serverId).callTool(step.tool, args)
      const text = extractText(result)
      const textBytes = utf8Bytes(text)
      const record = meter.records[meter.records.length - 1]
      previous = text
      committedText += textBytes
      calls += 1
      hooks.settle(id, textBytes, record?.wireBytes ?? 0, performance.now() - callStarted)
      contextNow(0, false)
    } catch (error) {
      active = null
      const failure = error instanceof McpError ? 'tool-error' : 'transport'
      const message = error instanceof Error ? error.message : String(error)
      hooks.fail(id, failure, message)
      for (let j = i + 1; j < task.direct.length; j++) {
        hooks.skip(stepId(j), 'the previous call failed')
      }
      return {
        ok: false,
        contextBytes: task.definitionBytes + committedText,
        payloadBytes: committedText,
        calls,
        ms: performance.now() - started,
        overflow: false,
        failure,
        message,
      }
    }

    active = null

    const used = tokenBand(task.definitionBytes + committedText)
    if (used.high >= WINDOW_TOKENS && i < task.direct.length - 1) {
      for (let j = i + 1; j < task.direct.length; j++) {
        hooks.skip(stepId(j), 'the window is already full')
      }
      return {
        ok: false,
        contextBytes: task.definitionBytes + committedText,
        payloadBytes: committedText,
        calls,
        ms: performance.now() - started,
        overflow: true,
      }
    }
  }

  return {
    ok: true,
    contextBytes: task.definitionBytes + committedText,
    payloadBytes: committedText,
    calls,
    ms: performance.now() - started,
    overflow: false,
  }
}

export interface CodeHooks {
  out(id: string, tool: string, bytes: number): void
  progress(id: string, label: string, wireBytes: number): void
  landed(id: string, label: string, bytes: number): void
  totalIn(bytes: number): void
  log(level: string, text: string): void
  context(bytes: number): void
}

export interface CodeOutcome extends ArmOutcome {
  value?: unknown
  resultBytes: number
}

/**
 * Code mode: the payloads land inside the sandbox and one small value comes out.
 *
 * What enters the context window is the typed surface, the program, and the
 * returned value. The 1.7 MB never touches it.
 */
export async function runCodeArm(
  task: TaskSpec,
  hooks: CodeHooks,
  mount?: HTMLElement,
): Promise<CodeOutcome> {
  const meter = new Meter()
  const labels = new Map<number, string>()
  const baseContext = task.surfaceBytes + task.programBytes
  let totalIn = 0
  let calls = 0

  hooks.context(baseContext)

  // The host emits the 'out' event synchronously, immediately before it invokes the
  // tool implementation (see Bridge.dispatch). Reading it here is therefore the
  // same call, and it is how a streaming byte count gets tied to a boundary id.
  let currentId = 0

  const onBoundary = (event: BoundaryEvent) => {
    if (event.direction === 'out') {
      currentId = event.id
      hooks.out(String(event.id), event.tool, event.bytes)
      return
    }
    totalIn += event.bytes
    calls += 1
    hooks.landed(String(event.id), labels.get(event.id) ?? event.tool, event.bytes)
    hooks.totalIn(totalIn)
  }

  const tools: ToolTable = {}
  for (const [serverId, names] of Object.entries(task.allow)) {
    for (const name of names) {
      tools[`${serverId}.${name}`] = async (args) => {
        const id = currentId
        const label = shortLabel(args) ?? name
        labels.set(id, label)
        // One client per call, so each streaming body reports its own progress.
        const client = new McpClient({
          url: task.urls[serverId],
          name: serverId,
          meter,
          onProgress: (bytes) => hooks.progress(String(id), label, bytes),
        })
        const result = await client.callTool(name, (args ?? {}) as Record<string, unknown>)
        return extractText(result)
      }
    }
  }

  const run = await runInIframeSandbox(task.program, {
    tools,
    meter,
    timeoutMs: task.timeoutMs,
    onLog: (level, text) => hooks.log(level, text),
    onBoundary,
    mount,
  })

  // Measured on the compact form. The pretty printed version below is a reading
  // aid, and indentation a model would never be sent must not inflate the count.
  const resultBytes = run.ok ? utf8Bytes(compact(run.value)) : 0
  hooks.context(baseContext + resultBytes)

  return {
    ok: run.ok,
    contextBytes: baseContext + resultBytes,
    payloadBytes: totalIn,
    resultBytes,
    calls,
    ms: run.ms,
    overflow: false,
    failure: run.failure,
    message: run.error,
    value: run.value,
  }
}

/** Readable form, for the panel a human looks at. */
export function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The form that would actually cross into a context window. */
export function compact(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** A short label for a slab: the repo name, the query, or nothing useful. */
function shortLabel(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['repoName', 'libraryId', 'query', 'url']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}
