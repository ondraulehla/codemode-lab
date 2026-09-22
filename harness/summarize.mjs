/**
 * Reduce a sweep to the numbers a reader should see, with their spread.
 *
 *   node harness/summarize.mjs [results/latest.json]
 *
 * It prints a table and writes results/summary-<run-id>.json next to the sweep,
 * plus results/summary-latest.json when it summarises latest.json. The project page reads
 * the summary, so every derived figure is computed here, once.
 *
 * Three things it adds over the raw sweep:
 *
 * - Spread. A single run says nothing about noise. With repetitions it reports the
 *   median and the range, and pass^k: whether an arm answered correctly in EVERY
 *   run, which is the standard tau-bench introduced for agents.
 * - Cost as a bill weights it. Input tokens alone hide the output tokens a program
 *   costs and the cache discount. Every arm also gets a list-price equivalent from
 *   harness/prices.mjs, labelled as such.
 * - A verdict per metric. On the 2026-09-21 sweep, the prediction for
 *   structure-rank held on uncached input tokens and failed on cached list price.
 *   A prediction that holds on one metric only is reported that way.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CACHE_READ, CACHE_WRITE_5M, PRICES_AS_OF, PRICES_SOURCE, listPriceUsd } from './prices.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Median, minimum and maximum of the numbers present. Null when there are none. */
export function spread(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
  return { n: xs.length, median, min: xs[0], max: xs.at(-1) }
}

/**
 * Why an arm of an old sweep failed, when the sweep did not record it.
 *
 * Schema 1 sweeps kept no record of spilled results. The tasks whose direct arm
 * could not finish declared it before the run in `mayNotComplete`, and the
 * transcripts of 2026-09-21 confirm it: those arms said they were blocked. Any
 * other failure was a wrong answer. The summary says which source it used.
 */
export function classOf(record, task) {
  if (record.answerClass) return record.answerClass
  if (!record.grade?.graded) return 'ungraded'
  if (record.grade.pass) return 'correct'
  if ((task?.mayNotComplete ?? []).includes(record.arm)) return 'no-data'
  return 'wrong'
}

/** One arm of one task, across every repetition that ran it. */
export function armStats(records, task, schemaVersion) {
  const ok = records.filter((r) => r.ok)
  const classes = {}
  for (const r of ok) {
    const c = classOf(r, task)
    classes[c] = (classes[c] ?? 0) + 1
  }
  const graded = ok.filter((r) => r.grade?.graded)
  const code = ok.filter((r) => r.boundary)
  return {
    runs: ok.length,
    discarded: records.length - ok.length,
    graded: graded.length,
    pass: graded.filter((r) => r.grade.pass).length,
    // pass^k: correct in every run. One wrong run in five is a reliability finding.
    passAll: graded.length > 0 && graded.every((r) => r.grade.pass),
    classes,
    input: spread(ok.map((r) => r.usage.input)),
    // Every input token the model read, cached or not. For an uncached arm this is
    // the same as `input`. For a cached arm, `input` alone is a few hundred tokens
    // and says nothing about how much the model read.
    promptTokens: spread(ok.map((r) => promptTokens(r.usage))),
    output: spread(ok.map((r) => r.usage.output)),
    cacheRead: spread(ok.map((r) => r.usage.cacheRead)),
    cacheCreation: spread(ok.map((r) => r.usage.cacheCreation)),
    listPriceUsd: spread(ok.map((r) => listPriceUsd(r.usage.byModel))),
    ms: spread(ok.map((r) => r.ms)),
    turns: spread(ok.map((r) => r.turns?.turns)),
    peakPrompt: spread(ok.map((r) => r.turns?.peakPrompt)),
    spilledResults: spread(ok.map((r) => r.turns?.spilledResults)),
    programs: code.length ? spread(code.map((r) => r.boundary.programs)) : null,
    calls: code.length ? spread(code.map((r) => r.boundary.calls)) : null,
    uniqueCalls: code.length ? spread(code.map((r) => r.boundary.uniqueCalls)) : null,
    // Schema 1 reset the code mode counters once per task, so the cached arm's
    // boundary figures include the uncached arm's. They are kept, and flagged.
    boundaryUnreliable: schemaVersion < 2 && records.some((r) => r.arm === 'B-cached'),
  }
}

/**
 * Code mode against one direct arm, repetition by repetition.
 *
 * Pairing by repetition keeps the comparison between runs that hit the same live
 * server at about the same time. A ratio below 1 means code mode was cheaper.
 */
