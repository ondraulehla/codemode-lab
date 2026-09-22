import { describe, expect, it } from 'vitest'
import { runInNodeSandbox } from '@codemode-lab/runtime/node'
import { generateSurface } from '@codemode-lab/typegen'
import { breakEven, summarize } from '../summarize.mjs'
import { CROSSOVER_ARMS } from '../crossover.mjs'
import { TARGET, groundTruth, makeRows, ordersTask } from '../synthetic/orders.mjs'
import {
  expectedMatches,
  getOrders,
  mcpTools,
  queryOrders,
  toolTable,
} from '../synthetic/server.mjs'

const utf8 = (s) => new TextEncoder().encode(s).length

/** Recount the answer from the served text alone, the way a careful reader would. */
function recount(task) {
  const rows = task.texts
    .flatMap((t) => t.split('\n'))
    .filter((l) => l.startsWith('| ORD-'))
    .map((l) => {
      const [id, region, status, amount] = l
        .split('|')
        .slice(1, 5)
        .map((c) => c.trim())
      return { id, region, status, amount: Number(amount) }
    })
  const hits = rows.filter((r) => r.region === TARGET.region && r.status === TARGET.status)
  const top = hits.reduce((a, b) => (b.amount > a.amount ? b : a))
  return { count: hits.length, id: top.id }
}

/** The program a code mode arm should write, run for real in the sandbox. */
const PROGRAM = `
let count = 0
let best = null
for (let shard = 0; ; shard++) {
  const text = await synthetic.get_orders({ shard })
  if (text.startsWith('No shard')) break
  for (const line of text.split('\\n')) {
    if (!line.startsWith('| ORD-')) continue
    const [id, region, status, amount] = line.split('|').slice(1, 5).map((c) => c.trim())
    if (region !== 'north' || status !== 'refunded') continue
    count += 1
    if (!best || Number(amount) > best.amount) best = { id, amount: Number(amount) }
  }
}
return 'count=' + count + ' id=' + best.id
`

describe('the synthetic orders task', () => {
  it('is the same on every run for the same size, shards and seed', () => {
    const a = ordersTask({ kib: 16, shards: 4, seed: 3 })
    const b = ordersTask({ kib: 16, shards: 4, seed: 3 })
    expect(a.texts).toEqual(b.texts)
    expect(a.truth).toEqual(b.truth)
    expect(ordersTask({ kib: 16, shards: 4, seed: 4 }).truth).not.toEqual(a.truth)
  })

  it('serves the size it was asked for', () => {
    for (const kib of [4, 16, 64, 256]) {
      const t = ordersTask({ kib })
      // Within 2%: a size is reached one row at a time, and the header adds a little.
      expect(Math.abs(t.bytes - kib * 1024) / (kib * 1024)).toBeLessThan(0.02)
    }
  })

  it('always has an answer, even at 1 KiB', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const t = ordersTask({ kib: 1, seed })
      expect(t.truth.count).toBeGreaterThan(0)
    }
  })

  it('computes the answer the served text supports', () => {
    for (const [kib, shards] of [
      [4, 1],
      [64, 1],
      [64, 8],
    ]) {
      const t = ordersTask({ kib, shards })
      expect(recount(t)).toEqual({ count: t.truth.count, id: t.truth.id })
    }
  })

  it('has distinct ids and amounts, so "the largest" names one order', () => {
    const rows = makeRows({ bytes: 64 * 1024 })
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    expect(new Set(rows.map((r) => r.amount)).size).toBe(rows.length)
    expect(groundTruth(rows).id).toMatch(/^ORD-[0-9A-F]{6}$/)
  })

  it('splits the export into shards without losing a row', () => {
    const one = ordersTask({ kib: 32, shards: 1 })
    const four = ordersTask({ kib: 32, shards: 4 })
    expect(four.texts).toHaveLength(4)
    const rowsOf = (t) =>
      t.texts.flatMap((x) => x.split('\n')).filter((l) => l.startsWith('| ORD-'))
    expect(rowsOf(four)).toEqual(rowsOf(one))
  })

  it('never puts a grading string in its question', () => {
    const t = ordersTask({ kib: 16 })
    for (const s of t.expect.mustMention) expect(t.question).not.toContain(s)
    expect(t.expect.mustMention).toEqual([`count=${t.truth.count}`, `id=${t.truth.id}`])
  })
})

