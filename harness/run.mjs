/**
 * One sweep: every task, every arm, serialised.
 *
 *   source ~/.codemode-lab-token
 *   node harness/probe-auth.mjs          # the gate. Run it first, every time.
 *   node harness/run.mjs --task cross-repo-scan --reps 1
 *
 * It writes to results/ and stops there. Committing is a human decision, so a bad
 * sweep never lands in git history on its own.
 *
 * Concurrency is one, on purpose. A subscription has one weekly allowance, and
 * parallel arms would also contend for the same remote MCP servers, which are other
 * people's free infrastructure.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadTask, listTasks } from '../packages/cli/dist/tasks.js'
import { arms, SERVERS, UNCACHED_ARMS, CODEMODE_ARMS } from './arms.mjs'
import { checkArm, toolTax, AssertionFailed } from './assert.mjs'
import { buildCodeModeServer, lastRun } from './codemode-tool.mjs'
import { credentialKind } from './env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TASKS = join(ROOT, 'tasks')
const RESULTS = join(ROOT, 'results')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

/**
 * The exact Claude Code build inside the SDK.
 *
 * `claude --version` reports the interactive CLI on the machine, which is a
 * different build. Recording the wrong one makes week over week numbers
 * incomparable, so this reads the SDK's own manifest.
 *
 * The manifest is not in the package's `exports` map, so it is resolved by path
 * from the package entry point rather than required by specifier.
 */
function sdkVersion() {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const pkgDir = dirname(entry)
    const readJson = (name) => JSON.parse(readFileSync(join(pkgDir, name), 'utf8'))
    // Neither manifest.json nor package.json is in the package's `exports` map, so
    // both are read by path. A require by specifier throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    const manifest = readJson('manifest.json')
    const pkg = readJson('package.json')
    // The manifest's `version` IS the Claude Code build. There is no separate
    // claudeCodeVersion key, and reading one printed "undefined" into the results.
    return {
      claudeCode: manifest.version,
      commit: manifest.commit,
      buildDate: manifest.buildDate,
      sdk: pkg.version,
    }
  } catch (err) {
    return { sdk: 'unknown', claudeCode: 'unknown', commit: `unreadable: ${err.message}` }
  }
}

/**
 * Run one arm to completion and collect everything needed to judge it.
 *
 * Only the LAST result message is kept. `modelUsage` is cumulative across the
 * session, so an earlier one would undercount, and summing per-step output tokens
 * would overcount because those are placeholders copied from message_start.
 */
async function runArm({ armName, options, prompt }) {
  const started = Date.now()
  let initTools = null
  let last = null
  const transcript = []

  const q = query({ prompt, options })

  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') initTools = m.tools ?? []
    if (m.type === 'assistant') {
      const text = (m.message?.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      if (text) transcript.push({ role: 'assistant', text })
    }
    if (m.type === 'result') last = m
  }

  return { armName, result: last, initTools, transcript, ms: Date.now() - started }
}

/**
 * Grade the answer deterministically.
 *
 * A cheaper arm that fails the task is not cheaper. Grading is kept dumb on
 * purpose: substring checks a human can verify by reading. A model grading a model
 * would put the thing under test inside the measurement.
 */
function grade(task, transcript) {
  const expect = task.expect
  if (!expect?.mustMention?.length)
    return { graded: false, reason: 'no expect.mustMention in task.json' }

  const text = transcript
    .map((t) => t.text)
    .join('\n')
    .toLowerCase()
  const missing = expect.mustMention.filter((m) => !text.includes(String(m).toLowerCase()))
  return { graded: true, pass: missing.length === 0, missing }
}

