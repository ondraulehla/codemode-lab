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
 * That is the entire difference between the arms, and it is why the comparison is
 * fair: both arms are told about the same tools, in different shapes.
 *
 * The program runs in the Node sandbox, not the browser one. The browser executor
 * is stronger and belongs to the demo page. Here the sandbox is an isolation
 * boundary for measurement, not a security control, and this file says so rather
 * than implying otherwise.
 */

/** Byte counts from the last program run, read by the harness after each arm. */
export const lastRun = {
  boundaryIn: 0,
  boundaryOut: 0,
  returnedBytes: 0,
  calls: 0,
  programs: [],
}

function resetLastRun() {
  lastRun.boundaryIn = 0
  lastRun.boundaryOut = 0
  lastRun.returnedBytes = 0
  lastRun.calls = 0
  lastRun.programs = []
}

/**
 * Connect the servers once and build the typed surface the model will read.
 *
 * The surface is generated from the live `tools/list`, not from a copy checked into
 * this repo. A stale copy would make arm B cheaper than it really is.
 */
export async function buildCodeModeServer(serverSpecs, allow) {
  resetLastRun()

  const meter = new Meter()
  const clients = {}
  const surfaces = []

  for (const [id, spec] of Object.entries(serverSpecs)) {
    const client = new McpClient({ url: spec.url, name: id, headers: spec.headers, meter })
    const tools = await client.connect()
    clients[id] = client
    const permitted = allow[id] ?? tools.map((t) => t.name)
    surfaces.push(
      generateSurface(
        id,
        tools.filter((t) => permitted.includes(t.name)),
      ),
    )
  }

  const table = toolTableFrom(clients, allow)
  const surfaceSource = surfaces.map((s) => s.source).join('\n')
  const surfaceBytes = surfaces.reduce((n, s) => n + s.bytes, 0)

  const description = [
    'Run a JavaScript program that calls MCP tools and returns a small result.',
    '',
    'The program runs in a sandbox with no network access. The ONLY things it can',
    'reach are the functions declared below. Large results stay inside the sandbox:',
    'only what you `return` comes back to you, so filter before you return.',
    '',
    'Top level await works. Use `return` for the answer and `console.log` for progress.',
    '',
    surfaceSource,
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
          let outBytes = 0
          const before = meter.records.length

          const result = await runInNodeSandbox(normalizeProgram(code), {
            tools: table,
            meter,
            timeoutMs: 180_000,
            onBoundary: (ev) => {
              if (ev.direction === 'in') inBytes += ev.bytes
              else outBytes += ev.bytes
            },
          })

          const returned = result.value === undefined ? '' : JSON.stringify(result.value)
          lastRun.boundaryIn += inBytes
          lastRun.boundaryOut += outBytes
          lastRun.returnedBytes += new TextEncoder().encode(returned).length
          lastRun.calls += meter.records.length - before
          lastRun.programs.push({ code, ok: result.ok, failure: result.failure })

          if (!result.ok) {
            // The model is told the failure CLASS, so it can fix the right thing.
            // A stack trace would send it chasing the sandbox instead of its own bug.
            return {
              content: [
                {
                  type: 'text',
                  text: `Program failed (${result.failure ?? 'unknown'}): ${result.error}\n${result.logs.map((l) => l.text).join('\n')}`,
                },
              ],
              isError: true,
            }
          }

          const logs = result.logs.length
            ? `\nlogs:\n${result.logs.map((l) => l.text).join('\n')}`
            : ''
          return { content: [{ type: 'text', text: `${returned}${logs}` }] }
        },
      ),
    ],
  })

  return { server, surfaceBytes, surfaceSource, meter, clients }
}

/**
 * Make a model's program safe to wrap in an async function.
 *
 * Models often answer with a bare arrow function, or with a trailing semicolon or
 * comment after one. Wrapped naively that becomes a syntax error, arm B fails, and
 * the failure has nothing to do with the hypothesis under test. Any failure here is
 * a harness failure, never a model failure, and the harness records it as such.
 */
export function normalizeProgram(code) {
  let src = code.trim()

  // Strip a markdown fence if the model wrapped the program in one.
  const fence = src.match(/^```(?:js|javascript|ts|typescript)?\n([\s\S]*?)\n```$/)
  if (fence) src = fence[1].trim()

  return src
}
