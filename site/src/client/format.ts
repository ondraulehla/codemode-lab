import { formatBytes } from '@codemode-lab/meter'
import { formatBand, formatInt, tokenBand, WINDOW_TOKENS } from '../lib/tokens'

export { formatBytes, formatBand, formatInt, tokenBand, WINDOW_TOKENS }

/** Escape text before it goes into innerHTML. Server text is never trusted here. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The marker that must sit next to every token figure on this page. */
export const EST = `<abbr class="est" title="This page counts bytes exactly and estimates tokens from them at 3.3 to 3.8 bytes per token. No tokenizer runs here, so the figure is a band, not a count.">est</abbr>`

/** "683.7 kB · 184,000 to 212,000 tokens est" */
export function bytesAndBand(bytes: number): string {
  return `${formatBytes(bytes)} · ${esc(formatBand(bytes))}${EST}`
}

export function percentOfWindow(bytes: number): { low: number; high: number } {
  const band = tokenBand(bytes)
  return { low: (band.low / WINDOW_TOKENS) * 100, high: (band.high / WINDOW_TOKENS) * 100 }
}

export function formatPercentBand(bytes: number): string {
  const { low, high } = percentOfWindow(bytes)
  const one = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString())
  return `${one(low)} to ${one(high)} percent`
}
