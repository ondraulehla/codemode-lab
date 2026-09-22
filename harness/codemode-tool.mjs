import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { McpClient } from '@codemode-lab/mcp-client'
import { Meter } from '@codemode-lab/meter'
import { toolTableFrom } from '@codemode-lab/runtime'
import { runInNodeSandbox } from '@codemode-lab/runtime/node'
import { generateSurface } from '@codemode-lab/typegen'

/**
 * The code mode arm's single tool.
 *
 * Arm B sees exactly one tool, `run_code`, whose description carries the typed
 * surface generated from the same servers arm A loads as native tool definitions.
 * Both arms declare the same tools: arm A has the rest of each server's tools
 * removed with `disallowedTools`, and arm B's surface lists only the allowed ones.
 *
 * The program runs in the Node sandbox, not the browser one. The browser executor
 * is the stronger one and is meant for pages. Here the sandbox is an isolation
 * boundary for measurement, not a security control, and this file says so rather
 * than implying otherwise.
 */

/**
 * Byte counts and programs for ONE arm.
 *
 * This used to be a module-level object that was reset once per task. Both code
 * mode arms of a task share one server, so the cached arm's figures silently
 * included the uncached arm's: exactly twice the calls and bytes in four of five
 * tasks of the 2026-09-21 sweep. run.mjs now resets it before every arm.
 */
export function createStats() {
  const stats = {
    boundaryIn: 0,
    returnedValueBytes: 0,
    toModelBytes: 0,
    calls: 0,
    uniqueCalls: new Set(),
    programs: [],
    reset() {
      stats.boundaryIn = 0
      stats.returnedValueBytes = 0
      stats.toModelBytes = 0
      stats.calls = 0
      stats.uniqueCalls = new Set()
      stats.programs = []
    },
    /** A plain object for the results file. */
    snapshot() {
      return {
        in: stats.boundaryIn,
        returnedValue: stats.returnedValueBytes,
        // What the model actually received: the value AND the program's logs, or
        // the failure text. The value alone undercounts whenever a program logs.
        toModel: stats.toModelBytes,
        calls: stats.calls,
        // A sandbox keeps no state between programs, so a model that runs three
        // programs fetches the same payload three times. The gap between these two
        // numbers is that cost, paid by the server as well as by the clock.
        uniqueCalls: stats.uniqueCalls.size,
        programs: stats.programs.length,
        failedPrograms: stats.programs.filter((p) => !p.ok).length,
        programLog: stats.programs,
      }
    },
  }
  return stats
}

/**
 * Connect the servers once and build the typed surface the model will read.
 *
 * The surface is generated from the live `tools/list`, not from a copy checked into
 * this repo. A stale copy would make arm B cheaper than it really is. The live tool
 * names come back too, so arm A can remove exactly the tools the task does not allow.
 */
export async function buildCodeModeServer(serverSpecs, allow) {
  const meter = new Meter()
  const clients = {}
  const surfaces = []
  const serverTools = {}
  const instructions = []

  for (const [id, spec] of Object.entries(serverSpecs)) {
    const client = new McpClient({ url: spec.url, name: id, headers: spec.headers, meter })
    const tools = await client.connect()
    clients[id] = client
    serverTools[id] = tools.map((t) => t.name)
    const text = await client.getInstructions()
    if (text) instructions.push({ id, text })
    const permitted = allow[id] ?? tools.map((t) => t.name)
    surfaces.push(
      generateSurface(
        id,
        tools.filter((t) => permitted.includes(t.name)),
      ),
    )
  }

  const built = buildCodeModeTool({
    table: toolTableFrom(clients, allow),
    surfaceSource: surfaces.map((s) => s.source).join('\n'),
    surfaceBytes: surfaces.reduce((n, s) => n + s.bytes, 0),
    instructions,
    meter,
  })
  return { ...built, meter, clients, serverTools }
}

/**
 * The `run_code` tool around any tool table.
 *
 * The live servers reach it through MCP clients. The synthetic crossover hands it
 * plain functions. Both get the same description, the same sandbox and the same
 * accounting, so a figure from one can be set next to a figure from the other.
 */
