/**
 * The crossover sweep: at what payload size does code mode start to pay?
 *
 *   source ~/.codemode-lab-token
 *   node harness/crossover.mjs --plan                  # what would run, and the cost ceiling
 *   node harness/crossover.mjs --yes                   # run it
 *   node harness/crossover.mjs --summary results/crossover-<run-id>.json
 *
 * Flags:
 *   --sizes <KiB,...>    default 1,4,16,64,256,1024
 *   --shards <n,...>     default 1. More shards is the fan-out dimension.
 *   --reps <n>           default 3
 *   --seed <n>           default 1
 *   --arms <a,...>       default: every arm below
 *   --model, --effort, --max-usd, --raw-max-usd, as in run.mjs
 *
 * The live tasks cannot answer this, because a live server does not return a
 * payload of a chosen size. The synthetic orders server does, with an answer that
 * is computed rather than looked up. See harness/synthetic/orders.mjs.
 *
 * A run needs predictions written down first, in harness/synthetic/predictions.json.
 * The script refuses to start without them. A crossover chart with no prediction
 * next to it is a picture, not a test.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { generateSurface } from '@codemode-lab/typegen'
import { ARM_NAMES } from './arms.mjs'
import { buildCodeModeTool } from './codemode-tool.mjs'
import { runOneArm, sdkVersion, taskSummary } from './core.mjs'
import { credentialKind } from './env.mjs'
import { breakEven, summarize } from './summarize.mjs'
import { ordersTask } from './synthetic/orders.mjs'
import { QUERY_ORDERS, directServer, mcpTools, toolTable } from './synthetic/server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RESULTS = join(ROOT, 'results')
const PREDICTIONS = join(HERE, 'synthetic', 'predictions.json')

/**
 * The arms of the crossover. `A-tool` is the direct arm with a narrower tool: the
 * server filters, so only matching rows travel. It reuses the options of
 * `A-uncached` and differs only in the tool it is given.
 */
export const CROSSOVER_ARMS = [
  'floor',
  'A-uncached',
  'A-cached',
  'A-files',
  'A-raw',
  'A-tool',
  'B-uncached',
  'B-cached',
]

const SYSTEM_PROMPT =
  'You are answering one question using the tools you have. ' +
  'Answer concisely and state the evidence. Do not explain your process.'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)
const numbers = (s) => s.split(',').map(Number).filter(Number.isFinite)

/** Everything one arm needs for one synthetic task. */
function armSetup(arm, task) {
  const servers = { synthetic: ['get_orders'] }
  if (arm === 'A-tool') {
    return {
      base: 'A-uncached',
      servers: { synthetic: [QUERY_ORDERS.name] },
      picked: { synthetic: directServer(task, { filter: true }) },
      expectedTools: [`mcp__synthetic__${QUERY_ORDERS.name}`],
    }
  }
  if (arm === 'floor') return { base: arm, servers, picked: {}, expectedTools: [] }
  if (arm.startsWith('B-'))
    return { base: arm, servers, picked: {}, expectedTools: ['mcp__codemode__run_code'] }
  const expectedTools = [
    'mcp__synthetic__get_orders',
    ...(arm === 'A-files' ? ['Read', 'Grep'] : []),
  ]
  return { base: arm, servers, picked: { synthetic: directServer(task) }, expectedTools }
}

async function runPoint({ kib, shards, rep, seed, cfg, arms }) {
  const task = ordersTask({ kib, shards, seed: seed + rep })
  console.log(
    `[rep ${rep + 1}] ${task.id}: ${task.bytes.toLocaleString()} bytes, ${task.rows} rows`,
  )

  const surface = generateSurface('synthetic', mcpTools)
  const code = buildCodeModeTool({
    table: toolTable(task),
    surfaceSource: surface.source,
    surfaceBytes: surface.bytes,
  })

  const records = []
  for (const arm of arms) {
    const s = armSetup(arm, task)
    records.push(
      await runOneArm({
        arm: s.base,
        label: arm,
        task: {
          ...task,
          servers: s.servers,
          systemPrompt: SYSTEM_PROMPT,
          // Above the output limit, arms without a file tool may not finish. That is
          // a measurement, so it is declared rather than discarded.
          mayNotComplete: ['A-uncached', 'A-cached', 'A-files', 'A-raw', 'A-tool'],
        },
        picked: s.picked,
        cfg,
        codemode: code.server,
        stats: arm.startsWith('B-') ? code.stats : null,
        expectedTools: s.expectedTools,
      }),
    )
  }

  return {
    rep,
    task: task.id,
    question: task.question,
    // Code mode is predicted to win above the break-even and lose below it. The
    // prediction file holds the numbers; per point the call is left open.
    expectCodeModeWins: true,
    predictionUncertain: true,
    meta: { kib, shards, bytes: task.bytes, rows: task.rows, seed: seed + rep, truth: task.truth },
    surfaceBytes: surface.bytes,
    ...taskSummary(records, task.id),
    arms: records,
  }
}

