/**
 * A dataset whose size the caller sets and whose answer is known.
 *
 * The live tasks answer "does code mode win on these five questions". They cannot
 * answer "at what payload size does it start to win", because a live server does
 * not return a payload of a chosen size. This generator does: an order export of
 * any size, split into any number of shards, with one question whose answer is
 * computed here and graded exactly.
 *
 * Two properties matter more than realism.
 *
 * - The answer cannot come from memory. Order ids are random hex, so a model that
 *   calls no tool cannot produce one. The floor arm checks that on every run.
 * - The answer needs every row. The question filters on two columns and takes a
 *   maximum, so a program must read the whole table, and so must a model.
 *
 * Everything is deterministic: the same size, shard count and seed give the same
 * bytes and the same answer on every machine.
 */

export const REGIONS = ['north', 'south', 'east', 'west', 'central']
export const STATUSES = ['paid', 'pending', 'refunded', 'cancelled', 'shipped']

/** The pair the question asks about. */
export const TARGET = { region: 'north', status: 'refunded' }

/** A small, well known PRNG. Seeded, so the dataset is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const encoder = new TextEncoder()
const utf8 = (s) => encoder.encode(s).length

const HEADER = ['| id | region | status | amount |', '| --- | --- | --- | ---: |']

/** One markdown table row. */
export const rowLine = (r) => `| ${r.id} | ${r.region} | ${r.status} | ${r.amount.toFixed(2)} |`

/**
 * Generate rows until the table reaches `bytes`.
 *
 * Amounts are distinct, so "the largest amount" names exactly one order. At least
 * one row matches the target pair, so the question always has an answer, however
 * small the table. Which row is made to match is chosen by the same seeded PRNG.
 */
export function makeRows({ bytes, seed = 1 }) {
  const rand = mulberry32((seed * 2654435761) ^ bytes)
  const pick = (xs) => xs[Math.floor(rand() * xs.length)]
  const seenIds = new Set()
  const seenAmounts = new Set()
  const rows = []
  let size = utf8(HEADER.join('\n'))

  while (size < bytes || rows.length === 0) {
    let id
    do
      id = `ORD-${Math.floor(rand() * 0xffffff)
        .toString(16)
        .toUpperCase()
        .padStart(6, '0')}`
    while (seenIds.has(id))
    seenIds.add(id)

    let cents
    do cents = 100 + Math.floor(rand() * 99_900)
    while (seenAmounts.has(cents))
    seenAmounts.add(cents)

    const row = { id, region: pick(REGIONS), status: pick(STATUSES), amount: cents / 100 }
    rows.push(row)
    size += utf8(rowLine(row)) + 1
  }

  if (!rows.some(matches)) {
    const k = Math.floor(rand() * rows.length)
    // This moves the table size by a few bytes. The task reports the size of the
    // text it actually serves, so no figure depends on the target size exactly.
    rows[k] = { ...rows[k], ...TARGET }
  }
  return rows
}

export function matches(r) {
  return r.region === TARGET.region && r.status === TARGET.status
}

/** Split rows into `shards` contiguous parts of near equal length. */
export function shardRows(rows, shards) {
  const out = []
  const per = Math.ceil(rows.length / shards)
  for (let i = 0; i < shards; i++) out.push(rows.slice(i * per, (i + 1) * per))
  return out
}

/** The text one call returns for one shard. */
export function shardText(rows, shard, shards) {
  return [`# Orders export, shard ${shard} of ${shards}`, '', ...HEADER, ...rows.map(rowLine)].join(
    '\n',
  )
}

/** The answer, computed from the rows, never from the text. */
export function groundTruth(rows) {
  const hits = rows.filter(matches)
  const top = hits.reduce((a, b) => (b.amount > a.amount ? b : a))
  return { count: hits.length, id: top.id, amount: top.amount }
}

/**
 * One synthetic task: the dataset, its shards, the question and the grading.
 *
 * `kib` is the total size of all shards together, in KiB. The answer format is
 * fixed, `count=<n> id=<id>`, so a substring grader cannot be fooled by a digit that
 * happens to appear elsewhere in the answer.
 */
export function ordersTask({ kib, shards = 1, seed = 1 }) {
  const bytes = Math.round(kib * 1024)
  const rows = makeRows({ bytes, seed })
  const parts = shardRows(rows, shards)
  const texts = parts.map((p, i) => shardText(p, i, shards))
  const truth = groundTruth(rows)

  const split =
    shards === 1
      ? 'The tool returns the whole export in one call: call it with shard 0.'
      : `The export is split into ${shards} shards, numbered 0 to ${shards - 1}. ` +
        'Each call returns one shard.'

  return {
    id: `orders-${kib}KiB-${shards}x`,
    kib,
    shards,
    seed,
    bytes: texts.reduce((n, t) => n + utf8(t), 0),
    rows: rows.length,
    texts,
    truth,
    question:
      'The orders tool returns an export of customer orders as markdown tables. ' +
      `${split} ` +
      `Count the orders whose region is "${TARGET.region}" and whose status is ` +
      `"${TARGET.status}". Of those orders, find the one with the largest amount. ` +
      'Answer in exactly this form and nothing else: count=<number> id=<order id>',
    expect: {
      mustMention: [`count=${truth.count}`, `id=${truth.id}`],
      note: 'Generated and computed by harness/synthetic/orders.mjs. The ids are random, so no model knows them.',
    },
  }
}
