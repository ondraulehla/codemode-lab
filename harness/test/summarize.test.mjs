import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listPriceUsd, priceFor } from '../prices.mjs'
import { classOf, pairStats, promptTokens, spread, summarize, verdict } from '../summarize.mjs'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const SWEEP = JSON.parse(readFileSync(root('results/sweep-2026-09-21T19-48-37-498Z.json'), 'utf8'))
const TASKS = Object.fromEntries(
  ['one-big-payload', 'outline-leaves', 'structure-rank', 'table-heavy-page', 'topic-overlap'].map(
    (id) => [id, JSON.parse(readFileSync(root(`tasks/${id}/task.json`), 'utf8'))],
  ),
)

describe('spread', () => {
  it('gives the median of odd and even counts and skips missing values', () => {
    expect(spread([3, 1, 2])).toEqual({ n: 3, median: 2, min: 1, max: 3 })
    expect(spread([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 })
    expect(spread([null, undefined, 5])).toEqual({ n: 1, median: 5, min: 5, max: 5 })
    expect(spread([])).toBeNull()
  })
})

describe('prices', () => {
  it('finds the row for dated and undated ids, longest prefix first', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 })
    expect(priceFor('claude-opus-5')).toEqual({ input: 5, output: 25 })
    // Not the Opus 5 row: the longer id wins.
    expect(priceFor('claude-opus-5-5')).toEqual({ input: 4, output: 20 })
    expect(priceFor('gpt-4.1')).toBeNull()
  })

  it('weights output at five times input and caches at 1.25x and 0.1x', () => {
    const usd = listPriceUsd({
      'claude-opus-5': {
        input: 1_000_000,
        output: 1_000_000,
        cacheCreation: 1_000_000,
        cacheRead: 1_000_000,
      },
    })
    expect(usd).toBeCloseTo(5 + 25 + 6.25 + 0.5, 10)
  })

  it('refuses to price a run that used a model it has no row for', () => {
    expect(
      listPriceUsd({ 'claude-opus-5': { input: 1 }, 'mystery-model': { input: 1 } }),
    ).toBeNull()
  })
})

describe('the 2026-09-21 sweep, summarised', () => {
  const summary = summarize(SWEEP, TASKS)
  const task = (id) => summary.tasks.find((t) => t.task === id)

  it('reports a prediction that holds on one metric and not on another', () => {
    // The finding the old scoreboard could not show: structure-rank was predicted
    // to lose, and it did lose on uncached input tokens, but cached and at list
    // price code mode was the cheaper arm.
    const v = task('structure-rank').verdicts
    expect(v.inputUncached).toMatchObject({ cheaper: 'direct', held: true, overlaps: false })
    expect(v.inputUncached.margin).toBeCloseTo(8275 / 8133 - 1, 6)
    expect(v.listPriceCached).toMatchObject({ cheaper: 'code mode', held: false })
  })

  it('shows outline-leaves losing by more at list price than on input tokens', () => {
    const p = task('outline-leaves').pairs['B-uncached vs A-uncached']
    expect(p.promptRatio.median).toBeCloseTo(5860 / 5665, 6)
    expect(p.usdRatio.median).toBeGreaterThan(1.1)
  })

  it('calls the topic-overlap direct arm wrong, and the big tasks no-data', () => {
    // The published scoreboard said "no answer" for all three. Only two of them
    // never saw the data. topic-overlap answered, with the wrong counts.
    expect(task('topic-overlap').arms['A-uncached'].classes).toEqual({ wrong: 1 })
    expect(task('table-heavy-page').arms['A-uncached'].classes).toEqual({ 'no-data': 1 })
    expect(task('one-big-payload').arms['A-cached'].classes).toEqual({ 'no-data': 1 })
  })

  it('does not call an uncertain prediction held', () => {
    expect(task('topic-overlap').prediction).toBe('uncertain')
    expect(task('topic-overlap').verdicts.inputUncached.held).toBeNull()
  })

  it('flags the old boundary figures of the cached code mode arm', () => {
    expect(task('one-big-payload').arms['B-cached'].boundaryUnreliable).toBe(true)
    expect(summary.source.sweepSchemaVersion).toBe(1)
  })

  it('has no memory control for a sweep that did not grade the floor', () => {
    expect(task('outline-leaves').memoryControl).toBeNull()
  })
})

describe('pairs and verdicts', () => {
  const arm = (name, input, pass) => ({
    arm: name,
    ok: true,
    usage: {
      input,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      byModel: { 'claude-opus-5': { input } },
    },
    grade: { graded: true, pass },
  })

  it('pairs by repetition and reads a ratio below 1 as code mode cheaper', () => {
    const sweeps = [
      { arms: [arm('A-uncached', 1000, true), arm('B-uncached', 500, true)] },
      { arms: [arm('A-uncached', 1000, false), arm('B-uncached', 700, true)] },
    ]
    const p = pairStats(sweeps, 'B-uncached', 'A-uncached', {})
    expect(p.reps).toBe(2)
    expect(p.promptRatio.median).toBeCloseTo(0.6, 10)
    expect(p.answers).toEqual({ bothCorrect: 1, codeOnly: 1, directOnly: 0, neither: 0 })
    expect(verdict('code mode', p.promptRatio)).toMatchObject({ cheaper: 'code mode', held: true })
    expect(verdict('direct', p.promptRatio)).toMatchObject({ cheaper: 'code mode', held: false })
    // Both runs came out below 1x, so they agree on a side.
    expect(verdict('direct', p.promptRatio).overlaps).toBe(false)
  })

  it('flags repetitions that landed on both sides of 1x', () => {
    const v = verdict('direct', { n: 3, median: 1.01, min: 0.9, max: 1.2 })
    expect(v).toMatchObject({ cheaper: 'direct', held: true, overlaps: true })
  })

  it('counts cached tokens as tokens read', () => {
    expect(promptTokens({ input: 10, cacheRead: 4000, cacheCreation: 900 })).toBe(4910)
  })

  it('falls back to the task declaration for a schema 1 failure', () => {
    const task = { mayNotComplete: ['A-uncached'] }
    expect(classOf({ arm: 'A-uncached', grade: { graded: true, pass: false } }, task)).toBe(
      'no-data',
    )
    expect(classOf({ arm: 'A-cached', grade: { graded: true, pass: false } }, task)).toBe('wrong')
    expect(classOf({ arm: 'A-cached', answerClass: 'no-data', grade: {} }, task)).toBe('no-data')
  })
})