describe('the synthetic server', () => {
  const task = ordersTask({ kib: 16, shards: 2 })

  it('serves a shard, and says so when the shard does not exist', () => {
    expect(getOrders(task, { shard: 1 })).toBe(task.texts[1])
    expect(getOrders(task, { shard: 2 })).toMatch(/^No shard 2\./)
    expect(getOrders(task, {})).toMatch(/^No shard/)
  })

  it('filters on the server for the narrower tool', () => {
    const out = queryOrders(task, TARGET)
    const rows = out.split('\n').filter((l) => l.startsWith('| ORD-'))
    expect(rows).toEqual(expectedMatches(task))
    expect(rows).toHaveLength(task.truth.count)
    expect(utf8(out)).toBeLessThan(task.bytes)
  })

  it('declares a surface a model can write against', () => {
    const s = generateSurface('synthetic', mcpTools)
    expect(s.source).toContain('export function get_orders(args: {')
    expect(s.source).toContain('Promise<string>')
  })

  it('answers correctly through the sandbox, for one shard and for many', async () => {
    for (const shards of [1, 8]) {
      const t = ordersTask({ kib: 64, shards })
      const r = await runInNodeSandbox(PROGRAM, { tools: toolTable(t), timeoutMs: 20_000 })
      expect(r.ok, r.error).toBe(true)
      expect(r.value).toBe(`count=${t.truth.count} id=${t.truth.id}`)
    }
  })
})

describe('breakEven', () => {
  it('interpolates the crossing in log2 of the size', () => {
    const be = breakEven([
      { kib: 4, ratio: 1.2 },
      { kib: 16, ratio: 0.8 },
      { kib: 64, ratio: 0.3 },
    ])
    expect(be.kind).toBe('between')
    expect([be.low, be.high]).toEqual([4, 16])
    // Half way in ratio is half way in log2(size): 2^3 = 8 KiB.
    expect(be.kib).toBeCloseTo(8, 10)
  })

  it('says when there is no crossing in the measured range', () => {
    expect(
      breakEven([
        { kib: 1, ratio: 0.9 },
        { kib: 4, ratio: 0.5 },
      ]).kind,
    ).toBe('below')
    expect(
      breakEven([
        { kib: 1, ratio: 1.3 },
        { kib: 4, ratio: 1.1 },
      ]).kind,
    ).toBe('above')
    expect(breakEven([]).kind).toBe('none')
  })

  it('reports the first downward crossing, and no crossing for a curve that only rises', () => {
    expect(
      breakEven([
        { kib: 1, ratio: 0.9 },
        { kib: 4, ratio: 1.2 },
        { kib: 16, ratio: 0.8 },
      ]).kind,
    ).toBe('between')
    expect(
      breakEven([
        { kib: 1, ratio: 0.9 },
        { kib: 4, ratio: 1.2 },
      ]).kind,
    ).toBe('mixed')
  })
})

describe('the crossover report', () => {
  it('passes each point size through the summary', () => {
    const arm = (name, input) => ({
      arm: name,
      ok: true,
      usage: {
        input,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        byModel: { 'claude-opus-5': { input } },
      },
      grade: { graded: true, pass: true },
    })
    const report = {
      schemaVersion: 2,
      sweeps: [4, 16].map((kib) => ({
        rep: 0,
        task: `orders-${kib}KiB-1x`,
        meta: { kib, shards: 1 },
        arms: [arm('A-uncached', 1000 * kib), arm('B-uncached', 8000)],
      })),
    }
    const s = summarize(report)
    expect(s.tasks.map((t) => t.meta.kib)).toEqual([4, 16])
    const be = breakEven(
      s.tasks.map((t) => ({
        kib: t.meta.kib,
        ratio: t.pairs['B-uncached vs A-uncached'].usdRatio.median,
      })),
    )
    // 8000 / 4000 = 2x at 4 KiB, 8000 / 16000 = 0.5x at 16 KiB.
    expect(be.kind).toBe('between')
  })

  it('runs every arm the verdict of scan names, plus the controls', () => {
    expect(CROSSOVER_ARMS).toEqual(
      expect.arrayContaining(['floor', 'A-files', 'A-raw', 'A-tool', 'B-uncached', 'B-cached']),
    )
  })
})
