import { McpClient, type McpTool } from '@codemode-lab/mcp-client'
import { Meter, formatBytes, estimateTokens, utf8Bytes } from '@codemode-lab/meter'
import { generateSurface, schemaSurfaceBytes } from '@codemode-lab/typegen'

/**
 * What one MCP server costs, both ways round.
 *
 * Every other tool in this space measures the definition tax: how many tokens the
 * tool schemas take before any work happens. That number is real and it is small.
 * On the three keyless servers this repo tracks it totals about 3,000 tokens.
 *
 * Nobody measures the other number. A single `read_wiki_contents` call on DeepWiki
 * returns 274 kB to 728 kB of text, which is 74,000 to 226,000 tokens depending on
 * the tokenizer's ratio. That is the term that decides whether a task is possible.
 */
export interface ScanReport {
  server: string
  url: string
  mode: 'stateless' | 'session'
  toolCount: number
  /** Raw tools/list JSON bytes: the definition tax as a direct-calling client pays it. */
  schemaBytes: number
  /** Generated .d.ts bytes: the definition tax as a code mode client pays it. */
  surfaceBytes: number
  probes: PayloadProbe[]
  warnings: string[]
}

export interface PayloadProbe {
  tool: string
  args: Record<string, unknown>
  wireBytes: number
  textBytes: number
  ms: number
  error?: string
}

/** Tools we will never call automatically: they cost the provider money. */
const EXPENSIVE = /^(ask|chat|complete|generate|run|create|delete|update|write|post|send)/i

/**
 * Choose probe arguments for a tool from its own schema.
 *
 * This is deliberately conservative. A tool whose name suggests it spends the
 * provider's money is skipped, and a tool with a required argument we cannot
 * invent is skipped too. Reporting "not probed" is better than inventing a call.
 */
export function planProbes(
  tools: McpTool[],
  hints: Record<string, Record<string, unknown>> = {},
): { tool: string; args: Record<string, unknown> }[] {
  const plan: { tool: string; args: Record<string, unknown> }[] = []

  for (const tool of tools) {
    if (hints[tool.name]) {
      plan.push({ tool: tool.name, args: hints[tool.name] })
      continue
    }
    if (EXPENSIVE.test(tool.name)) continue
    if (tool.annotations?.readOnlyHint === false) continue

    const schema = tool.inputSchema ?? {}
    const required = schema.required ?? []
    const props = schema.properties ?? {}

    const args: Record<string, unknown> = {}
    let ok = true
    for (const key of required) {
      const p = props[key]
      const t = Array.isArray(p?.type) ? p?.type[0] : p?.type
      if (Array.isArray(p?.enum) && p.enum.length) args[key] = p.enum[0]
      else if (t === 'string') args[key] = GENERIC_QUERY
      else if (t === 'number' || t === 'integer') args[key] = 1
      else if (t === 'boolean') args[key] = false
      else ok = false
    }
    if (ok) plan.push({ tool: tool.name, args })
  }
  return plan
}

/** A query broad enough to return something on a docs server, harmless everywhere. */
const GENERIC_QUERY = 'getting started'

export async function scanServer(
  url: string,
  opts: {
    name?: string
    headers?: Record<string, string>
    probe?: boolean
    hints?: Record<string, Record<string, unknown>>
  } = {},
): Promise<ScanReport> {
  const meter = new Meter()
  const client = new McpClient({ url, name: opts.name, headers: opts.headers, meter })
  const tools = await client.connect()

  const surface = generateSurface(opts.name ?? new URL(url).hostname, tools)
  const probes: PayloadProbe[] = []

  if (opts.probe !== false) {
    for (const { tool, args } of planProbes(tools, opts.hints)) {
      try {
        await client.callTool(tool, args)
        const r = meter.records.at(-1)!
        probes.push({
          tool,
          args,
          wireBytes: r.wireBytes,
          textBytes: r.textBytes,
          ms: Math.round(r.ms),
        })
      } catch (err) {
        probes.push({
          tool,
          args,
          wireBytes: 0,
          textBytes: 0,
          ms: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return {
    server: client.name,
    url,
    mode: client.mode ?? 'stateless',
    toolCount: tools.length,
    schemaBytes: schemaSurfaceBytes(tools),
    surfaceBytes: surface.bytes,
    probes,
    warnings: surface.warnings,
  }
}

/**
 * The verdict line.
 *
 * One sentence a reader can act on, derived only from what was measured. It never
 * claims a token count as fact: the ratio band is stated, because this repo does
 * not ship a tokenizer and will not pretend it measured what it estimated.
 */
export function verdict(report: ScanReport, windowTokens = 200_000): string {
  const biggest = report.probes.filter((p) => !p.error).sort((a, b) => b.textBytes - a.textBytes)[0]
  if (!biggest) return `${report.server}: ${report.toolCount} tools, no payload probed.`

  const lo = Math.round(biggest.textBytes / 3.8)
  const hi = Math.round(biggest.textBytes / 3.3)
  const pctLo = Math.round((lo / windowTokens) * 100)
  const pctHi = Math.round((hi / windowTokens) * 100)

  const defTokens = estimateTokens(report.schemaBytes)
  const defPct = Math.round((defTokens / windowTokens) * 100)

  // Two shapes of server, and the ratio only reads well in one of them. DeepWiki's
  // largest result is 459x its definitions. Apify's definitions are 7x its largest
  // result. Printing "0x" for the second is arithmetic, not an answer.
  const ratio =
    biggest.textBytes >= report.schemaBytes
      ? `${Math.round(biggest.textBytes / report.schemaBytes)}x the entire tool definition surface`
      : `${(report.schemaBytes / biggest.textBytes).toFixed(1)}x SMALLER than the tool definitions`

  const head =
    `${report.server}: ${report.toolCount} tools cost about ${defTokens.toLocaleString()} tokens to declare, ` +
    `which is ${defPct}% of a ${windowTokens / 1000}K window. ` +
    `Its largest probed result, ${biggest.tool}, returned ${formatBytes(biggest.textBytes)} of text, ` +
    `roughly ${lo.toLocaleString()} to ${hi.toLocaleString()} tokens, ` +
    `which is ${pctLo}% to ${pctHi}% of the window and ${ratio}.`

  if (pctLo >= 100)
    return `${head} One call does not fit. Code mode is not an optimisation here, it is the only way to run the task.`
  if (pctLo >= 25)
    return `${head} Two or three calls exhaust the window. Filtering inside a sandbox is the difference between possible and not.`
  if (defPct >= 5) {
    return (
      `${head} This is the inverted case: the definitions are the expensive term, not the results. ` +
      `Prompt caching bills a cached prefix at about a tenth, but a cached prefix still OCCUPIES the window. ` +
      `Loading fewer tools, or reaching them through code, is what gives the window back.`
    )
  }
  return `${head} Payloads are small on this server, so code mode will mostly cost you a round trip. Turn on prompt caching first.`
}

export { utf8Bytes }
