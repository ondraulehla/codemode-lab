import type { McpClientOptions } from './client.js'

/**
 * The public MCP servers this project measures.
 *
 * Every field here was measured on 2026-09-21 with curl, not read off a README.
 * `corsOpen` decides whether the browser demo can call the server at all, and
 * `needsAuth` decides whether it is allowed anywhere near the public page.
 */
export interface ServerSpec {
  id: string
  label: string
  url: string
  /** Sends `access-control-allow-origin`, so a page can call it directly. */
  corsOpen: boolean
  /** Requires `initialize` before any other request. */
  session: boolean
  /** Needs a credential, so it is restricted to the CI harness. */
  needsAuth: boolean
  /**
   * Byte length of `JSON.stringify({ tools })` from a live `tools/list`.
   *
   * This is deliberately NOT the size of the HTTP response. Three of these servers
   * answer as `text/event-stream`, so a wire measurement would count SSE framing
   * and would not be comparable with a server that answers as JSON. The tools array
   * is the thing a client actually holds, so it is the only figure recorded here.
   */
  toolsListBytes: number
  /** Byte length of the generated TypeScript surface for the same tools. */
  typedSurfaceBytes: number
  toolCount: number
  /** The call that shows why payload size matters, with its measured size. */
  largestKnownCall?: { tool: string; args: Record<string, unknown>; bytes: number }
  /**
   * Realistic arguments for probing each tool.
   *
   * Without these, a scanner invents a generic query and reports a tiny payload,
   * which flatters the server and produces a wrong verdict. Measured example:
   * Microsoft Learn returns 14 bytes for "getting started" and 24 kB for a real
   * question. A probe is only as honest as its arguments.
   */
  probeHints?: Record<string, Record<string, unknown>>
  notes?: string
}

/**
 * Why this entry pins a tool subset instead of using the default set.
 *
 * Apify is the one server here where the DEFINITION tax is the big term. Measured
 * on 2026-09-21: the pinned four-tool subset is 21,539 B, and the authenticated
 * default set is eleven tools and about 71 kB, which is 10 percent of a 200K window
 * before any work happens. Its largest result, by contrast, is 9.8 kB. It is the
 * exact inverse of DeepWiki, which is why both belong in the set.
 *
 * Authentication does NOT change the schemas. The same four tools come back byte
 * identical with and without a token, every one of them, so the whole difference is
 * tool count. That control matters, because "it got bigger when I logged in" would
 * otherwise be the obvious and wrong conclusion.
 *
 * The default set is not recorded here because it is NOT STABLE. Across six
 * consecutive calls with an identical tool list, `apify--rag-web-browser` returned
 * 12,375, 15,565 or 21,798 bytes, a 76 percent swing on one tool and 9,423 bytes of
 * variance on the server total. Every other tool was byte identical every time. It
 * is an Actor-backed tool, so its schema appears to be assembled per request.
 *
 * Two consequences, both real. Any single published figure for this server's context
 * cost is wrong, including one this project might have published. And a drift check
 * with a ten percent tolerance would flap forever. Hence the pinned subset, which
 * measured identically on all six runs.
 */
const APIFY_NOTES =
  'The inverse of DeepWiki: definitions are the expensive term and payloads are small. ' +
  'The pinned four-tool subset is 21,539 B. The authenticated default set is 11 tools and ' +
  'about 71 kB, roughly 10 percent of a 200K window, but it is not stable: apify--rag-web-browser ' +
  'alone swings 9,423 bytes between identical calls, so no single figure for it is honest.'

