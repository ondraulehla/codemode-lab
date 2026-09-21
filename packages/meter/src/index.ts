/**
 * The one place in this repo that counts bytes.
 *
 * Nothing in `site/` computes a number. It renders numbers this package measured
 * and numbers the CI harness billed. Keeping the measurement in one module is the
 * whole reason a reader can trust the figures on the page.
 */

/** One tool call, measured at the boundary it crossed. */
export interface CallRecord {
  /** Monotonic index within a run, so a trace can be replayed in order. */
  seq: number
  /** Which MCP server answered. */
  server: string
  /** Tool name as the server advertises it. */
  tool: string
  /** JSON byte length of the arguments we sent. */
  argsBytes: number
  /**
   * Bytes that came back on the wire, SSE framing included.
   * This is what a proxy or a browser devtools panel would show.
   */
  wireBytes: number
  /**
   * Bytes of the text content inside the result.
   * This is what would actually enter a model's context window.
   */
  textBytes: number
  /** Wall clock time of the call. */
  ms: number
  /** Present when the server returned a JSON-RPC error or the transport failed. */
  error?: string
}

/** What a caller crossed the sandbox boundary with, in aggregate. */
export interface MeterTotals {
  calls: number
  argsBytes: number
  wireBytes: number
  textBytes: number
  ms: number
  errors: number
}

/**
 * Collects `CallRecord`s and hands them to a listener as they land.
 *
 * The listener is how the demo page animates a counter while a 1.4 MB payload
 * is still arriving. Nothing here is async: recording must never change timing.
 */
export class Meter {
  readonly records: CallRecord[] = []
  private seq = 0
  private listeners = new Set<(r: CallRecord) => void>()

  /** Subscribe to records. Returns an unsubscribe function. */
  onRecord(fn: (r: CallRecord) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Record one call. `seq` is assigned here so callers cannot skew the order. */
  record(r: Omit<CallRecord, 'seq'>): CallRecord {
    const full: CallRecord = { ...r, seq: this.seq++ }
    this.records.push(full)
    for (const fn of this.listeners) fn(full)
    return full
  }

  get totals(): MeterTotals {
    return this.records.reduce<MeterTotals>(
      (t, r) => ({
        calls: t.calls + 1,
        argsBytes: t.argsBytes + r.argsBytes,
        wireBytes: t.wireBytes + r.wireBytes,
        textBytes: t.textBytes + r.textBytes,
        ms: t.ms + r.ms,
        errors: t.errors + (r.error ? 1 : 0),
      }),
      { calls: 0, argsBytes: 0, wireBytes: 0, textBytes: 0, ms: 0, errors: 0 },
    )
  }

  reset(): void {
    this.records.length = 0
    this.seq = 0
  }
}

/**
 * Byte length of a string as UTF-8, which is what travels and what gets tokenized.
 * `String.length` counts UTF-16 code units and would undercount non-ASCII docs.
 */
const encoder = new TextEncoder()
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

/**
 * A rough token estimate, only for labels that say "estimate" next to them.
 *
 * Real token counts in this repo come from the Anthropic API. This exists so the
 * browser can show an order of magnitude without shipping a tokenizer, and every
 * call site is required to mark the number as an estimate.
 *
 * The divisor is the observed bytes-per-token ratio for English markdown and code.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 3.8
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN_ESTIMATE)
}

/** Human byte formatting, used by the CLI and the page alike. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