export function buildCodeModeTool({
  table: raw,
  surfaceSource,
  surfaceBytes,
  instructions = [],
  meter = new Meter(),
}) {
  const stats = createStats()

  // Every call goes through here, so the arm's stats see each one with its
  // arguments. Two calls with the same arguments fetched the same payload twice.
  const table = Object.fromEntries(
    Object.entries(raw).map(([id, fn]) => [
      id,
      async (args) => {
        stats.calls += 1
        stats.uniqueCalls.add(`${id} ${JSON.stringify(args ?? {})}`)
        return fn(args)
      },
    ]),
  )

  const description = [
    'Run a JavaScript program that calls MCP tools and returns a small result.',
    '',
    'The program runs in a sandbox with no network access. The ONLY things it can',
    'reach are the functions declared below. Each one resolves to the text of the',
    'tool result. Large results stay inside the sandbox: only what you `return`',
    'comes back to you, so filter before you return.',
    '',
    'Top level await works. Use `return` for the answer and `console.log` for progress.',
    '',
    surfaceSource,
    // The servers' own instructions, passed through as a direct client passes them.
    // Claude Code puts them in front of the direct arm, and on 2026-09-22 they were
    // most of its definition tax. Leaving them out gave code mode a head start that
    // had nothing to do with code mode.
    ...instructions.flatMap(({ id, text }) => ['', `Instructions from the ${id} server:`, text]),
  ].join('\n')

  const server = createSdkMcpServer({
    name: 'codemode',
    version: '0.1.0',
    tools: [
      tool(
        'run_code',
        description,
        { code: z.string().describe('The JavaScript program to run. Use return for the answer.') },
        async ({ code }) => {
          let inBytes = 0
          const callsBefore = stats.calls
          const started = Date.now()

          const result = await runInNodeSandbox(normalizeProgram(code), {
            tools: table,
            meter,
            timeoutMs: 180_000,
            onBoundary: (ev) => {
              if (ev.direction === 'in') inBytes += ev.bytes
            },
          })

          const calls = stats.calls - callsBefore
          const logs = result.logs.map((l) => l.text).join('\n')
          const value = result.value === undefined ? '' : JSON.stringify(result.value)
          const text = result.ok
            ? `${value}${logs ? `\nlogs:\n${logs}` : ''}`
            : // The model is told the failure CLASS, so it can fix the right thing.
              // A stack trace would send it chasing the sandbox instead of its own bug.
              `Program failed (${result.failure ?? 'unknown'}): ${result.error}\n${logs}`

          const toModel = new TextEncoder().encode(text).length
          stats.boundaryIn += inBytes
          stats.returnedValueBytes += result.ok ? new TextEncoder().encode(value).length : 0
          stats.toModelBytes += toModel
          stats.programs.push({
            code,
            ok: result.ok,
            failure: result.ok ? null : (result.failure ?? 'unknown'),
            error: result.ok ? null : String(result.error ?? '').slice(0, 500),
            ms: Date.now() - started,
            calls,
            inBytes,
            toModelBytes: toModel,
          })

          return { content: [{ type: 'text', text }], ...(result.ok ? {} : { isError: true }) }
        },
      ),
    ],
  })

  const instructionsBytes = instructions.reduce(
    (n, i) => n + new TextEncoder().encode(i.text).length,
    0,
  )
  return { server, surfaceBytes, surfaceSource, stats, description, instructionsBytes }
}

/**
 * Make a model's program safe to wrap in an async function.
 *
 * It strips one thing: a markdown fence around the whole program, which models add
 * often and which is a syntax error inside a function body. Anything else a model
 * sends runs as written, so a failure is the program's, and the failure class the
 * sandbox reports says which kind it was.
 */
export function normalizeProgram(code) {
  let src = code.trim()

  const fence = src.match(/^```(?:js|javascript|ts|typescript)?\n([\s\S]*?)\n```$/)
  if (fence) src = fence[1].trim()

  return src
}
