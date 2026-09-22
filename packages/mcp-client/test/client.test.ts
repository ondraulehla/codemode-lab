import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Meter, utf8Bytes } from '@codemode-lab/meter'
import { McpClient, McpError, extractText } from '../src/client.js'
import { SERVERS, getServer } from '../src/servers.js'

/**
 * The client is tested with an injected fetch, so the suite stays offline.
 * The bytes it is fed are the real captured DeepWiki bytes, SSE framing included.
 */
const TOOLS_LIST = readFileSync(
  fileURLToPath(new URL('../../../test/fixtures/deepwiki-tools-list.sse', import.meta.url)),
  'utf8',
)
const WIKI_STRUCTURE = readFileSync(
  fileURLToPath(
    new URL('../../../test/fixtures/deepwiki-read-wiki-structure.sse', import.meta.url),
  ),
  'utf8',
)

const sse = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  })

const json = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/** Record every request the client makes, and answer from a script. */
function scripted(steps: ((body: Record<string, unknown>) => Response)[]) {
  const seen: { body: Record<string, unknown>; headers: Record<string, string> }[] = []
  let i = 0
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    seen.push({ body, headers: (init?.headers ?? {}) as Record<string, string> })
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    return step(body)
  }) as unknown as typeof fetch
  return { impl, seen }
}

describe('server instructions', () => {
  it('asks a stateless server once, and keeps no session', async () => {
    const { impl, seen } = scripted([
      () => sse(TOOLS_LIST),
      () =>
        json({
          jsonrpc: '2.0',
          id: 2,
          result: { protocolVersion: '2025-06-18', instructions: 'Use read_wiki_structure first.' },
        }),
    ])
    const client = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', fetchImpl: impl })
    await client.connect()
    expect(await client.getInstructions()).toBe('Use read_wiki_structure first.')
    // Asked once: the second read comes from memory.
    expect(await client.getInstructions()).toBe('Use read_wiki_structure first.')
    expect(seen.map((s) => s.body.method)).toEqual(['tools/list', 'initialize'])
  })

  it('reads them from the handshake a session server already made', async () => {
    const { impl, seen } = scripted([
      () =>
        json(
          { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Session ID required' } },
          { status: 400 },
        ),
      () =>
        json(
          { jsonrpc: '2.0', id: 2, result: { protocolVersion: '2025-06-18', instructions: 'Hi.' } },
          { headers: { 'mcp-session-id': 'abc' } },
        ),
      () => new Response(null, { status: 202 }),
      () => sse(TOOLS_LIST),
    ])
    const client = new McpClient({ url: 'https://gitmcp.io/docs', fetchImpl: impl })
    await client.connect()
    expect(await client.getInstructions()).toBe('Hi.')
    expect(seen.filter((s) => s.body.method === 'initialize')).toHaveLength(1)
  })

  it('returns an empty string for a server that sends none', async () => {
    const { impl } = scripted([
      () => sse(TOOLS_LIST),
      () => json({ jsonrpc: '2.0', id: 2, result: { protocolVersion: '2025-06-18' } }),
    ])
    const client = new McpClient({ url: 'https://example.com/mcp', fetchImpl: impl })
    await client.connect()
    expect(await client.getInstructions()).toBe('')
  })
})

describe('transport detection', () => {
  it('connects a stateless server in one request', async () => {
    const { impl, seen } = scripted([() => sse(TOOLS_LIST)])
    const client = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', fetchImpl: impl })

    const tools = await client.connect()
    expect(client.mode).toBe('stateless')
    expect(tools).toHaveLength(3)
    expect(seen).toHaveLength(1)
    expect(seen[0].body.method).toBe('tools/list')
    // Both media types, or a server answers 406 one way or the other.
    expect(seen[0].headers.Accept).toBe('application/json, text/event-stream')
  })

  it('falls back to initialize and carries the session id afterwards', async () => {
    const { impl, seen } = scripted([
      () =>
        json(
          { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Session ID required' } },
          { status: 400 },
        ),
      () =>
        json(
          { jsonrpc: '2.0', id: 2, result: { protocolVersion: '2025-03-26', capabilities: {} } },
          { headers: { 'mcp-session-id': 'sess-abc' } },
        ),
      () => new Response('', { status: 202 }),
      () => sse(TOOLS_LIST),
    ])
    const client = new McpClient({ url: 'https://gitmcp.io/docs', fetchImpl: impl })

    const tools = await client.connect()
    expect(client.mode).toBe('session')
    expect(tools).toHaveLength(3)
    expect(seen.map((s) => s.body.method)).toEqual([
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
    expect(seen[2].headers['Mcp-Session-Id']).toBe('sess-abc')
    // The negotiated version is echoed back, not the one we advertised.
    expect(seen[3].headers['MCP-Protocol-Version']).toBe('2025-03-26')
  })

  it('accepts a plain application/json answer', async () => {
    const { impl } = scripted([
      () => json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'x', inputSchema: {} }] } }),
    ])
    const client = new McpClient({ url: 'https://example.com/mcp', fetchImpl: impl })
    expect((await client.connect()).map((t) => t.name)).toEqual(['x'])
  })
})