async function sweepTask(taskId, cfg) {
  const task = await loadTask(TASKS, taskId)
  const allow = task.servers
  const picked = Object.fromEntries(
    Object.keys(allow).map((id) => {
      if (!SERVERS[id])
        throw new Error(`task ${taskId} names server "${id}" which arms.mjs does not define`)
      return [id, SERVERS[id]]
    }),
  )

  const systemPrompt =
    'You are answering one question using the tools you have. ' +
    'Answer concisely and state the evidence. Do not explain your process.'

  const {
    server: codemodeServer,
    surfaceBytes,
    surfaceSource,
  } = await buildCodeModeServer(
    Object.fromEntries(Object.entries(picked).map(([id, s]) => [id, { url: s.url }])),
    allow,
  )

  const armSet = arms({ ...task, systemPrompt }, picked, cfg)
  // Arm B swaps the remote servers for the single in-process run_code tool.
  for (const name of CODEMODE_ARMS) armSet[name].mcpServers = { codemode: codemodeServer }

  const records = []

  for (const [armName, options] of Object.entries(armSet)) {
    process.stdout.write(`  ${armName.padEnd(12)} `)
    try {
      const run = await runArm({ armName, options, prompt: task.question })
      const usage = checkArm({
        arm: armName,
        result: run.result,
        initTools: run.initTools,
        cached: !UNCACHED_ARMS.includes(armName),
      })
      // The floor arm carries no tools, so it cannot answer the question. It is a
      // token baseline, not a contender, and grading it would always read FAIL.
      const g =
        armName === 'floor'
          ? { graded: false, reason: 'baseline arm' }
          : grade(task, run.transcript)
      const boundary = CODEMODE_ARMS.includes(armName)
        ? {
            in: lastRun.boundaryIn,
            returned: lastRun.returnedBytes,
            calls: lastRun.calls,
            programs: lastRun.programs.length,
          }
        : null

      records.push({
        arm: armName,
        ok: true,
        usage,
        grade: g,
        ms: run.ms,
        tools: run.initTools,
        boundary,
        transcript: run.transcript,
      })
      console.log(
        `in=${usage.input.toLocaleString().padStart(9)} out=${usage.output.toLocaleString().padStart(6)} ` +
          `cacheR=${usage.cacheRead.toLocaleString().padStart(8)} ${g.graded ? (g.pass ? 'PASS' : 'FAIL') : '-'} ${(run.ms / 1000).toFixed(1)}s`,
      )
    } catch (err) {
      const why = err instanceof AssertionFailed ? err.message : `${err.name}: ${err.message}`
      records.push({ arm: armName, ok: false, discarded: why })
      console.log(`DISCARDED  ${why}`)
    }
  }

  const floor = records.find((r) => r.arm === 'floor' && r.ok)
  const aUnc = records.find((r) => r.arm === 'A-uncached' && r.ok)
  const bUnc = records.find((r) => r.arm === 'B-uncached' && r.ok)

  return {
    task: taskId,
    question: task.question,
    expectCodeModeWins: task.expectCodeModeWins,
    surfaceBytes,
    surfaceSource,
    toolTax: {
      direct: floor && aUnc ? toolTax(floor.usage, aUnc.usage) : null,
      codemode: floor && bUnc ? toolTax(floor.usage, bUnc.usage) : null,
      note: 'Tokens the API counted. Arm input minus floor input, both uncached. No estimate involved.',
    },
    arms: records,
  }
}

async function main() {
  const only = arg('task')
  const reps = Number(arg('reps', '1'))
  const cfg = {
    model: arg('model', 'claude-opus-5'),
    maxTurns: Number(arg('max-turns', '12')),
    maxBudgetUsd: Number(arg('max-usd', '2')),
  }

  const ids = only ? [only] : await listTasks(TASKS)
  const versions = sdkVersion()
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}`

  console.log(`\ncodemode-lab sweep ${runId}`)
  console.log(`credential : ${credentialKind()}`)
  console.log(`model      : ${cfg.model}`)
  console.log(
    `claude code: ${versions.claudeCode} (${versions.commit?.slice(0, 8)}, built ${versions.buildDate})`,
  )
  console.log(`tasks      : ${ids.join(', ')}  x${reps}\n`)

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
    runId,
    startedAt: new Date().toISOString(),
    credential: credentialKind(),
    model: cfg.model,
    effort: 'low',
    cacheTtl: '5m (FORCE_PROMPT_CACHING_5M)',
    versions,
    sweeps,
    disclosure: [
      'Every token figure here is what the Anthropic API counted, read from modelUsage on the final result message.',
      'The typed surface in arm B loses some schema detail: recursive $ref collapses, and not/if/then/else are dropped.',
      'Part of any code mode saving is therefore lost detail, not free compression.',
      'The Node worker used by arm B is an isolation boundary for measurement, not a security boundary.',
      'Cost in dollars is never reported as measured. There is no server-side usage API for an individual account.',
    ],
  }

  await mkdir(RESULTS, { recursive: true })
  const out = join(RESULTS, `sweep-${runId}.json`)
  await writeFile(out, JSON.stringify(report, null, 2))
  await writeFile(join(RESULTS, 'latest.json'), JSON.stringify(report, null, 2))

  console.log(`written: ${out}`)
  console.log(
    'Nothing was committed. Read the file, then commit it yourself if the sweep looks sound.',
  )
}

main().catch((err) => {
  console.error(`\nsweep failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
