/**
 * Numbers measured with curl on 21 September 2026, not copied from a README.
 *
 * Byte counts are exact. Sizes are given the way the meter package formats them,
 * so kB means 1024 bytes and MB means 1024 kB. Everything token shaped is derived
 * from these bytes at render time, and is always shown as a band.
 */

export interface PayloadRow {
  repo: string
  /** Bytes on the wire, SSE framing and JSON escaping included. */
  wireBytes: number
  /** Bytes of text inside the result. This is what would enter a context window. */
  textBytes: number
}

const kB = (n: number) => Math.round(n * 1024)
const MB = (n: number) => Math.round(n * 1024 * 1024)

/** One `read_wiki_contents` call per repo, against the live DeepWiki server. */
export const PAYLOADS: PayloadRow[] = [
  { repo: 'apify/apify-mcp-server', wireBytes: MB(1.48), textBytes: kB(728.2) },
  { repo: 'vercel/ai', wireBytes: MB(1.42), textBytes: kB(712.8) },
  { repo: 'cloudflare/agents', wireBytes: MB(1.37), textBytes: kB(683.7) },
  { repo: 'withastro/astro', wireBytes: MB(1.13), textBytes: kB(563.5) },
  { repo: 'e2b-dev/E2B', wireBytes: kB(825.2), textBytes: kB(403.0) },
  { repo: 'modelcontextprotocol/servers', wireBytes: kB(791.3), textBytes: kB(383.4) },
  { repo: 'nodejs/undici', wireBytes: kB(571.1), textBytes: kB(274.4) },
]

export const PAYLOAD_TOTAL_TEXT = PAYLOADS.reduce((n, p) => n + p.textBytes, 0)
export const PAYLOAD_TOTAL_WIRE = PAYLOADS.reduce((n, p) => n + p.wireBytes, 0)

export interface DefinitionRow {
  server: string
  /**
   * Bytes of the `tools/list` JSON, which is what a model would read.
   * The SSE response on the wire is larger, because of the event framing:
   * 1,586 B, 4,931 B and 4,950 B for these three servers.
   */
  bytes: number
  tools: number
  note: string
}

/** The tool definition tax. This is the term every other write-up measures. */
export const DEFINITIONS: DefinitionRow[] = [
  { server: 'DeepWiki', bytes: 1526, tools: 3, note: 'stateless, answers a bare POST' },
  { server: 'Context7', bytes: 4874, tools: 2, note: 'stateless, two tools, verbose schemas' },
  { server: 'Microsoft Learn', bytes: 4868, tools: 3, note: 'stateless, three tools' },
]

export const DEFINITION_TOTAL = DEFINITIONS.reduce((n, d) => n + d.bytes, 0)
export const DEFINITION_TOOLS = DEFINITIONS.reduce((n, d) => n + d.tools, 0)

/** What each failure class means, in one sentence, for the run panels. */
export const FAILURE_CLASSES: { id: string; label: string; meaning: string }[] = [
  {
    id: 'timeout',
    label: 'timeout',
    meaning:
      'The program ran longer than the task allows. DeepWiki can take a minute on a cache miss.',
  },
  {
    id: 'egress-denied',
    label: 'egress denied',
    meaning:
      'The program tried to reach the network itself. The sandbox has no network, by design.',
  },
  {
    id: 'syntax',
    label: 'syntax',
    meaning: 'The program did not parse. Nothing ran and no tool was called.',
  },
  {
    id: 'tool-error',
    label: 'tool error',
    meaning: 'A tool call failed, or the program asked for a tool the task does not allow.',
  },
  {
    id: 'program-threw',
    label: 'program threw',
    meaning: 'The program parsed and ran, then raised an error of its own.',
  },
  {
    id: 'bridge',
    label: 'bridge',
    meaning: 'The sandbox stopped answering. The host ended the run instead of waiting.',
  },
  {
    id: 'transport',
    label: 'transport',
    meaning:
      'The browser could not reach the server: network down, CORS refused, or the server returned an error.',
  },
]