/** Print where each pair crosses 1x, per shard count. */
export function printCrossover(summary) {
  const byShards = new Map()
  for (const t of summary.tasks) {
    if (!t.meta) continue
    if (!byShards.has(t.meta.shards)) byShards.set(t.meta.shards, [])
    byShards.get(t.meta.shards).push(t)
  }
  for (const [shards, tasks] of byShards) {
    tasks.sort((a, b) => a.meta.kib - b.meta.kib)
    console.log(`\n${shards} shard(s): code mode over direct, list price, median`)
    const pairs = [...new Set(tasks.flatMap((t) => Object.keys(t.pairs)))]
    const head = [
      'KiB'.padStart(6),
      ...pairs.map((p) => p.replace('B-uncached vs ', 'B/').padStart(14)),
    ]
    console.log(head.join(' '))
    for (const t of tasks) {
      const cells = pairs.map((p) => {
        const r = t.pairs[p]?.usdRatio?.median
        return (r == null ? '-' : `${r.toFixed(2)}x`).padStart(14)
      })
      console.log([String(t.meta.kib).padStart(6), ...cells].join(' '))
    }
    for (const p of pairs) {
      const points = tasks
        .map((t) => ({ kib: t.meta.kib, ratio: t.pairs[p]?.usdRatio?.median }))
        .filter((x) => x.ratio != null)
      const be = breakEven(points)
      console.log(`  ${p}: ${be.text}`)
    }
  }
}

async function main() {
  if (arg('summary')) {
    const report = JSON.parse(readFileSync(resolve(arg('summary')), 'utf8'))
    printCrossover(summarize(report))
    return
  }

  const cfg = {
    model: arg('model', 'claude-opus-5'),
    effort: arg('effort', 'low'),
    maxTurns: Number(arg('max-turns', '12')),
    maxBudgetUsd: Number(arg('max-usd', '2')),
    rawMaxBudgetUsd: Number(arg('raw-max-usd', '15')),
    rawMaxOutputTokens: Number(arg('raw-max-output-tokens', '1000000')),
  }
  const sizes = numbers(arg('sizes', '1,4,16,64,256,1024'))
  const shardsList = numbers(arg('shards', '1'))
  const reps = Number(arg('reps', '3'))
  const seed = Number(arg('seed', '1'))
  const arms = arg('arms') ? arg('arms').split(',') : CROSSOVER_ARMS
  for (const a of arms) {
    if (!CROSSOVER_ARMS.includes(a))
      throw new Error(`unknown arm "${a}". Known: ${CROSSOVER_ARMS.join(', ')}`)
  }
  if (!arms.includes('floor')) arms.unshift('floor')

  // The ceiling a run can reach: every arm hits its budget cap. The real cost is
  // far lower on small payloads, but a plan should state its worst case.
  const runs = sizes.length * shardsList.length * reps * arms.length
  const ceiling =
    sizes.length *
    shardsList.length *
    reps *
    arms.reduce((n, a) => n + (a === 'A-raw' ? cfg.rawMaxBudgetUsd : cfg.maxBudgetUsd), 0)
  console.log(`\ncodemode-lab crossover`)
  console.log(`sizes  : ${sizes.join(', ')} KiB   shards: ${shardsList.join(', ')}   reps: ${reps}`)
  console.log(`arms   : ${arms.join(', ')}`)
  console.log(
    `runs   : ${runs}, cost ceiling from budget caps: $${ceiling.toFixed(0)} at list price`,
  )

  if (!existsSync(PREDICTIONS)) {
    console.log(`\nNo predictions at ${PREDICTIONS}. Write them first, then run again.`)
    process.exitCode = 1
    return
  }
  const predictions = JSON.parse(readFileSync(PREDICTIONS, 'utf8'))
  console.log(`predictions recorded: ${predictions.recorded}`)
  if (flag('plan') || !flag('yes')) {
    console.log('\nPlan only. Add --yes to run it.')
    return
  }

  const versions = sdkVersion()
  const startedAt = new Date().toISOString()
  const runId = startedAt.replace(/[:.]/g, '-')
  console.log(`credential: ${credentialKind()}, claude code ${versions.claudeCode}\n`)

  const sweeps = []
  for (let rep = 0; rep < reps; rep++) {
    for (const shards of shardsList) {
      for (const kib of sizes) {
        try {
          sweeps.push(await runPoint({ kib, shards, rep, seed, cfg, arms }))
        } catch (err) {
          console.log(`  point failed: ${err.message}`)
          sweeps.push({ rep, task: `orders-${kib}KiB-${shards}x`, error: err.message })
        }
        console.log()
      }
    }
  }

  const report = {
    schemaVersion: 2,
    kind: 'crossover',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    credential: credentialKind(),
    model: cfg.model,
    effort: cfg.effort,
    cacheTtl: '5m (FORCE_PROMPT_CACHING_5M)',
    config: { sizes, shards: shardsList, reps, seed, arms, ...cfg },
    predictions,
    versions,
    sweeps,
    disclosure: [
      'Synthetic data from harness/synthetic/orders.mjs. The answer is computed, not looked up.',
      'Every token figure is what the Anthropic API counted, read from modelUsage.',
      'A-tool is the direct arm with a server-side filter instead of the full export.',
      'No dollar figure here is billed. Costs derived from these tokens use list prices and say so.',
    ],
  }

  await mkdir(RESULTS, { recursive: true })
  const out = join(RESULTS, `crossover-${runId}.json`)
  await writeFile(out, JSON.stringify(report, null, 2))
  console.log(`written: ${out}`)
  printCrossover(summarize(report))
}

// Imported by tests for printCrossover and CROSSOVER_ARMS; run only as a script.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`\ncrossover failed: ${err.stack ?? err.message}`)
    process.exit(1)
  })
}

export { ARM_NAMES }
