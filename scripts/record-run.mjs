/**
 * Record one run of both arms, with timings, so a page can replay it.
 *
 *   node scripts/record-run.mjs [task-id] > results/recording-<task>.json
 *
 * The demo page used to make these calls live, from the visitor's browser. That
 * sent other people's browsers at somebody else's free server on every page view,
 * which is not a cost to us but is not ours to spend either. So the run happens
 * here, once, and the page animates what happened.
 *
 * Every number in the recording is measured. Nothing is staged, and the replay is
 * labelled with the date it was captured.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient, SERVERS } from '../packages/mcp-client/dist/index.js'
import { Meter, utf8Bytes } from '../packages/meter/dist/index.js'
import { toolTableFrom } from '../packages/runtime/dist/index.js'
import { runInNodeSandbox } from '../packages/runtime/dist/node.js'
import { generateSurface, schemaSurfaceBytes } from '../packages/typegen/dist/index.js'
import { loadTask } from '../packages/cli/dist/tasks.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS = join(ROOT, 'tasks')
const taskId = process.argv[2] ?? 'table-heavy-page'

/** A 200K window, the figure every percentage on the page is measured against. */
const WINDOW_TOKENS = 200_000

/**
 * Bytes per token, as a band.
 *
 * This repo ships no tokenizer and will not print a single confident token number.
 * 3.8 is the generous end (fewest tokens for the bytes) and 3.3 the pessimistic one.
 */
const BAND = { low: 3.8, high: 3.3 }

const task = await loadTask(TASKS, taskId)
const spec = SERVERS.find((s) => s.id === Object.keys(task.servers)[0])
const started = Date.now()
const at = () => Date.now() - started

// ---------------------------------------------------------------- the tool surface

const meter = new Meter()
const client = new McpClient({ url: spec.url, name: spec.id, meter })
const tools = await client.connect()
const allowed = tools.filter((t) => task.servers[spec.id].includes(t.name))
const surface = generateSurface(spec.id, allowed)

// ---------------------------------------------------------------- arm A, direct

/**
 * The calls the direct arm makes, read out of the reference program.
 *
 * The program is the source of truth for what the task needs, so the two arms
 * cannot drift apart. Anything else would be two different questions.
 */
const argsInProgram = [...task.program.matchAll(/repoName:\s*'([^']+)'/g)].map((m) => m[1])
const repos = argsInProgram.length
  ? [...new Set(argsInProgram)]
  : [...new Set([...task.program.matchAll(/'([\w.-]+\/[\w.-]+)'/g)].map((m) => m[1]))]

const direct = { events: [], calls: [] }
let directTextTotal = 0

for (const repo of repos) {
  const tool = task.servers[spec.id][0]
  direct.events.push({ t: at(), kind: 'call', tool, arg: repo })

  const c = new McpClient({
    url: spec.url,
    name: spec.id,
    meter,
    // Progress ticks are what make the replay feel like arrival rather than a
    // number appearing. They are thinned so the recording stays small.
    onProgress: (bytes) => {
      const last = direct.events[direct.events.length - 1]
      if (last?.kind === 'progress' && bytes - last.wire < 40_000) return
      direct.events.push({ t: at(), kind: 'progress', wire: bytes })
    },
  })
  await c.connect()
  const callStart = at()
  await c.callTool(tool, { repoName: repo })
  const rec = meter.records.at(-1)

  directTextTotal += rec.textBytes
  const cumulativeLow = Math.round((surface.bytes + directTextTotal) / BAND.low)
  const overflow = cumulativeLow > WINDOW_TOKENS

  direct.calls.push({
    arg: repo,
    wireBytes: rec.wireBytes,
    textBytes: rec.textBytes,
    ms: Math.round(rec.ms),
  })
  direct.events.push({
    t: at(),
    kind: 'result',
    tool,
    arg: repo,
    wire: rec.wireBytes,
    text: rec.textBytes,
    cumulativeText: directTextTotal,
    ms: at() - callStart,
  })

  if (overflow) {
    // The remaining calls are not made. That is the finding, and pretending to
    // make them would be staging rather than recording.
    direct.events.push({
      t: at(),
      kind: 'blocked',
      reason:
        'The results already in the window pass ' +
        WINDOW_TOKENS.toLocaleString() +
        ' tokens at the most generous rate this page uses. The remaining calls are not sent.',
      unsent: repos.slice(repos.indexOf(repo) + 1),
    })
    break
  }
}

