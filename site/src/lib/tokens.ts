import { estimateTokens, BYTES_PER_TOKEN_ESTIMATE } from '@codemode-lab/meter'

/**
 * Token arithmetic for the page, in one place.
 *
 * This site ships no tokenizer. It counts bytes exactly and turns them into a
 * BAND, never a single number. Every call site that renders a band must also
 * render the estimate marker next to it, so a reader never sees a token figure
 * that looks measured when it is inferred.
 *
 * The wide end of the band (3.3 B/token) and the narrow end (3.8 B/token) bracket
 * what English markdown and code cost in practice. The narrow end is the divisor
 * the meter package already uses, so both arms of this repo agree on it.
 */
export const BYTES_PER_TOKEN_LOW = 3.3
export const BYTES_PER_TOKEN_HIGH = BYTES_PER_TOKEN_ESTIMATE

/** The window this page measures against. */
export const WINDOW_TOKENS = 200_000

export interface TokenBand {
  low: number
  high: number
}

/** More bytes per token means fewer tokens, so the divisors cross over. */
export function tokenBand(bytes: number): TokenBand {
  return { low: estimateTokens(bytes), high: Math.round(bytes / BYTES_PER_TOKEN_LOW) }
}

const int = new Intl.NumberFormat('en-GB')

export function formatInt(n: number): string {
  return int.format(Math.round(n))
}

/** "184,000 to 212,000 tokens", rounded so it cannot be mistaken for a count. */
export function formatBand(bytes: number, unit = 'tokens'): string {
  const { low, high } = tokenBand(bytes)
  return `${formatInt(round3(low))} to ${formatInt(round3(high))} ${unit}`.trim()
}

/** Percentage of a 200K window, as a band. */
export function windowBand(bytes: number): TokenBand {
  const { low, high } = tokenBand(bytes)
  return { low: (low / WINDOW_TOKENS) * 100, high: (high / WINDOW_TOKENS) * 100 }
}

export function formatWindowBand(bytes: number): string {
  const { low, high } = windowBand(bytes)
  const fmt = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString())
  return `${fmt(low)} to ${fmt(high)} percent`
}

/**
 * Round to three significant figures.
 *
 * An estimate printed as 184,263 claims a precision the method does not have.
 * 184,000 says what is actually known.
 */
function round3(n: number): number {
  if (n < 1000) return Math.round(n)
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 2)
  return Math.round(n / mag) * mag
}

/**
 * Wire bytes carry SSE framing and JSON escaping, so they overstate the context
 * cost. Across the seven payloads measured for this project the ratio of wire to
 * text was 1.99 to 2.13. While a payload is still arriving only the wire count
 * exists, so the bar divides by this and is drawn hatched until the exact text
 * byte count replaces it.
 */
export const PROVISIONAL_WIRE_TO_TEXT = 2.0
