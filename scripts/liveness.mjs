/**
 * The claim-rot guard.
 *
 * The README and the site publish measured numbers: transport modes, tool counts,
 * definition sizes, CORS posture and payload sizes. Those numbers are true on the
 * day they were measured. Somebody else owns every one of these servers, so any of
 * them can change a tool list, close CORS or start truncating a payload, and the
 * published figures quietly become lies. This script re-measures every claim and
 * exits non-zero naming the exact claim that went stale.
 *
 * Courtesy rules, because these are free servers paid for by other people:
 * one run a day, serial, never in a burst, and never a tool that spends the
 * provider's money. DeepWiki's ask_question is the one to stay away from.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { SERVERS, McpClient } from '../packages/mcp-client/dist/index.js'
import { schemaSurfaceBytes, generateSurface } from '../packages/typegen/dist/index.js'
import { Meter, utf8Bytes, formatBytes } from '../packages/meter/dist/index.js'
import { listTasks, loadTask, runCodeModeArm } from '../packages/cli/dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** The origin the browser demo is served from. CORS is checked as that page sees it. */
const ORIGIN = 'https://ulehla.dev'

const WINDOW_TOKENS = 200_000

/**
 * The two ends of the estimate band.
 *
 * This repo ships no tokenizer, so every token figure it prints is an estimate
 * from byte counts. The band is stated, never a single confident number.
 */
const BYTES_PER_TOKEN_LOW = 3.8
const BYTES_PER_TOKEN_HIGH = 3.3

/**
 * How far a tools/list may move before the published definition tax is wrong.
 *
 * A server that rewrites one description moves this figure by a few bytes. A
 * server that adds or drops a tool moves it by hundreds, and the tool count check
 * catches that case anyway. Ten percent sits between the two.
 */
const TOOLS_LIST_TOLERANCE = 0.1

/**
 * How far a measured payload may move before the published size is wrong.
 *
 * These are live documents. DeepWiki rebuilds a wiki when its repo changes, so the
 * figure grows a little every week and a fixed byte target would go red every day
 * for no honest reason. Thirty five percent absorbs that growth and still catches
 * the two failures that matter: a server that starts truncating, where the number
 * collapses, and a set of docs that doubles, where the published percent of a
 * context window is then wrong by half.
 */
const PAYLOAD_TOLERANCE = 0.35

/**
 * What a winning task must still prove.
 *
 * cross-repo-scan wins because the payload it reads cannot fit in a window and the
 * answer it returns is tiny. Both halves are asserted. The measured reduction on
 * 2026-09-21 was about 2,900x, so 50x is a floor, not a target.
 */
const WIN_MIN_REDUCTION = 50

/**
 * What a losing task must still prove.
 *
 * A task loses when everything it reads fits in a window with room to spare, so a
 * sandbox buys nothing and only adds a round trip. Twenty five percent is the same
 * line `verdict()` draws in packages/cli/src/scan.ts.
 */
const LOSE_MAX_WINDOW_SHARE = 0.25

/** Pause between servers. One run a day does not need to hurry. */
const COURTESY_PAUSE_MS = 1_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tokenBand = (bytes) => ({
  low: Math.round(bytes / BYTES_PER_TOKEN_LOW),
  high: Math.round(bytes / BYTES_PER_TOKEN_HIGH),
})

const withinTolerance = (measured, recorded, tolerance) =>
  recorded > 0 && Math.abs(measured - recorded) / recorded <= tolerance

const drift = (measured, recorded) =>
  recorded > 0
    ? `${measured > recorded ? '+' : ''}${(((measured - recorded) / recorded) * 100).toFixed(1)}%`
    : 'n/a'

/**
 * One retry, after a wait, for transport errors only.
 *
 * A daily job that goes red on one dropped connection trains its reader to ignore
 * it, and an ignored alarm is worse than no alarm. Two attempts is still courteous.
 */
