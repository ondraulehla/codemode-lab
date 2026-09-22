/**
 * One sweep: every task, every arm, serialised.
 *
 *   source ~/.codemode-lab-token
 *   node harness/probe-auth.mjs          # the gate. Run it first, every time.
 *   node harness/run.mjs --task outline-leaves --reps 1
 *   node harness/run.mjs --reps 5        # every task, five repetitions
 *
 * Flags:
 *   --task <id> | --tasks <a,b>   which tasks (default: all)
 *   --reps <n>                    repetitions of the whole set (default 1)
 *   --arms <a,b>                  run exactly these arms instead of each task's set
 *   --model <id>                  default claude-opus-5
 *   --effort <level>              default low
 *   --max-turns <n>               default 12
 *   --max-usd <n>                 per-arm budget cap, default 2
 *   --raw-max-usd <n>             budget cap for A-raw, default 15
 *   --raw-max-output-tokens <n>   MCP output limit for A-raw, default 1000000
 *   --no-latest                   keep results/latest.json as it is. For a check run:
 *                                 the project page reads latest.json through its summary
 *
 * It writes to results/ and stops there. Committing is a human decision, so a bad
 * sweep never lands in git history on its own.
 *
 * Concurrency is one, on purpose. A subscription has one weekly allowance, and
 * parallel arms would also contend for the same remote MCP servers, which are other
 * people's free infrastructure.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { loadTask, listTasks } from '../packages/cli/dist/tasks.js'
import {
  ARM_NAMES,
  CODEMODE_ARMS,
  DEFAULT_ARMS,
  SERVERS,
  disallowedFor,
  expectedToolsFor,
} from './arms.mjs'
import { buildCodeModeServer } from './codemode-tool.mjs'
import { runOneArm, sdkVersion, taskSummary } from './core.mjs'
import { credentialKind } from './env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TASKS = join(ROOT, 'tasks')
const RESULTS = join(ROOT, 'results')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

function list(value) {
  return value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null
}

/** The arms a task runs: the default set plus what the task names, in a fixed order. */
function armsFor(task, override) {
  const wanted = new Set(override ?? [...DEFAULT_ARMS, ...(task.extraArms ?? [])])
  for (const a of wanted) {
    if (!ARM_NAMES.includes(a))
      throw new Error(`unknown arm "${a}". Known: ${ARM_NAMES.join(', ')}`)
  }
  // The floor is the baseline for the definition tax and the memory control. A
  // sweep without it has neither.
  wanted.add('floor')
  return ARM_NAMES.filter((a) => wanted.has(a))
}

async function sweepTask(taskId, cfg) {
  const task = await loadTask(TASKS, taskId)
  const allow = task.servers
  for (const id of Object.keys(allow)) {
    if (!SERVERS[id])
      throw new Error(`task ${taskId} names server "${id}" which arms.mjs does not define`)
  }

  const systemPrompt =
    'You are answering one question using the tools you have. ' +
    'Answer concisely and state the evidence. Do not explain your process.'

  const {
    server: codemode,
    surfaceBytes,
    surfaceSource,
    stats,
    serverTools,
    instructionsBytes,
  } = await buildCodeModeServer(
    Object.fromEntries(Object.keys(allow).map((id) => [id, { url: SERVERS[id].url }])),
    allow,
  )

  // The direct arms see the same tools as the code mode surface: the ones the task
  // allows. Everything else the live server offers is removed from their context,
  // and denied by name on the server entry as well, in case a removal ever fails.
  const disallowed = disallowedFor(task, serverTools)
  const picked = Object.fromEntries(
    Object.keys(allow).map((id) => {
      const denied = (serverTools[id] ?? []).filter((t) => !allow[id].includes(t))
      const { shape: _shape, ...spec } = SERVERS[id]
      return [
        id,
        { ...spec, tools: denied.map((name) => ({ name, permission_policy: 'always_deny' })) },
      ]
    }),
  )

  const withPrompt = { ...task, systemPrompt }
  const records = []

  for (const arm of armsFor(task, cfg.arms)) {
    records.push(
      await runOneArm({
        arm,
        task: withPrompt,
        picked,
        cfg,
        disallowed,
        codemode,
        stats: CODEMODE_ARMS.includes(arm) ? stats : null,
        expectedTools: expectedToolsFor(arm, task),
      }),
    )
  }

  return {
    task: taskId,
    question: task.question,
    expectCodeModeWins: task.expectCodeModeWins,
    predictionUncertain: task.predictionUncertain === true,
    surfaceBytes,
    surfaceSource,
    // Server instructions, given to both arms: by Claude Code to the direct arms,
    // and by the harness to the code mode arm, inside the run_code description.
    serverInstructionsBytes: instructionsBytes,
    deniedTools: disallowed,
    ...taskSummary(records, taskId),
    arms: records,
  }
}

