import { Meter, utf8Bytes } from '@codemode-lab/meter'
import { SseParser } from './sse.js'
import type { JsonSchema, McpTool, ToolResult } from './types.js'

/** Spec revision we advertise. Servers answering an older one still work. */
export const CLIENT_PROTOCOL_VERSION = '2025-06-18'

export interface McpClientOptions {
  url: string
  /** Display name used in meter records and CLI output. Defaults to the hostname. */
  name?: string
  /** Extra headers, for example an Authorization bearer for a private server. */
  headers?: Record<string, string>
  /** Where byte counts land. Omit it and nothing is measured. */
  meter?: Meter
  /** Injected for tests. Defaults to the global. */
  fetchImpl?: typeof fetch
  /** Called with cumulative bytes while a response body streams in. */
  onProgress?: (bytesSoFar: number) => void
}

/**
 * How a server wants to be talked to.
 *
 * Measured on 2026-09-21: DeepWiki, Context7 and Microsoft Learn answer a bare
 * `tools/list` POST with no handshake. GitMCP and Hugging Face reject it with
 * "Session ID required" and need `initialize` first. A client that assumes either
 * shape fails on half the servers, so this is detected, not configured.
 */
export type TransportMode = 'stateless' | 'session'

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export class McpClient {
  readonly url: string
  readonly name: string
  private headers: Record<string, string>
  private meter?: Meter
  private fetchImpl: typeof fetch
  private onProgress?: (n: number) => void

  private sessionId?: string
  private negotiatedVersion?: string
  private nextId = 1
  private instructions?: string

  /** Set once `connect()` has probed the server. */
  mode?: TransportMode

  constructor(opts: McpClientOptions) {
    this.url = opts.url
    this.name = opts.name ?? new URL(opts.url).hostname
    this.headers = opts.headers ?? {}
    this.meter = opts.meter
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.onProgress = opts.onProgress
  }

  /**
   * Work out which transport this server speaks, without a round trip we cannot use.
   *
   * The probe IS a real `tools/list`, so a stateless server is connected and listed
   * in one request. Only a server that refuses pays for the handshake.
   */
  async connect(): Promise<McpTool[]> {
    const probe = await this.rpc('tools/list', {}, { tolerateError: true })
    if (!probe.error) {
      this.mode = 'stateless'
      return (probe.result as { tools: McpTool[] }).tools
    }

    this.mode = 'session'
    const init = await this.rpc(
      'initialize',
      {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'codemode-lab', version: '0.1.0' },
      },
      { captureSession: true },
    )
    this.negotiatedVersion = (init.result as { protocolVersion?: string })?.protocolVersion
    this.instructions = (init.result as { instructions?: string })?.instructions ?? ''

    // The spec requires this notification before normal requests. It takes no reply.
    await this.notify('notifications/initialized')

    const listed = await this.rpc('tools/list', {})
    return (listed.result as { tools: McpTool[] }).tools
  }

  /**
   * The server's `instructions`, from its `initialize` reply. Empty when it sends none.
   *
   * A client puts these in front of the model next to the tool definitions. Claude
   * Code does, which is why the harness passes them to the code mode arm as well:
   * DeepWiki's are 3,129 bytes, and on 2026-09-22 they were the largest part of the
   * direct arm's definition tax. A stateless server is never initialized by
   * `connect()`, so this asks once, and keeps no session.
   */
  async getInstructions(): Promise<string> {
    if (this.instructions !== undefined) return this.instructions
    const init = await this.rpc(
      'initialize',
      {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'codemode-lab', version: '0.1.0' },
      },
      { tolerateError: true },
    )
    this.instructions = (init.result as { instructions?: string } | undefined)?.instructions ?? ''
    return this.instructions
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.mode) return this.connect()
    const r = await this.rpc('tools/list', {})
    return (r.result as { tools: McpTool[] }).tools
  }

  /**
   * Call a tool and measure what came back.
   *
   * Two byte counts are recorded because they answer different questions.
   * `wireBytes` is what the network carried, SSE framing and JSON escaping included.
   * `textBytes` is the text a model would actually be handed. The gap between them
   * is real: a 1.48 MiB DeepWiki response carries escaped newlines that shrink on parse.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (!this.mode) await this.connect()
    const started = now()
    const argsJson = JSON.stringify(args)

    try {
      const { message, wireBytes } = await this.rpc(
        'tools/call',
        { name, arguments: args },
        { tolerateError: true, wantRaw: true },
      )

      if (message.error) {
        this.meter?.record({
          server: this.name,
          tool: name,
          argsBytes: utf8Bytes(argsJson),
          wireBytes,
          textBytes: 0,
          ms: now() - started,
          error: message.error.message,
        })
        throw new McpError(message.error.message, message.error.code, message.error.data)
      }

      const result = message.result as ToolResult
      const text = extractText(result)

      this.meter?.record({
        server: this.name,
        tool: name,
        argsBytes: utf8Bytes(argsJson),
        wireBytes,
        textBytes: utf8Bytes(text),
        ms: now() - started,
        error: result.isError ? 'tool reported isError' : undefined,
      })

      return result
    } catch (err) {
      if (err instanceof McpError) throw err
      this.meter?.record({
        server: this.name,
        tool: name,
        argsBytes: utf8Bytes(argsJson),
        wireBytes: 0,
        textBytes: 0,
        ms: now() - started,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  // ---------------------------------------------------------------- transport

  private requestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // Both are required. Servers that answer with SSE reject a JSON-only Accept
      // with a 406, and servers that answer with JSON reject an SSE-only one.
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    if (this.negotiatedVersion) h['MCP-Protocol-Version'] = this.negotiatedVersion
    return h
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    })
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    opts: { tolerateError?: boolean; captureSession?: boolean; wantRaw?: boolean } = {},
  ): Promise<RpcOutcome> {
    const id = this.nextId++
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })

    if (opts.captureSession) {
      // Browsers only expose this when the server sets
      // `access-control-expose-headers: mcp-session-id`. GitMCP does. A server that
      // does not is unusable from a page, which is a finding, not a bug here.
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
    }

    const { text, bytes } = await readBody(res, this.onProgress)

    if (!res.ok && !text.trim()) {
      throw new McpError(`HTTP ${res.status} from ${this.url}`, res.status)
    }

    const message = decodeRpc(text, res.headers.get('content-type') ?? '')

    if (message.error && !opts.tolerateError) {
      throw new McpError(message.error.message, message.error.code, message.error.data)
    }

    return { ...message, message, wireBytes: bytes }
  }
}

interface RpcMessage {
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
interface RpcOutcome extends RpcMessage {
  message: RpcMessage
  wireBytes: number
}

/**
 * Read a response body, counting bytes as they land.
 *
 * Streaming matters for one reason: a page can show a counter climbing while a
 * 1.48 MiB payload arrives. Buffering the whole body first would make the most
 * important number in the project appear all at once, which is exactly the thing
 * the page is trying to make visible.
 */