// ---------------------------------------------------------------- arm B, code mode

const cmMeter = new Meter()
const cmClient = new McpClient({ url: spec.url, name: spec.id, meter: cmMeter })
await cmClient.connect()

const codemode = { events: [], logs: [] }
const cmStart = Date.now()
const cmAt = () => Date.now() - cmStart

const result = await runInNodeSandbox(task.program, {
  tools: toolTableFrom({ [spec.id]: cmClient }, task.servers),
  meter: cmMeter,
  timeoutMs: task.timeoutMs ?? 300_000,
  onLog: (_l, text) => codemode.logs.push({ t: cmAt(), text }),
  onBoundary: (ev) =>
    codemode.events.push({
      t: cmAt(),
      kind: ev.direction === 'out' ? 'call' : 'payload',
      tool: ev.tool,
      bytes: ev.bytes,
      id: ev.id,
    }),
})

const returned = result.value === undefined ? '' : JSON.stringify(result.value, null, 2)
codemode.events.push({ t: cmAt(), kind: 'return', bytes: utf8Bytes(returned) })

// ---------------------------------------------------------------- the recording

const band = (bytes) => ({
  low: Math.round(bytes / BAND.low),
  high: Math.round(bytes / BAND.high),
})

const insideSandbox = codemode.events
  .filter((e) => e.kind === 'payload')
  .reduce((n, e) => n + e.bytes, 0)

const recording = {
  recordedAt: new Date().toISOString(),
  note:
    'Measured, not staged. Every byte count and every timing in this file came from ' +
    'one real run against the live server on the date above. The page replays it.',
  windowTokens: WINDOW_TOKENS,
  bytesPerTokenBand: BAND,
  server: { id: spec.id, label: spec.label, url: spec.url },
  task: {
    id: task.id,
    title: task.title,
    question: task.question,
    why: task.why,
    expectCodeModeWins: task.expectCodeModeWins,
    program: task.program,
    programBytes: utf8Bytes(task.program),
  },
  surface: {
    rawSchemaBytes: schemaSurfaceBytes(allowed),
    typedSurfaceBytes: surface.bytes,
    typedSurface: surface.source,
    toolCount: allowed.length,
  },
  direct: {
    ...direct,
    totals: {
      calls: direct.calls.length,
      plannedCalls: repos.length,
      textBytes: directTextTotal,
      intoWindowBytes: surface.bytes + directTextTotal,
      intoWindowTokens: band(surface.bytes + directTextTotal),
      windowPercent: {
        low: Math.round(((surface.bytes + directTextTotal) / BAND.low / WINDOW_TOKENS) * 100),
        high: Math.round(((surface.bytes + directTextTotal) / BAND.high / WINDOW_TOKENS) * 100),
      },
      ms: direct.events.at(-1)?.t ?? 0,
    },
  },
  codemode: {
    ...codemode,
    ok: result.ok,
    failure: result.failure ?? null,
    value: result.value,
    returnedText: returned,
    totals: {
      calls: codemode.events.filter((e) => e.kind === 'payload').length,
      insideSandboxBytes: insideSandbox,
      returnedBytes: utf8Bytes(returned),
      intoWindowBytes: surface.bytes + utf8Bytes(task.program) + utf8Bytes(returned),
      intoWindowTokens: band(surface.bytes + utf8Bytes(task.program) + utf8Bytes(returned)),
      ratio: Math.round(insideSandbox / Math.max(1, utf8Bytes(returned))),
      ms: cmAt(),
    },
  },
}

const out = join(ROOT, 'results', `recording-${taskId}.json`)
writeFileSync(out, `${JSON.stringify(recording, null, 2)}\n`)

console.error(`recorded ${taskId}`)
console.error(
  `  direct   : ${direct.calls.length} of ${repos.length} calls, ` +
    `${recording.direct.totals.intoWindowBytes.toLocaleString()} B into the window, ` +
    `${recording.direct.totals.windowPercent.low} to ${recording.direct.totals.windowPercent.high}% of it`,
)
console.error(
  `  code mode: ${recording.codemode.totals.calls} calls, ` +
    `${insideSandbox.toLocaleString()} B inside the sandbox, ` +
    `${recording.codemode.totals.returnedBytes.toLocaleString()} B out, ` +
    `${recording.codemode.totals.ratio}x`,
)
console.error(`  written to ${out}`)
