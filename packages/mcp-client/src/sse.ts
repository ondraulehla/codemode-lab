/**
 * Server-sent event framing, as the MCP streamable-HTTP transport uses it.
 *
 * Three of the five public servers this repo talks to answer a plain POST with
 * `text/event-stream` even for a single result, so a client that only parses
 * `application/json` silently sees nothing. That surprise is why this is its own
 * module with its own tests.
 */

/** One decoded SSE frame. `event` defaults to `message` per the spec. */
export interface SseFrame {
  event: string
  data: string
  id?: string
}

/**
 * Incremental SSE parser.
 *
 * Network chunks split frames anywhere, including mid-line, so the parser keeps a
 * buffer and only emits on a blank-line boundary. Multiple `data:` lines in one
 * frame join with `\n`, which the spec requires and which a naive
 * `startsWith('data: ')` per chunk gets wrong.
 */
export class SseParser {
  private buffer = ''

  /** Feed a chunk of text. Returns the frames that completed. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []

    // Frames end at a blank line. Normalise CRLF first: some proxies rewrite it.
    const normalised = this.buffer.replace(/\r\n/g, '\n')
    const parts = normalised.split('\n\n')

    // The last part is either empty or an incomplete frame. Keep it buffered.
    this.buffer = parts.pop() ?? ''

    for (const part of parts) {
      const frame = parseFrame(part)
      if (frame) frames.push(frame)
    }
    return frames
  }

  /** Flush a trailing frame that arrived without its final blank line. */
  end(): SseFrame[] {
    const rest = this.buffer
    this.buffer = ''
    const frame = rest.trim() ? parseFrame(rest) : null
    return frame ? [frame] : []
  }
}

function parseFrame(block: string): SseFrame | null {
  const dataLines: string[] = []
  let event = 'message'
  let id: string | undefined

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue // comment / keepalive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // A single leading space after the colon is stripped. Further spaces are data.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n'), id }
}

/** Parse a complete SSE body in one go. Used by the CLI, where streaming buys nothing. */
export function parseSseBody(body: string): SseFrame[] {
  const p = new SseParser()
  return [...p.push(body), ...p.end()]
}