async function readBody(
  res: Response,
  onProgress?: (n: number) => void,
): Promise<{ text: string; bytes: number }> {
  if (!res.body) {
    const text = await res.text()
    const bytes = utf8Bytes(text)
    onProgress?.(bytes)
    return { text, bytes }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    chunks.push(decoder.decode(value, { stream: true }))
    onProgress?.(bytes)
  }
  chunks.push(decoder.decode())

  return { text: chunks.join(''), bytes }
}

/** Accept either transport encoding and return the last JSON-RPC message. */
function decodeRpc(text: string, contentType: string): RpcMessage {
  const looksSse = contentType.includes('text/event-stream') || text.startsWith('event:')

  if (looksSse) {
    const parser = new SseParser()
    const frames = [...parser.push(text), ...parser.end()]
    // A stream can carry progress notifications before the result. The answer is
    // the last frame that parses into a message with an id.
    for (let i = frames.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(frames[i].data) as RpcMessage & { id?: unknown }
        if (msg.result !== undefined || msg.error !== undefined) return msg
      } catch {
        // Keep looking. A malformed frame is not fatal if a later one parses.
      }
    }
    throw new McpError('no JSON-RPC result found in event stream')
  }

  try {
    return JSON.parse(text) as RpcMessage
  } catch {
    throw new McpError(`unparseable response: ${text.slice(0, 200)}`)
  }
}

/** Concatenate the text parts of a tool result, which is what a model would read. */
export function extractText(result: ToolResult): string {
  if (!result?.content) return ''
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

const now = (): number =>
  typeof performance !== 'undefined'
    ? performance.now()
    : Number(process.hrtime.bigint() / 1_000_000n)

export type { JsonSchema, McpTool, ToolResult }
