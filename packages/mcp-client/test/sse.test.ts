import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SseParser, parseSseBody, type SseFrame } from '../src/sse.js'

/**
 * SSE framing is the quietest way this repo could lie.
 *
 * A parser that drops a frame does not throw. It returns a smaller payload, and a
 * smaller payload is exactly the result the project claims to produce. So the
 * framing gets the strictest tests in the suite, against real captured bytes.
 */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url)), 'utf8')

const TOOLS_LIST = fixture('deepwiki-tools-list.sse')
const WIKI_STRUCTURE = fixture('deepwiki-read-wiki-structure.sse')

/** Feed a body as `n` chunks split at the given indexes. */
function feed(body: string, cuts: number[]): SseFrame[] {
  const p = new SseParser()
  const frames: SseFrame[] = []
  let last = 0
  for (const cut of cuts) {
    frames.push(...p.push(body.slice(last, cut)))
    last = cut
  }
  frames.push(...p.push(body.slice(last)))
  frames.push(...p.end())
  return frames
}

describe('captured DeepWiki bytes', () => {
  it('the capture really is CRLF event-stream, which is what makes this hard', () => {
    expect(TOOLS_LIST.startsWith('event: message\r\ndata: ')).toBe(true)
    expect(TOOLS_LIST.endsWith('\r\n\r\n')).toBe(true)
    expect(fixture('deepwiki-tools-list.headers.txt')).toContain('content-type: text/event-stream')
  })

  it('parses one frame carrying the whole tools/list result', () => {
    const frames = parseSseBody(TOOLS_LIST)
    expect(frames).toHaveLength(1)
    expect(frames[0].event).toBe('message')

    const msg = JSON.parse(frames[0].data) as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }
    }
    expect(msg.result.tools.map((t) => t.name)).toEqual([
      'ask_question',
      'read_wiki_contents',
      'read_wiki_structure',
    ])
    // The anyOf that typegen must not collapse. See the typegen suite.
    expect(msg.result.tools[0].inputSchema.properties.repoName).toHaveProperty('anyOf')
  })

  it('parses a real tools/call payload without losing a byte of text', () => {
    const frames = parseSseBody(WIKI_STRUCTURE)
    expect(frames).toHaveLength(1)
    const msg = JSON.parse(frames[0].data) as { result: { content: { text: string }[] } }
    const text = msg.result.content[0].text
    expect(text).toContain('Available pages for nodejs/undici')
    // Escaped newlines in the wire bytes become real newlines in the text. The gap
    // between wire and text is the reason this repo reports both numbers.
    expect(text.split('\n').length).toBeGreaterThan(10)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(Buffer.byteLength(WIKI_STRUCTURE, 'utf8'))
  })

  it('survives a split at every single byte boundary of a real response', () => {
    const expected = parseSseBody(TOOLS_LIST)
    for (let i = 0; i <= TOOLS_LIST.length; i++) {
      expect(feed(TOOLS_LIST, [i]), `split at ${i}`).toEqual(expected)
    }
  })

  it('survives arrival one byte at a time', () => {
    const p = new SseParser()
    const frames: SseFrame[] = []
    for (const ch of TOOLS_LIST) frames.push(...p.push(ch))
    frames.push(...p.end())
    expect(frames).toEqual(parseSseBody(TOOLS_LIST))
  })
})

describe('chunk boundaries', () => {
  const body = 'event: message\ndata: {"a":1}\n\nevent: message\ndata: {"a":2}\n\n'

  it('handles every two-cut split, including inside the blank-line terminator', () => {
    const expected = parseSseBody(body)
    for (let i = 0; i <= body.length; i++) {
      for (let j = i; j <= body.length; j++) {
        expect(feed(body, [i, j]), `cuts ${i},${j}`).toEqual(expected)
      }
    }
  })

  it('handles a CRLF terminator torn between the \\r and the \\n', () => {
    const crlf = 'event: message\r\ndata: one\r\n\r\ndata: two\r\n\r\n'
    const torn = crlf.indexOf('\r\n\r\n') + 2 // exactly between the two line breaks
    expect(feed(crlf, [torn])).toEqual([
      { event: 'message', data: 'one', id: undefined },
      { event: 'message', data: 'two', id: undefined },
    ])
  })

  it('emits nothing until a frame is complete', () => {
    const p = new SseParser()
    expect(p.push('event: message\ndata: hal')).toEqual([])
    expect(p.push('f\n')).toEqual([])
    expect(p.push('\n')).toEqual([{ event: 'message', data: 'half', id: undefined }])
  })
})