export function pairStats(sweeps, codeArm, directArm, task) {
  const ratios = { usd: [], prompt: [] }
  const answers = { bothCorrect: 0, codeOnly: 0, directOnly: 0, neither: 0 }
  let reps = 0
  for (const s of sweeps) {
    const b = s.arms.find((r) => r.arm === codeArm && r.ok)
    const a = s.arms.find((r) => r.arm === directArm && r.ok)
    if (!a || !b) continue
    reps += 1
    const ua = listPriceUsd(a.usage.byModel)
    const ub = listPriceUsd(b.usage.byModel)
    if (ua && ub != null) ratios.usd.push(ub / ua)
    if (promptTokens(a.usage) > 0) ratios.prompt.push(promptTokens(b.usage) / promptTokens(a.usage))
    const ca = classOf(a, task) === 'correct'
    const cb = classOf(b, task) === 'correct'
    if (ca && cb) answers.bothCorrect += 1
    else if (cb) answers.codeOnly += 1
    else if (ca) answers.directOnly += 1
    else answers.neither += 1
  }
  if (!reps) return null
  return { reps, usdRatio: spread(ratios.usd), promptRatio: spread(ratios.prompt), answers }
}

/** The pairs every summary reports, when both arms ran. */
export const PAIRS = [
  ['B-uncached', 'A-uncached'],
  ['B-cached', 'A-cached'],
  ['B-uncached', 'A-files'],
  ['B-uncached', 'A-raw'],
  ['B-uncached', 'A-tool'],
]

/**
 * Where a ratio crosses 1x, from points sorted by payload size.
 *
 * `points` are `{ kib, ratio }`, code mode over direct. Code mode starts to pay
 * where the ratio drops below 1. The estimate interpolates in log2 of the size,
 * because the sizes are spaced by powers of two and a linear guess between 64 and
 * 256 KiB would lean towards the big end. It is an estimate between two measured
 * points, and the text says so.
 */
export function breakEven(points) {
  const xs = points
    .filter((p) => typeof p.ratio === 'number' && p.kib > 0)
    .sort((a, b) => a.kib - b.kib)
  if (!xs.length) return { kind: 'none', text: 'no points' }
  if (xs.every((p) => p.ratio < 1)) {
    return {
      kind: 'below',
      kib: xs[0].kib,
      text: `code mode cheaper at every size, from ${xs[0].kib} KiB`,
    }
  }
  if (xs.every((p) => p.ratio >= 1)) {
    const top = xs.at(-1).kib
    return { kind: 'above', kib: top, text: `code mode dearer at every size, up to ${top} KiB` }
  }
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1]
    const b = xs[i]
    if (a.ratio >= 1 && b.ratio < 1) {
      const la = Math.log2(a.kib)
      const lb = Math.log2(b.kib)
      const at = 2 ** (la + ((a.ratio - 1) / (a.ratio - b.ratio)) * (lb - la))
      return {
        kind: 'between',
        low: a.kib,
        high: b.kib,
        kib: at,
        text: `crosses 1x between ${a.kib} and ${b.kib} KiB, about ${at.toFixed(1)} KiB by interpolation`,
      }
    }
  }
  // Below 1 somewhere, but never from above: the curve is not monotone.
  return { kind: 'mixed', text: 'no single crossing: the ratio goes back and forth' }
}

/** Input tokens read, cached or not: what occupied the window across the run. */
export function promptTokens(u) {
  return (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheCreation ?? 0)
}

/**
 * Did the prediction hold on this metric? Null for a prediction recorded as uncertain.
 *
 * `margin` is how far the median sits from 1x, so a reader can see that a verdict
 * rests on 0.2% or on 80%. `overlaps` is true when repetitions landed on both sides
 * of 1x: then the median names a side, but the runs do not agree on it.
 */
export function verdict(prediction, ratio) {
  if (!ratio) return null
  const cheaper = ratio.median < 1 ? 'code mode' : 'direct'
  return {
    cheaper,
    held: prediction === 'uncertain' ? null : prediction === cheaper,
    margin: Math.abs(ratio.median - 1),
    overlaps: ratio.n > 1 && ratio.min < 1 && ratio.max > 1,
  }
}