async function withRetry(label, fn) {
  try {
    return await fn()
  } catch (err) {
    console.log(`  ${label}: first attempt failed (${short(err)}), retrying once in 5 s`)
    await sleep(5_000)
    return fn()
  }
}

const short = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 200)

/** A single POST, returning the raw body bytes and the headers a browser would read. */
async function rawPost(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: ORIGIN,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.text()
  return {
    status: res.status,
    bytes: utf8Bytes(body),
    allowOrigin: res.headers.get('access-control-allow-origin'),
    exposeHeaders: res.headers.get('access-control-expose-headers'),
  }
}

/** The preflight a browser sends before it is allowed to POST at all. */
async function preflight(url) {
  const res = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  return {
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    // A session server is only usable from a page when it exposes this header,
    // because otherwise the page cannot read the session id it was just given.
    exposeHeaders: res.headers.get('access-control-expose-headers'),
  }
}

async function checkServer(spec, stale) {
  const report = { id: spec.id, url: spec.url, checks: [] }
  const add = (claim, ok, recorded, measured, note) => {
    report.checks.push({ claim, ok, recorded, measured, note })
    if (!ok)
      stale.push(
        `${spec.id}: ${claim} was ${recorded}, is now ${measured}${note ? ` (${note})` : ''}`,
      )
  }

  const meter = new Meter()
  const client = new McpClient({ url: spec.url, name: spec.id, meter })
  const tools = await withRetry(spec.id, () => client.connect())

  const recordedMode = spec.session ? 'session' : 'stateless'
  add('transport mode', client.mode === recordedMode, recordedMode, client.mode)

  if (spec.toolCount > 0) {
    add('tool count', tools.length === spec.toolCount, spec.toolCount, tools.length)
  } else {
    report.checks.push({
      claim: 'tool count',
      ok: true,
      recorded: 'not recorded',
      measured: tools.length,
    })
  }

  // One definition of size, for every server, whatever transport it speaks.
  //
  // This used to measure the HTTP response body, and for a session server that meant
  // measuring the initialize reply instead of the tool list. Apify then read as a
  // 75 percent drift that had not happened. The tools array is what a client holds,
  // so it is what gets measured, and SSE framing never enters the number.
  const toolsJsonBytes = schemaSurfaceBytes(tools)

  if (spec.toolsListBytes > 0) {
    add(
      'tools JSON bytes',
      withinTolerance(toolsJsonBytes, spec.toolsListBytes, TOOLS_LIST_TOLERANCE),
      spec.toolsListBytes,
      toolsJsonBytes,
      `drift ${drift(toolsJsonBytes, spec.toolsListBytes)}, tolerance ${TOOLS_LIST_TOLERANCE * 100}%`,
    )
  }

  if (spec.typedSurfaceBytes > 0) {
    const typed = generateSurface(spec.id, tools).bytes
    add(
      'typed surface bytes',
      withinTolerance(typed, spec.typedSurfaceBytes, TOOLS_LIST_TOLERANCE),
      spec.typedSurfaceBytes,
      typed,
      `drift ${drift(typed, spec.typedSurfaceBytes)}, tolerance ${TOOLS_LIST_TOLERANCE * 100}%`,
    )
  }

  const pre = await preflight(spec.url)
  add(
    `CORS from ${ORIGIN}`,
    Boolean(pre.allowOrigin) === spec.corsOpen,
    spec.corsOpen ? 'open' : 'closed',
    pre.allowOrigin ? `open (${pre.allowOrigin})` : 'closed',
    `preflight HTTP ${pre.status}`,
  )

  // Observed, not asserted. A session server is only usable from a page when it
  // exposes mcp-session-id, but SERVERS records that claim for GitMCP in prose
  // only. Recording the header here is how it becomes a number somebody can check.
  report.exposedHeaders = pre.exposeHeaders ?? null

  if (spec.largestKnownCall) {
    const { tool, args, bytes: recordedBytes } = spec.largestKnownCall
    await withRetry(`${spec.id} ${tool}`, () => client.callTool(tool, args))

    // The meter counted both ends of the same response. The recorded figure in
    // SERVERS is wire bytes, so the drift check is wire to wire. Every statement
    // about a context window uses textBytes, which is about half as large.
    const call = meter.records.at(-1)
    const wireBytes = call.wireBytes
    const textBytes = call.textBytes
    const band = tokenBand(textBytes)

    report.payload = {
      tool,
      args,
      recordedWireBytes: recordedBytes,
      measuredWireBytes: wireBytes,
      measuredTextBytes: textBytes,
      estTokensLow: band.low,
      estTokensHigh: band.high,
      windowShareLow: band.low / WINDOW_TOKENS,
      windowShareHigh: band.high / WINDOW_TOKENS,
      ms: Math.round(call.ms),
    }

    add(
      `payload of ${tool}`,
      withinTolerance(wireBytes, recordedBytes, PAYLOAD_TOLERANCE),
      formatBytes(recordedBytes),
      formatBytes(wireBytes),
      `wire bytes, drift ${drift(wireBytes, recordedBytes)}, tolerance ${PAYLOAD_TOLERANCE * 100}%`,
    )
  }

  report.ok = report.checks.every((c) => c.ok)
  return report
}