export const SERVERS: ServerSpec[] = [
  {
    id: 'deepwiki',
    label: 'DeepWiki',
    url: 'https://mcp.deepwiki.com/mcp',
    corsOpen: true,
    session: false,
    needsAuth: false,
    toolsListBytes: 1526,
    typedSurfaceBytes: 1157,
    toolCount: 3,
    largestKnownCall: {
      tool: 'read_wiki_contents',
      args: { repoName: 'apify/apify-mcp-server' },
      bytes: 1_550_347,
    },
    probeHints: {
      read_wiki_contents: { repoName: 'cloudflare/agents' },
      read_wiki_structure: { repoName: 'cloudflare/agents' },
    },
    notes:
      'Answers a bare POST with no handshake, but replies as text/event-stream even for one result. ' +
      'read_wiki_contents is the largest free payload found on any public server.',
  },
  {
    id: 'context7',
    label: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    corsOpen: true,
    session: false,
    needsAuth: false,
    toolsListBytes: 4874,
    typedSurfaceBytes: 3016,
    toolCount: 2,
    probeHints: {
      'resolve-library-id': { query: 'next.js app router', libraryName: 'next.js' },
      'query-docs': { libraryId: '/vercel/next.js', query: 'app router server actions' },
    },
    notes: 'Two tools, but the largest definition surface per tool of the keyless servers.',
  },
  {
    id: 'mslearn',
    label: 'Microsoft Learn',
    url: 'https://learn.microsoft.com/api/mcp',
    corsOpen: true,
    session: false,
    needsAuth: false,
    toolsListBytes: 4868,
    typedSurfaceBytes: 2806,
    toolCount: 3,
    largestKnownCall: {
      tool: 'microsoft_docs_search',
      args: { query: 'durable functions orchestration patterns' },
      bytes: 49_595,
    },
    probeHints: {
      microsoft_docs_search: { query: 'durable functions orchestration patterns' },
      microsoft_code_sample_search: { query: 'azure blob storage upload', language: 'python' },
      microsoft_docs_fetch: {
        url: 'https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview',
      },
    },
    notes:
      'Search returns ten full documents when the caller wanted one. The everyday shape of the payload tax.',
  },
  {
    id: 'gitmcp',
    label: 'GitMCP',
    url: 'https://gitmcp.io/docs',
    corsOpen: true,
    session: true,
    needsAuth: false,
    toolsListBytes: 2890,
    typedSurfaceBytes: 2418,
    toolCount: 5,
    notes:
      'Requires initialize and an Mcp-Session-Id. Usable from a browser because it sets ' +
      'access-control-expose-headers: mcp-session-id, which a session server must do or pages cannot read the id.',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    url: 'https://huggingface.co/mcp',
    corsOpen: true,
    session: true,
    needsAuth: false,
    toolsListBytes: 18828,
    typedSurfaceBytes: 6980,
    toolCount: 4,
    notes: 'Session server. Answers initialize as application/json, not SSE.',
  },
  {
    id: 'apify',
    label: 'Apify',
    url:
      'https://mcp.apify.com/?tools=search-actors,fetch-actor-details,' +
      'search-apify-docs,fetch-apify-docs&telemetry-enabled=false',
    // No access-control-allow-origin, so a page cannot call it. CI arm only.
    corsOpen: false,
    session: true,
    // Anonymous access works, but ONLY with the ?tools= parameter. The bare
    // endpoint answers 401 and asks for a bearer token.
    needsAuth: false,
    toolsListBytes: 21539,
    typedSurfaceBytes: 14535,
    toolCount: 4,
    largestKnownCall: {
      tool: 'fetch-apify-docs',
      args: { url: 'https://docs.apify.com/platform/actors' },
      bytes: 6300,
    },
    notes:
      'The only server in this set where the DEFINITION tax is genuinely large. Four tools cost ' +
      '21,539 bytes, nearly twice DeepWiki, Context7 and Microsoft Learn combined, and search-actors ' +
      'alone is 10,089 bytes, which is 6.6x the entire DeepWiki server. It is here to show the other ' +
      'axis of the problem: payloads are small, definitions are not.',
  },
]

export function getServer(id: string): ServerSpec {
  const s = SERVERS.find((x) => x.id === id)
  if (!s) throw new Error(`unknown server: ${id}. Known: ${SERVERS.map((x) => x.id).join(', ')}`)
  return s
}

/** Client options for a spec, with auth attached only where it belongs. */
export function clientOptionsFor(
  spec: ServerSpec,
  token?: string,
): Pick<McpClientOptions, 'url' | 'name' | 'headers'> {
  return {
    url: spec.url,
    name: spec.label,
    headers: spec.needsAuth && token ? { Authorization: `Bearer ${token}` } : undefined,
  }
}