describe('frame fields', () => {
  it('joins several data lines with a newline', () => {
    expect(parseSseBody('data: line one\ndata: line two\ndata: line three\n\n')).toEqual([
      { event: 'message', data: 'line one\nline two\nline three', id: undefined },
    ])
  })

  it('strips exactly one leading space after the colon', () => {
    expect(parseSseBody('data:tight\n\n')[0].data).toBe('tight')
    expect(parseSseBody('data:  two spaces\n\n')[0].data).toBe(' two spaces')
    expect(parseSseBody('data:   three\n\n')[0].data).toBe('  three')
  })

  it('reads a field with no colon as an empty value', () => {
    expect(parseSseBody('data\n\n')).toEqual([{ event: 'message', data: '', id: undefined }])
  })

  it('keeps colons that belong to the value', () => {
    expect(parseSseBody('data: {"url":"https://mcp.deepwiki.com/mcp"}\n\n')[0].data).toBe(
      '{"url":"https://mcp.deepwiki.com/mcp"}',
    )
  })

  it('defaults the event name to message and carries id when present', () => {
    expect(parseSseBody('data: x\n\n')[0].event).toBe('message')
    expect(parseSseBody('event: ping\nid: 42\ndata: x\n\n')[0]).toEqual({
      event: 'ping',
      data: 'x',
      id: '42',
    })
  })

  it('ignores comment and keepalive lines', () => {
    expect(parseSseBody(': keepalive\n\n')).toEqual([])
    expect(parseSseBody(':\n\n')).toEqual([])
    expect(parseSseBody(': a comment\ndata: real\n: another\n\n')).toEqual([
      { event: 'message', data: 'real', id: undefined },
    ])
  })

  it('drops a block that carries no data line at all', () => {
    expect(parseSseBody('event: ping\nid: 7\n\ndata: kept\n\n')).toEqual([
      { event: 'message', data: 'kept', id: undefined },
    ])
  })
})

describe('end()', () => {
  it('flushes a trailing frame that never got its blank line', () => {
    const p = new SseParser()
    expect(p.push('event: message\ndata: last')).toEqual([])
    expect(p.end()).toEqual([{ event: 'message', data: 'last', id: undefined }])
  })

  it('returns nothing for an empty or whitespace-only tail, and is idempotent', () => {
    const p = new SseParser()
    p.push('data: done\n\n')
    expect(p.end()).toEqual([])
    expect(p.end()).toEqual([])

    const q = new SseParser()
    q.push('data: done\n\n\n')
    expect(q.end()).toEqual([])
  })

  it('leaves the parser empty so a reused instance cannot repeat a frame', () => {
    const p = new SseParser()
    p.push('data: one')
    expect(p.end()).toHaveLength(1)
    expect(p.push('data: two\n\n')).toEqual([{ event: 'message', data: 'two', id: undefined }])
    expect(p.end()).toEqual([])
  })
})

describe('a stream that carries more than the answer', () => {
  it('keeps progress notifications and the result in arrival order', () => {
    const body =
      ': stream start\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":2}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n'

    const frames = parseSseBody(body)
    expect(frames).toHaveLength(3)
    // The client reads backwards for the first frame with a result or an error,
    // so the order here is what makes that search correct.
    const last = JSON.parse(frames[2].data) as { result?: unknown }
    expect(last.result).toBeDefined()
  })
})
