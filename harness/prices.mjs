/**
 * List prices, in US dollars per million tokens.
 *
 * They turn billed token counts into a list-price equivalent, so arms can be
 * compared with output and cache tokens weighted the way an API bill weights them.
 * Input tokens alone hide both: code mode writes programs, which are output tokens,
 * and output costs five times as much as input on every model below.
 *
 * Source: Anthropic's published price table, as of the date below. A subscription
 * run is not billed in dollars at all, so every figure made from this table is a
 * list-price equivalent, never a cost somebody paid. Update the table and the date
 * together, or not at all.
 */
export const PRICES_AS_OF = '2026-06-24'
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'

export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/**
 * Cache multipliers on the input price.
 *
 * A five minute cache write bills at 1.25x and a cache read at 0.1x. The harness
 * pins the five minute bucket and asserts that the one hour bucket never ran, so
 * the one hour write price never applies here.
 */
export const CACHE_WRITE_5M = 1.25
export const CACHE_READ = 0.1

/** The price row for a model id, dated snapshot ids included. */
export function priceFor(model) {
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(`${k}-`))
  return key ? PRICES[key] : null
}

/**
 * The list-price equivalent of one arm, from its per-model usage.
 *
 * Returns null when any model in the usage has no price row. A partial sum would
 * look like a complete one.
 */
export function listPriceUsd(byModel) {
  let usd = 0
  for (const [model, u] of Object.entries(byModel ?? {})) {
    const p = priceFor(model)
    if (!p) return null
    usd +=
      ((u.input ?? 0) * p.input +
        (u.output ?? 0) * p.output +
        (u.cacheCreation ?? 0) * p.input * CACHE_WRITE_5M +
        (u.cacheRead ?? 0) * p.input * CACHE_READ) /
      1e6
  }
  return usd
}