export function summarize(report, tasksById = {}) {
  const schemaVersion = report.schemaVersion ?? 1
  const byTask = new Map()
  for (const s of report.sweeps ?? []) {
    if (s.error) continue
    if (!byTask.has(s.task)) byTask.set(s.task, [])
    byTask.get(s.task).push(s)
  }

  const tasks = [...byTask.entries()].map(([id, sweeps]) => {
    const task = tasksById[id]
    const first = sweeps[0]
    const prediction =
      first.predictionUncertain || task?.predictionUncertain
        ? 'uncertain'
        : first.expectCodeModeWins
          ? 'code mode'
          : 'direct'

    const armNames = [...new Set(sweeps.flatMap((s) => s.arms.map((r) => r.arm)))]
    const arms = Object.fromEntries(
      armNames.map((name) => [
        name,
        armStats(
          sweeps.flatMap((s) => s.arms.filter((r) => r.arm === name)),
          task,
          schemaVersion,
        ),
      ]),
    )

    const pairs = {}
    for (const [code, direct] of PAIRS) {
      const p = pairStats(sweeps, code, direct, task)
      if (p) pairs[`${code} vs ${direct}`] = p
    }

    const unc = pairs['B-uncached vs A-uncached']
    const cac = pairs['B-cached vs A-cached']
    const memory = sweeps.map((s) => s.memoryControl).filter(Boolean)

    return {
      task: id,
      prediction,
      reps: sweeps.length,
      // Crossover points carry their size and shard count. Live tasks carry none.
      meta: first.meta ?? null,
      arms,
      pairs,
      verdicts: {
        inputUncached: verdict(prediction, unc?.promptRatio),
        listPriceUncached: verdict(prediction, unc?.usdRatio),
        listPriceCached: verdict(prediction, cac?.usdRatio),
      },
      // Old sweeps did not grade the floor, so the control is unknown, not passed.
      memoryControl: memory.length
        ? { runs: memory.length, passedFromMemory: memory.filter((m) => m.pass).length }
        : null,
      definitionTax: spreadOf(sweeps, (s) => s.definitionTax),
    }
  })

  return {
    schemaVersion: 1,
    source: {
      runId: report.runId,
      model: report.model,
      effort: report.effort ?? null,
      startedAt: report.startedAt,
      sweepSchemaVersion: schemaVersion,
      reps: Math.max(0, ...tasks.map((t) => t.reps)),
    },
    prices: {
      asOf: PRICES_AS_OF,
      source: PRICES_SOURCE,
      cacheWrite5m: CACHE_WRITE_5M,
      cacheRead: CACHE_READ,
      label: 'list-price equivalent of billed tokens, not a cost that was paid',
    },
    tasks,
  }
}

function spreadOf(sweeps, pick) {
  const taxes = sweeps.map(pick).filter(Boolean)
  if (!taxes.length) return null
  return {
    direct: spread(taxes.map((t) => t.direct)),
    codemode: spread(taxes.map((t) => t.codemode)),
  }
}

// ---------------------------------------------------------------- the command

function loadTasks(ids) {
  const out = {}
  for (const id of ids) {
    try {
      out[id] = JSON.parse(readFileSync(join(ROOT, 'tasks', id, 'task.json'), 'utf8'))
    } catch {
      // A task that no longer exists is summarised without its definition.
    }
  }
  return out
}

const fmt = (x, d = 0) =>
  x == null ? '-' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d })
const range = (s, d = 0) =>
  s == null
    ? '-'
    : s.n > 1
      ? `${fmt(s.median, d)} (${fmt(s.min, d)} to ${fmt(s.max, d)})`
      : fmt(s.median, d)

function print(summary) {
  const src = summary.source
  console.log(
    `\nsummary of ${src.runId}: ${src.model}, effort ${src.effort ?? '?'}, ${src.reps} rep(s)`,
  )
  console.log(
    `list-price equivalent at prices of ${summary.prices.asOf}, not a cost that was paid\n`,
  )
  for (const t of summary.tasks) {
    console.log(`${t.task}  (predicted: ${t.prediction}, reps ${t.reps})`)
    for (const [name, a] of Object.entries(t.arms)) {
      const classes = Object.entries(a.classes)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
      console.log(
        `  ${name.padEnd(11)} in ${range(a.input).padEnd(26)} out ${range(a.output).padEnd(20)} ` +
          `$ ${range(a.listPriceUsd, 4).padEnd(26)} turns ${range(a.turns).padEnd(6)} ${classes}` +
          `${a.passAll ? '  pass^k' : ''}`,
      )
    }
    for (const [name, p] of Object.entries(t.pairs)) {
      console.log(
        `  ${name.padEnd(26)} $ ratio ${range(p.usdRatio, 2).padEnd(22)} prompt token ratio ${range(p.promptRatio, 2)}`,
      )
    }
    const v = t.verdicts
    const say = (x) =>
      x == null
        ? '-'
        : `${x.cheaper} cheaper${x.held == null ? '' : x.held ? ', held' : ', NOT held'}`
    console.log(
      `  verdict: input uncached: ${say(v.inputUncached)} | list price uncached: ${say(v.listPriceUncached)} | list price cached: ${say(v.listPriceCached)}`,
    )
    if (t.memoryControl?.passedFromMemory) {
      console.log(
        `  WARNING: the floor answered from memory in ${t.memoryControl.passedFromMemory} run(s)`,
      )
    }
    console.log()
  }
}

function main() {
  const file = resolve(process.argv[2] ?? join(ROOT, 'results', 'latest.json'))
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const summary = summarize(report, loadTasks([...new Set(report.sweeps.map((s) => s.task))]))
  print(summary)

  const dir = dirname(file)
  const out = join(dir, `summary-${report.runId}.json`)
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)
  if (basename(file) === 'latest.json') {
    writeFileSync(join(dir, 'summary-latest.json'), `${JSON.stringify(summary, null, 2)}\n`)
  }
  console.log(`written: ${out}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