async function checkTasks(stale) {
  const ids = await listTasks(resolve(ROOT, 'tasks'))
  const reports = []

  for (const id of ids) {
    const task = await loadTask(resolve(ROOT, 'tasks'), id)
    const arm = await runCodeModeArm(task)
    const band = tokenBand(arm.boundaryIn)
    const reduction = arm.returnedBytes > 0 ? arm.boundaryIn / arm.returnedBytes : 0
    const windowShareLow = band.low / WINDOW_TOKENS

    const report = {
      id,
      expectCodeModeWins: task.expectCodeModeWins,
      ok: arm.ok,
      failure: arm.failure,
      error: arm.error ? short(arm.error) : undefined,
      calls: arm.calls,
      boundaryInBytes: arm.boundaryIn,
      returnedBytes: arm.returnedBytes,
      reduction: Number(reduction.toFixed(1)),
      estTokensLow: band.low,
      estTokensHigh: band.high,
      windowShareLow,
      windowShareHigh: band.high / WINDOW_TOKENS,
      ms: Math.round(arm.ms),
    }

    if (!arm.ok)
      stale.push(`task ${id}: the code mode arm no longer runs (${arm.failure ?? 'unknown'})`)

    if (task.expectCodeModeWins) {
      // The win is two facts, so both are asserted. The payload must still not fit,
      // and the answer must still be small enough to be worth reading.
      if (windowShareLow < 1) {
        stale.push(
          `task ${id}: it wins because one run does not fit in a ${WINDOW_TOKENS / 1000}K window, ` +
            `but it now reads only about ${band.low.toLocaleString()} tokens, which fits`,
        )
        report.verdictHeld = false
      } else if (reduction < WIN_MIN_REDUCTION) {
        stale.push(
          `task ${id}: the reduction is now ${reduction.toFixed(1)}x, ` +
            `below the ${WIN_MIN_REDUCTION}x floor the published claim rests on`,
        )
        report.verdictHeld = false
      } else {
        report.verdictHeld = true
      }
    } else {
      if (windowShareLow > LOSE_MAX_WINDOW_SHARE) {
        stale.push(
          `task ${id}: it is published as a code mode loss because everything it reads fits in a window, ` +
            `but it now reads about ${band.low.toLocaleString()} tokens, ` +
            `${Math.round(windowShareLow * 100)}% of a ${WINDOW_TOKENS / 1000}K window`,
        )
        report.verdictHeld = false
      } else {
        report.verdictHeld = true
      }
    }

    reports.push(report)
  }

  return reports
}

