/**
 * Running one arm, and turning its runs into a sweep record.
 *
 * Shared by the live sweep (run.mjs) and the synthetic crossover (crossover.mjs),
 * so both measure, assert and grade in exactly the same way. A figure from one can
 * then be set next to a figure from the other.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { UNCACHED_ARMS, armOptions, canReadFiles } from './arms.mjs'
import { checkArm, totalUsage, AssertionFailed } from './assert.mjs'
import {
  TurnLog,
  answerClass,
  definitionTax,
  extraInputOverFloor,
  finalAnswer,
  grade,
} from './measure.mjs'

/**
 * The exact Claude Code build inside the SDK.
 *
 * `claude --version` reports the interactive CLI on the machine, which is a
 * different build. Recording the wrong one makes week over week numbers
 * incomparable, so this reads the SDK's own manifest.
 */
export function sdkVersion() {
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
export async function runArm({ options, prompt }) {
  const started = Date.now()
  let initTools = null
  let last = null
  const transcript = []
  const turns = new TurnLog()

  try {
    for await (const m of query({ prompt, options })) {
      turns.push(m)
      if (m.type === 'system' && m.subtype === 'init') initTools = m.tools ?? []
      if (m.type === 'assistant' && m.parent_tool_use_id == null) {
        const text = (m.message?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
        if (text) transcript.push({ role: 'assistant', text })
      }
      if (m.type === 'result') last = m
    }
  } catch (err) {
    // The SDK yields the error result and then throws, for example when an arm
    // runs out of turns. The result carries the usage, and an arm that may not
    // complete must be recorded with it, not discarded. Without a result there is
    // nothing to record, so the error goes on up.
    if (!last) throw err
  }

  return { result: last, initTools, transcript, turns, ms: Date.now() - started }
}

/**
 * Run one arm in a clean directory and return its record.
 *
 * `arm` picks the options from arms.mjs. `label` names the record, so a variant
 * such as the crossover's filtered tool can reuse a base arm's options under its
 * own name. A run that fails an assertion comes back as a discarded record, never
 * as a record with zeroed usage that would read like a measurement.
 */
export async function runOneArm({
  arm,
  label = arm,
  task,
  picked,
  cfg,
  disallowed = [],
  codemode,
  stats,
  expectedTools,
  prompt = task.question,
}) {
  process.stdout.write(`  ${label.padEnd(12)} `)
  const configDir = await mkdtemp(join(tmpdir(), `cml-cfg-${label}-`))
  const workDir = await mkdtemp(join(tmpdir(), `cml-work-${label}-`))
  if (stats) stats.reset()
  let run = null

  try {
    const options = armOptions(arm, {
      task,
      picked,
      cfg,
      configDir,
      workDir,
      disallowed,
      codemode,
    })
    run = await runArm({ options, prompt })
    const usage = checkArm({
      arm: label,
      result: run.result,
      initTools: run.initTools,
      expectedTools,
      cached: !UNCACHED_ARMS.includes(arm),
      mayNotComplete: (task.mayNotComplete ?? []).includes(label),
    })

    // Every arm is graded on its final answer, the floor included. The floor has
    // no tools, so a floor that passes answered from memory, and the task is not
    // measuring data access at all.
    const answer = finalAnswer(run.result, run.transcript)
    const g = grade(task, answer)
    const turns = run.turns.summary()
    const klass = answerClass({
      grade: g,
      spilledResults: turns.spilledResults,
      canReadFiles: canReadFiles(arm),
    })

    const record = {
      arm: label,
      ok: true,
      usage,
      grade: g,
      answerClass: klass,
      answer,
      ms: run.ms,
      apiMs: run.result?.duration_api_ms ?? null,
      numTurns: run.result?.num_turns ?? null,
      permissionDenials: (run.result?.permission_denials ?? []).map((d) => d.tool_name),
      // Claude Code's own figure, from its bundled price table. Kept as a cross
      // check on harness/prices.mjs, never published as a measured cost.
      claudeCodeCostUsd: run.result?.total_cost_usd ?? null,
      tools: run.initTools,
      turns,
      boundary: stats ? stats.snapshot() : null,
      transcript: run.transcript,
    }

    const outcome =
      (usage.outcome === 'did-not-complete'
        ? `DID NOT COMPLETE (${usage.subtype}${usage.usageTrustworthy ? '' : ', usage zeroed'})`
        : klass.toUpperCase()) + (usage.cacheLeak ? ' CACHE-LEAK' : '')
    console.log(
      `in=${usage.input.toLocaleString().padStart(9)} out=${usage.output.toLocaleString().padStart(6)} ` +
        `cacheR=${usage.cacheRead.toLocaleString().padStart(8)} turns=${turns.turns} ` +
        `peak=${(turns.peakPrompt ?? 0).toLocaleString()} spilled=${turns.spilledResults} ` +
        `${outcome} ${(run.ms / 1000).toFixed(1)}s`,
    )
    return record
  } catch (err) {
    const why = err instanceof AssertionFailed ? err.message : `${err.name}: ${err.message}`
    console.log(`DISCARDED  ${why}`)
    // A discarded arm is not a measurement, but its usage is how the cause is found.
    // The first Sonnet attempt threw away the per-model split of a cache it should
    // not have had, and with it the only clue.
    return {
      arm: label,
      ok: false,
      discarded: why,
      usage: run?.result ? totalUsage(run.result) : null,
      tools: run?.initTools ?? null,
      turns: run ? run.turns.summary() : null,
    }
  } finally {
    await rm(configDir, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }
}

/** The figures a sweep derives from one task's records. */
export function taskSummary(records, taskId) {
  const ok = (name) => records.find((r) => r.arm === name && r.ok)
  const floor = ok('floor')
  const aUnc = ok('A-uncached')
  const bUnc = ok('B-uncached')

  const memoryControl = floor
    ? { graded: floor.grade.graded, pass: floor.grade.pass === true }
    : null
  if (memoryControl?.pass) {
    console.log(
      `  WARNING: the floor arm passed with no tools. ${taskId} can be answered from memory, ` +
        'so its numbers do not measure data access.',
    )
  }

  return {
    memoryControl,
    definitionTax: {
      direct: definitionTax(floor?.turns.turn1Prompt, aUnc?.turns.turn1Prompt),
      codemode: definitionTax(floor?.turns.turn1Prompt, bUnc?.turns.turn1Prompt),
      note:
        'First request minus the floor arm first request, both uncached, counted by the API. ' +
        'It holds the tool definitions and any server instructions the client adds.',
    },
    extraInputOverFloor: {
      direct: extraInputOverFloor(floor?.usage, aUnc?.usage),
      codemode: extraInputOverFloor(floor?.usage, bUnc?.usage),
      note:
        'All input over the floor arm, across every turn: tool results, resent definitions and ' +
        'the arm reading its own earlier output. This is NOT the definition tax.',
    },
  }
}

export { AssertionFailed }