describe('callTool accounting', () => {
  it('records wire bytes and text bytes as two different numbers', async () => {
    const meter = new Meter()
    const { impl } = scripted([() => sse(TOOLS_LIST), () => sse(WIKI_STRUCTURE)])
    const client = new McpClient({
      url: 'https://mcp.deepwiki.com/mcp',
      name: 'deepwiki',
      meter,
      fetchImpl: impl,
    })
    await client.connect()

    const res = await client.callTool('read_wiki_structure', { repoName: 'nodejs/undici' })
    const text = extractText(res)

    expect(meter.records).toHaveLength(1)
    const r = meter.records[0]
    expect(r.server).toBe('deepwiki')
    expect(r.tool).toBe('read_wiki_structure')
    expect(r.argsBytes).toBe(utf8Bytes('{"repoName":"nodejs/undici"}'))
    expect(r.wireBytes).toBe(Buffer.byteLength(WIKI_STRUCTURE, 'utf8'))
    expect(r.textBytes).toBe(utf8Bytes(text))
    expect(r.error).toBeUndefined()

    // Framing and JSON escaping is the whole gap. Never quote wire bytes as context.
    expect(r.textBytes).toBeLessThan(r.wireBytes)
  })

  it('reports streamed progress in bytes as the body arrives', async () => {
    const seenProgress: number[] = []
    const { impl } = scripted([() => sse(TOOLS_LIST)])
    const client = new McpClient({
      url: 'https://mcp.deepwiki.com/mcp',
      fetchImpl: impl,
      onProgress: (n) => seenProgress.push(n),
    })
    await client.connect()
    expect(seenProgress.at(-1)).toBe(Buffer.byteLength(TOOLS_LIST, 'utf8'))
  })

  it('records the failed call before it throws McpError', async () => {
    const meter = new Meter()
    const { impl } = scripted([
      () => sse(TOOLS_LIST),
      () =>
        sse(
          'event: message\ndata: ' +
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              error: { code: -32602, message: 'repoName is required' },
            }) +
            '\n\n',
        ),
    ])
    const client = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', meter, fetchImpl: impl })
    await client.connect()

    await expect(client.callTool('read_wiki_contents', {})).rejects.toThrow(McpError)
    expect(meter.records).toHaveLength(1)
    expect(meter.records[0].error).toBe('repoName is required')
    expect(meter.records[0].textBytes).toBe(0)
    expect(meter.totals.errors).toBe(1)
  })

  it('flags a result the server itself marked as an error', async () => {
    const meter = new Meter()
    const { impl } = scripted([
      () => sse(TOOLS_LIST),
      () =>
        sse(
          'event: message\ndata: ' +
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { content: [{ type: 'text', text: 'no such repo' }], isError: true },
            }) +
            '\n\n',
        ),
    ])
    const client = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', meter, fetchImpl: impl })
    await client.connect()
    await client.callTool('read_wiki_contents', { repoName: 'nope/nope' })
    expect(meter.records[0].error).toBe('tool reported isError')
    expect(meter.records[0].textBytes).toBe(utf8Bytes('no such repo'))
  })

  it('throws when a stream carries no JSON-RPC message', async () => {
    const { impl } = scripted([() => sse(': keepalive\n\n')])
    const client = new McpClient({ url: 'https://example.com/mcp', fetchImpl: impl })
    await expect(client.connect()).rejects.toThrow(/no JSON-RPC result found/)
  })
})

describe('extractText', () => {
  it('joins text blocks and ignores everything else', () => {
    expect(
      extractText({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\ntwo')
  })

  it('returns an empty string when there is no content', () => {
    expect(extractText({ content: [] })).toBe('')
    expect(extractText({} as never)).toBe('')
  })
})

describe('server registry', () => {
  it('keeps the measured facts a browser client depends on', () => {
    const deepwiki = getServer('deepwiki')
    expect(deepwiki.corsOpen).toBe(true)
    expect(deepwiki.session).toBe(false)
    expect(deepwiki.needsAuth).toBe(false)

    // A server that needs a credential must never be reachable from a page.
    for (const s of SERVERS) {
      if (s.needsAuth) expect(s.corsOpen).toBe(false)
    }
    // grep.app sends no CORS headers, so it must not be in the list at all.
    expect(SERVERS.some((s) => s.url.includes('grep.app'))).toBe(false)
  })

  it('names the known servers when asked for one it does not have', () => {
    expect(() => getServer('nope')).toThrow(/unknown server: nope/)
  })
})

/**
 * Live checks. They are off by default so the suite is deterministic offline.
 * Run them with LIVE=1 when you want to know whether the measured facts still hold.
 */
describe.skipIf(!process.env.LIVE)('live servers', () => {
  it('DeepWiki still answers a bare POST with an event stream', async () => {
    const meter = new Meter()
    const client = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', name: 'deepwiki', meter })
    const tools = await client.connect()
    expect(client.mode).toBe('stateless')
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_question',
      'read_wiki_contents',
      'read_wiki_structure',
    ])
  }, 60_000)

  it('one read_wiki_contents call is still larger than a context window', async () => {
    const meter = new Meter()
    const client = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', name: 'deepwiki', meter })
    await client.connect()
    await client.callTool('read_wiki_contents', { repoName: 'cloudflare/agents' })

    const r = meter.records[0]
    // Text bytes, never wire bytes. At 2.4 to 3.8 bytes per token this is the
    // 92% to 146% of a 200K window that the README quotes as an estimate.
    expect(r.textBytes).toBeGreaterThan(500_000)
    expect(r.wireBytes).toBeGreaterThan(r.textBytes)
  }, 180_000)
})
