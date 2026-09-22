import { McpClient } from '@codemode-lab/mcp-client'
import { Meter } from '@codemode-lab/meter'
import { toolTableFrom } from '@codemode-lab/runtime'
import { runInNodeSandbox } from '@codemode-lab/runtime/node'
import { SERVERS } from '@codemode-lab/mcp-client'
import type { LoadedTask } from './tasks.js'

/**
 * What one arm of one task cost.
 *
 * `boundaryIn` is the number this project exists to surface: how many bytes the
 * tools handed the program. `returnedBytes` is what the model would actually have
 * to read. In direct tool calling those two numbers are the same, which is the
 * entire argument.
 */
export interface ArmResult {
  arm: 'codemode' | 'direct'
  ok: boolean
  boundaryIn: number
  boundaryOut: number
  returnedBytes: number
  calls: number
  /**
   * The text of the single largest call. A task wins or loses on whether ONE result
   * is over a client's output limit, which a total over several calls cannot show.
   */
  largestCallTextBytes: number
  ms: number
  failure?: string
  error?: string
  logs: string[]
  value?: unknown
}

export async function runCodeModeArm(
  task: LoadedTask,
  opts: { tokens?: Record<string, string> } = {},
): Promise<ArmResult> {
  const meter = new Meter()
  const clients: Record<string, McpClient> = {}

  for (const serverId of Object.keys(task.servers)) {
    const spec = SERVERS.find((s) => s.id === serverId)
    if (!spec) throw new Error(`task ${task.id} names unknown server "${serverId}"`)
    const token = opts.tokens?.[serverId]
    if (spec.needsAuth && !token) {
      throw new Error(
        `server "${serverId}" needs a token. Set it in the environment; it never belongs in a public page.`,
      )
    }
    const client = new McpClient({
      url: spec.url,
      name: serverId,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      meter,
    })
    await client.connect()
    clients[serverId] = client
  }

  const tools = toolTableFrom(clients, task.servers)

  let boundaryIn = 0
  let boundaryOut = 0
  const logs: string[] = []

  const result = await runInNodeSandbox(task.program, {
    tools,
    meter,
    timeoutMs: task.timeoutMs ?? 120_000,
    onLog: (_l, text) => logs.push(text),
    onBoundary: (ev) => {
      if (ev.direction === 'in') boundaryIn += ev.bytes
      else boundaryOut += ev.bytes
    },
  })

  const returned = result.value === undefined ? '' : JSON.stringify(result.value)

  return {
    arm: 'codemode',
    ok: result.ok,
    boundaryIn,
    boundaryOut,
    returnedBytes: new TextEncoder().encode(returned).length,
    calls: meter.records.length,
    largestCallTextBytes: Math.max(0, ...meter.records.map((r) => r.textBytes)),
    ms: result.ms,
    failure: result.failure,
    error: result.error,
    logs,
    value: result.value,
  }
}

/**
 * The direct arm, measured without a model.
 *
 * It makes exactly the calls the task allows and adds up what came back, because
 * that is what a direct-calling agent would be forced to put in its context. No
 * model runs, so this is not a claim about accuracy. It is a claim about volume,
 * and volume is the thing that decides whether the task is possible at all.
 */
export async function runDirectArm(
  task: LoadedTask,
  calls: { server: string; tool: string; args: Record<string, unknown> }[],
  opts: { tokens?: Record<string, string> } = {},
): Promise<ArmResult> {
  const meter = new Meter()
  const started = Date.now()
  const clients: Record<string, McpClient> = {}

  for (const serverId of Object.keys(task.servers)) {
    const spec = SERVERS.find((s) => s.id === serverId)!
    const token = opts.tokens?.[serverId]
    const c = new McpClient({
      url: spec.url,
      name: serverId,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      meter,
    })
    await c.connect()
    clients[serverId] = c
  }

  for (const call of calls) {
    try {
      await clients[call.server].callTool(call.tool, call.args)
    } catch {
      // Recorded by the meter. A failed call still costs the round trip.
    }
  }

  const t = meter.totals
  return {
    arm: 'direct',
    ok: t.errors === 0,
    boundaryIn: t.textBytes,
    boundaryOut: t.argsBytes,
    // In direct calling, everything that came back IS what the model must read.
    returnedBytes: t.textBytes,
    calls: t.calls,
    largestCallTextBytes: Math.max(0, ...meter.records.map((r) => r.textBytes)),
    ms: Date.now() - started,
    logs: [],
  }
}