function printServer(r) {
  const mark = r.ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${r.id}`)
  for (const c of r.checks) {
    const flag = c.ok ? '  .' : '  X'
    const note = c.note ? `  ${c.note}` : ''
    console.log(
      `${flag} ${c.claim.padEnd(30)} recorded ${String(c.recorded).padEnd(12)} now ${String(c.measured)}${note}`,
    )
  }
  if (r.payload) {
    const p = r.payload
    console.log(
      `    text ${formatBytes(p.measuredTextBytes)}, about ${p.estTokensLow.toLocaleString()} to ` +
        `${p.estTokensHigh.toLocaleString()} tokens (estimate), ` +
        `${Math.round(p.windowShareLow * 100)}% to ${Math.round(p.windowShareHigh * 100)}% of a ` +
        `${WINDOW_TOKENS / 1000}K window, ${p.ms} ms`,
    )
  }
  if (r.exposedHeaders) console.log(`    access-control-expose-headers: ${r.exposedHeaders}`)
}

function printTask(t) {
  const mark = t.ok && t.verdictHeld ? 'ok  ' : 'FAIL'
  const expected = t.expectCodeModeWins ? 'expected to win' : 'expected to lose'
  console.log(
    `${mark} ${t.id.padEnd(17)} ${expected.padEnd(17)} ${t.calls} call${t.calls === 1 ? '' : 's'}, ` +
      `read ${formatBytes(t.boundaryInBytes)}, ` +
      `returned ${formatBytes(t.returnedBytes)}, ${t.reduction}x, ${t.ms} ms`,
  )
  console.log(
    `     about ${t.estTokensLow.toLocaleString()} to ${t.estTokensHigh.toLocaleString()} tokens read (estimate), ` +
      `${Math.round(t.windowShareLow * 100)}% to ${Math.round(t.windowShareHigh * 100)}% of a ${WINDOW_TOKENS / 1000}K window`,
  )
}

async function main() {
  const startedAt = new Date().toISOString()
  const stale = []
  const servers = []

  console.log(`liveness: re-measuring every published claim, origin ${ORIGIN}\n`)

  for (const spec of SERVERS) {
    // A server behind a token is not checkable from a free run, and its credential
    // never belongs in this workflow. It is skipped and said to be skipped.
    if (spec.needsAuth) {
      console.log(
        `skip ${spec.id}: needs a credential, so it is measured only in the harness arm\n`,
      )
      servers.push({ id: spec.id, skipped: 'needsAuth', ok: true, checks: [] })
      continue
    }
    try {
      const report = await checkServer(spec, stale)
      servers.push(report)
      printServer(report)
    } catch (err) {
      const message = short(err)
      stale.push(`${spec.id}: could not be measured at all (${message})`)
      servers.push({ id: spec.id, url: spec.url, ok: false, error: message, checks: [] })
      console.log(`FAIL ${spec.id}: ${message}`)
    }
    console.log('')
    await sleep(COURTESY_PAUSE_MS)
  }

  console.log('tasks: running each code mode arm for real\n')
  const tasks = await checkTasks(stale)
  for (const t of tasks) printTask(t)

  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    node: process.version,
    origin: ORIGIN,
    windowTokens: WINDOW_TOKENS,
    bytesPerTokenBand: [BYTES_PER_TOKEN_HIGH, BYTES_PER_TOKEN_LOW],
    tolerances: { toolsList: TOOLS_LIST_TOLERANCE, payload: PAYLOAD_TOLERANCE },
    ok: stale.length === 0,
    stale,
    servers,
    tasks,
  }

  const out = resolve(ROOT, 'results/liveness-latest.json')
  await mkdir(resolve(ROOT, 'results'), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nreport written to ${out}`)

  if (stale.length) {
    console.log(`\n${stale.length} published claim(s) went stale:`)
    for (const s of stale) console.log(`  - ${s}`)
    console.log('\nFix the number, or fix the claim. Do not fix the tolerance.')
    process.exitCode = 1
    return
  }

  console.log(
    '\nEvery published claim still holds. Token figures above are estimates from byte counts.',
  )
}

await main()