async function main() {
  const only = list(arg('tasks')) ?? list(arg('task'))
  const reps = Number(arg('reps', '1'))
  const cfg = {
    model: arg('model', 'claude-opus-5'),
    effort: arg('effort', 'low'),
    maxTurns: Number(arg('max-turns', '12')),
    maxBudgetUsd: Number(arg('max-usd', '2')),
    rawMaxBudgetUsd: Number(arg('raw-max-usd', '15')),
    rawMaxOutputTokens: Number(arg('raw-max-output-tokens', '1000000')),
    arms: list(arg('arms')),
  }

  const ids = only ?? (await listTasks(TASKS))
  const versions = sdkVersion()
  const startedAt = new Date().toISOString()
  const runId = startedAt.replace(/[:.]/g, '-')

  console.log(`\ncodemode-lab sweep ${runId}`)
  console.log(`credential : ${credentialKind()}`)
  console.log(`model      : ${cfg.model} (effort ${cfg.effort})`)
  console.log(
    `claude code: ${versions.claudeCode} (${versions.commit?.slice(0, 8)}, built ${versions.buildDate})`,
  )
  console.log(`tasks      : ${ids.join(', ')}  x${reps}`)
  console.log(`arms       : ${cfg.arms ? cfg.arms.join(', ') : "each task's own set"}\n`)

  const sweeps = []
  for (let rep = 0; rep < reps; rep++) {
    for (const id of ids) {
      console.log(`[rep ${rep + 1}] ${id}`)
      try {
        sweeps.push({ rep, ...(await sweepTask(id, cfg)) })
      } catch (err) {
        console.log(`  task failed: ${err.message}`)
        sweeps.push({ rep, task: id, error: err.message })
      }
      console.log()
    }
  }

  const report = {
    schemaVersion: 2,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    credential: credentialKind(),
    model: cfg.model,
    effort: cfg.effort,
    cacheTtl: '5m (FORCE_PROMPT_CACHING_5M)',
    config: { reps, ...cfg },
    versions,
    sweeps,
    disclosure: [
      'Every token figure here is what the Anthropic API counted, read from modelUsage on the final result message.',
      'Per-turn figures are read from each API response and cover the input side only.',
      'Both arms declare the same tools: the direct arms have every other tool of the server removed.',
      'Claude Code writes an MCP result over 25,000 tokens to a file. A-uncached and A-cached have no tool to read it; A-files does; A-raw raises the limit.',
      'The Node worker used by arm B is an isolation boundary for measurement, not a security boundary.',
      'No dollar figure here is billed. Costs derived from these tokens use list prices and say so.',
    ],
  }

  await mkdir(RESULTS, { recursive: true })
  const out = join(RESULTS, `sweep-${runId}.json`)
  await writeFile(out, JSON.stringify(report, null, 2))
  const latest = !process.argv.includes('--no-latest')
  if (latest) await writeFile(join(RESULTS, 'latest.json'), JSON.stringify(report, null, 2))

  console.log(`written: ${out}${latest ? ' and results/latest.json' : ''}`)
  console.log(`Next: node harness/summarize.mjs ${latest ? 'results/latest.json' : out}`)
  console.log(
    'Nothing was committed. Read the file, then commit it yourself if the sweep looks sound.',
  )
}

main().catch((err) => {
  console.error(`\nsweep failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
