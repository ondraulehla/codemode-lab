import { describe, expect, it, vi } from 'vitest'
import { utf8Bytes } from '@codemode-lab/meter'
import { Bridge, toolTableFrom } from '../src/host.js'
import type { BoundaryEvent } from '../src/host.js'
import { NODE_DENIED, BROWSER_DENIED } from '../src/guest.js'
import type { RunResult, ToolTable } from '../src/protocol.js'
import { runInNodeSandbox } from '../src/node.js'

/**
 * The sandbox tests use fake tools and never touch the network.
 *
 * What they check is the claim the project is built on: a tool can hand the
 * program a megabyte, and only what the program returns leaves the boundary.
 */
interface Run {
  result: RunResult
  boundary: BoundaryEvent[]
  logs: { level: string; text: string }[]
  in: number
  out: number
  returnedBytes: number
}

async function runProgram(code: string, tools: ToolTable, timeoutMs = 10_000): Promise<Run> {
  const boundary: BoundaryEvent[] = []
  const logs: { level: string; text: string }[] = []
  const result = await runInNodeSandbox(code, {
    tools,
    timeoutMs,
    onLog: (level, text) => logs.push({ level, text }),
    onBoundary: (ev) => boundary.push(ev),
  })
  const returned = result.value === undefined ? '' : JSON.stringify(result.value)
  return {
    result,
    boundary,
    logs,
    in: boundary.filter((b) => b.direction === 'in').reduce((n, b) => n + b.bytes, 0),
    out: boundary.filter((b) => b.direction === 'out').reduce((n, b) => n + b.bytes, 0),
    returnedBytes: utf8Bytes(returned),
  }
}

describe('a program that works', () => {
  it('returns its value to the host', async () => {
    const r = await runProgram('return { answer: 42 }', {})
    expect(r.result.ok).toBe(true)
    expect(r.result.value).toEqual({ answer: 42 })
    expect(r.result.failure).toBeUndefined()
    expect(r.result.ms).toBeGreaterThanOrEqual(0)
  })

  it('can await a tool and use the result', async () => {
    const tools: ToolTable = {
      'deepwiki.read_wiki_structure': async () => '- 1 Overview\n- 2 Core HTTP Client',
    }
    const r = await runProgram(
      `const page = await deepwiki.read_wiki_structure({ repoName: 'nodejs/undici' })
       return page.split('\\n').length`,
      tools,
    )
    expect(r.result.ok).toBe(true)
    expect(r.result.value).toBe(2)
  })

  it('sends console output to the host and hides the transport handshake', async () => {
    const r = await runProgram(
      `console.log('scanning', 4, { repo: 'undici' })
       console.warn('slow')
       console.error('failed one')
       return 'done'`,
      {},
    )
    expect(r.logs).toEqual([
      { level: 'log', text: 'scanning 4 {"repo":"undici"}' },
      { level: 'warn', text: 'slow' },
      { level: 'error', text: 'failed one' },
    ])
    expect(r.logs.some((l) => l.text === '__ready__')).toBe(false)
  })

  it('keeps the handshake out of the recorded logs as well', async () => {
    // SKIPPED: fails today, and the cause is in a package this suite does not own.
    // `runInNodeSandbox` filters '__ready__' in the onLog wrapper, but the Bridge
    // pushes every log line into `RunResult.logs` before that wrapper runs. So a
    // caller that reads `result.logs`, which the CLI does, sees the transport
    // handshake as the program's first line of output. Reported, not patched.
    const r = await runProgram(`console.log('real output'); return 1`, {})
    expect(r.result.logs.map((l) => l.text)).toEqual(['real output'])
  })

  it('runs several tool calls concurrently', async () => {
    const tools: ToolTable = {
      'deepwiki.read_wiki_contents': async (args) => {
        const { repoName } = args as { repoName: string }
        return `wiki for ${repoName}`
      },
    }
    const r = await runProgram(
      `const repos = ['a/a', 'b/b', 'c/c', 'd/d']
       const pages = await Promise.all(repos.map((r) => deepwiki.read_wiki_contents({ repoName: r })))
       return pages.length`,
      tools,
    )
    expect(r.result.value).toBe(4)
    expect(r.boundary.filter((b) => b.direction === 'in')).toHaveLength(4)
  })
})

describe('boundary accounting', () => {
  it('counts in-bytes as the exact UTF-8 length of what the tool returned', async () => {
    const payload = 'Příliš žluťoučký kůň '.repeat(100)
    const tools: ToolTable = { 'x.get': async () => payload }
    const r = await runProgram(`const s = await x.get({ q: 'a' }); return s.length`, tools)

    const inbound = r.boundary.filter((b) => b.direction === 'in')
    expect(inbound).toHaveLength(1)
    expect(inbound[0].bytes).toBe(utf8Bytes(payload))
    expect(inbound[0].tool).toBe('x.get')
    // A byte count taken from String.length would be wrong by every accent here.
    expect(inbound[0].bytes).toBeGreaterThan(payload.length)
  })

  it('counts out-bytes as the JSON length of the arguments', async () => {
    const tools: ToolTable = { 'x.get': async () => 'ok' }
    const r = await runProgram(`return await x.get({ repoName: 'nodejs/undici' })`, tools)
    const out = r.boundary.filter((b) => b.direction === 'out')
    expect(out).toHaveLength(1)
    expect(out[0].bytes).toBe(utf8Bytes('{"repoName":"nodejs/undici"}'))
  })

  it('pairs every crossing with its call id, out before in', async () => {
    const tools: ToolTable = { 'x.get': async () => 'ok' }
    const r = await runProgram(`await x.get({}); await x.get({}); return 1`, tools)
    expect(r.boundary.map((b) => `${b.direction}:${b.id}`)).toEqual([
      'out:1',
      'in:1',
      'out:2',
      'in:2',
    ])
  })

  it('lets a megabyte in and only ten bytes out', async () => {
    // The whole project in one test. The tool hands the program 1 MB. The program
    // filters it and returns a short answer. Only the answer crosses back.
    const big = 'x'.repeat(1024 * 1024)
    const tools: ToolTable = { 'deepwiki.read_wiki_contents': async () => big }
    const r = await runProgram(
      `const page = await deepwiki.read_wiki_contents({ repoName: 'apify/apify-mcp-server' })
       return 'len=' + page.length`,
      tools,
    )

    expect(r.result.ok).toBe(true)
    expect(r.in).toBe(1024 * 1024)
    expect(r.result.value).toBe('len=1048576')
    expect(r.returnedBytes).toBe(utf8Bytes('"len=1048576"'))
    expect(r.returnedBytes).toBeLessThan(20)
    // The reduction this proves, stated as a ratio and nothing more.
    expect(Math.round(r.in / r.returnedBytes)).toBeGreaterThan(50_000)
  })

  it('counts each of four payloads once, the cross-repo-scan shape', async () => {
    const page = 'y'.repeat(250_000)
    const tools: ToolTable = { 'deepwiki.read_wiki_contents': async () => page }
    const r = await runProgram(
      `const repos = ['a/a', 'b/b', 'c/c', 'd/d']
       const out = []
       for (const repo of repos) {
         const text = await deepwiki.read_wiki_contents({ repoName: repo })
         out.push(repo + ':' + text.length)
       }
       return out.join(',')`,
      tools,
    )
    expect(r.in).toBe(4 * 250_000)
    expect(r.returnedBytes).toBeLessThan(100)
  })
})

describe('failure classification', () => {
  it('reports a syntax error before the program ever runs', async () => {
    const r = await runProgram('return (', {})
    expect(r.result.ok).toBe(false)
    expect(r.result.failure).toBe('syntax')
    expect(r.result.error).toContain('SyntaxError')
  })

  it('reports a timeout', async () => {
    const r = await runProgram('await new Promise(() => {}); return 1', {}, 300)
    expect(r.result.ok).toBe(false)
    expect(r.result.failure).toBe('timeout')
    expect(r.result.error).toBe('timeout after 300ms')
  })

  it('reports a program that throws, with its message', async () => {
    const r = await runProgram(`throw new Error('kaboom')`, {})
    expect(r.result.ok).toBe(false)
    expect(r.result.error).toContain('kaboom')
  })

  it('classifies a program that throws as program-threw', async () => {
    // SKIPPED: fails today because of a bug in a package this suite does not own.
    // The Node worker is built from a `data:text/javascript,...` URL whose encoded
    // body is also the script name in every stack frame. That body contains the
    // literal text "SyntaxError", so `classify()` in host.ts matches it and calls
    // every runtime failure a syntax error. Reported, not patched.
    const r = await runProgram(`throw new Error('kaboom')`, {})
    expect(r.result.failure).toBe('program-threw')
  })

  it('surfaces a tool failure to the program as a rejected promise', async () => {
    const tools: ToolTable = {
      'x.get': async () => {
        throw new Error('server said 503')
      },
    }
    const r = await runProgram(
      `try { await x.get({}) } catch (e) { return 'caught: ' + e.message }
       return 'not reached'`,
      tools,
    )
    expect(r.result.ok).toBe(true)
    expect(r.result.value).toBe('caught: server said 503')
    // A failed call still crossed the boundary, so it is still measured.
    expect(r.boundary.filter((b) => b.direction === 'in')[0].bytes).toBe(
      utf8Bytes('server said 503'),
    )
  })

  it('ends the run when the program lets a tool failure escape', async () => {
    const tools: ToolTable = {
      'x.get': async () => {
        throw new Error('server said 503')
      },
    }
    const r = await runProgram(`return await x.get({})`, tools)
    expect(r.result.ok).toBe(false)
    expect(r.result.error).toContain('server said 503')
  })

  it('classifies an escaped tool failure as tool-error', async () => {
    // SKIPPED: fails today for two reasons, both in packages this suite does not own.
    // First, the stack carries the data: URL that contains the text "SyntaxError",
    // so classify() answers 'syntax'. Second, even with a clean message, nothing
    // carries the tool-error fact across the bridge: the guest rejects with the
    // server's own message, so the host cannot tell a tool failure from a program
    // failure. Reported, not patched.
    const tools: ToolTable = {
      'x.get': async () => {
        throw new Error('server said 503')
      },
    }
    const r = await runProgram(`return await x.get({})`, tools)
    expect(r.result.failure).toBe('tool-error')
  })

  it('takes the failure class the sandbox sent and does not re-derive it', async () => {
    // The sandbox decides the class, because only the sandbox knows the cause. A
    // tool that fails with "server said 503" is a tool error and nothing in that
    // string says so. The host must not read the class out of the message.
    const cases: [string, string, string][] = [
      ['tool-error', 'server said 503', 'a tool failure the host could never recognise'],
      ['program-threw', 'kaboom', 'a plain program error'],
      ['syntax', 'SyntaxError: Unexpected end of input', 'a real syntax error'],
      ['egress-denied', 'egress-denied: the sandbox has no network.', 'a refused network global'],
      ['timeout', 'timeout after 300ms', 'the guest timer firing'],
    ]
    for (const [failure, error, why] of cases) {
      const bridge = new Bridge({ tools: {} }, () => {})
      const done = bridge.begin()
      bridge.handle({ kind: 'done', ok: false, error, failure } as never)
      expect((await done).failure, why).toBe(failure)
    }
  })

  it('falls back to bridge for a failure the sandbox never reported', async () => {
    // Only host-produced failures reach the fallback: a dead worker, a killed frame.
    // It deliberately does NOT guess 'syntax' from the word SyntaxError. Guessing is
    // what broke this: the Node sandbox loads from a data URL, so every stack frame
    // quoted the whole guest, the guest's own source contains that word, and every
    // single failure came back labelled a syntax error.
    const cases: [string, string][] = [
      ['timeout after 300ms', 'timeout'],
      ['hard timeout after 35000ms', 'timeout'],
      ['egress-denied: the sandbox has no network.', 'egress-denied'],
      ['unknown tool: x.get', 'tool-error'],
      ['worker exited with code 1', 'bridge'],
      ['SyntaxError: Unexpected end of input', 'bridge'],
    ]
    for (const [error, expected] of cases) {
      const bridge = new Bridge({ tools: {} }, () => {})
      const done = bridge.begin()
      bridge.handle({ kind: 'done', ok: false, error })
      expect((await done).failure, error).toBe(expected)
    }
  })
})

describe('egress denial', () => {
  it('denies fetch, which is the security claim the README makes', async () => {
    const r = await runProgram(
      `const res = await fetch('https://example.com'); return res.status`,
      {},
    )
    expect(r.result.ok).toBe(false)
    expect(r.result.error).toContain('egress-denied: the sandbox has no network')
  })

  it('denies every network global on the Node list', async () => {
    for (const name of NODE_DENIED) {
      // `typeof` does not shield a declared global whose getter throws, which is
      // what the denial installs. Reading the name is enough to be refused.
      const r = await runProgram(`return typeof ${name}`, {})
      expect(r.result.ok, `${name} should be denied`).toBe(false)
      expect(r.result.error, `${name} should be denied`).toContain('egress-denied')
    }
  })

  it('classifies a denied call as egress-denied', async () => {
    // SKIPPED: the denial works, the label does not. See the note on the program
    // that throws: the data: URL in the stack contains the text "SyntaxError", so
    // classify() calls this a syntax error. The refusal itself is asserted above.
    const r = await runProgram(`await fetch('https://example.com')`, {})
    expect(r.result.failure).toBe('egress-denied')
  })

  it('names the browser globals the iframe sandbox blocks as well', () => {
    // The browser list is wider because a page has more ways out.
    expect(BROWSER_DENIED).toContain('importScripts')
    expect(BROWSER_DENIED).toEqual(expect.arrayContaining(NODE_DENIED))
    // navigator stays, on purpose: overriding it breaks Node internals.
    expect(NODE_DENIED).not.toContain('navigator')
  })

  it('leaves a tool call as the only way out', async () => {
    const tools: ToolTable = { 'x.get': async () => 'from the tool' }
    const r = await runProgram(
      `let viaNetwork = null
       try { viaNetwork = await fetch('https://example.com') } catch (e) { viaNetwork = e.message }
       const viaTool = await x.get({})
       return { viaNetwork: viaNetwork.slice(0, 13), viaTool }`,
      tools,
    )
    expect(r.result.value).toEqual({ viaNetwork: 'egress-denied', viaTool: 'from the tool' })
  })
})

describe('the tool table is the whole capability list', () => {
  it('gives the program no namespace it was not granted', async () => {
    const r = await runProgram(`return await deepwiki.read_wiki_contents({})`, {
      'context7.query_docs': async () => 'x',
    })
    expect(r.result.ok).toBe(false)
    expect(r.result.error).toContain('deepwiki is not defined')
  })

  it('rejects a call to a tool that is not in the table', async () => {
    // The guest builds namespaces from the table, so this cannot come from a
    // program. It is driven through the Bridge directly, which is the only way in.
    const posted: unknown[] = []
    const bridge = new Bridge({ tools: { 'x.get': async () => 'ok' } }, (m) => posted.push(m))
    void bridge.begin()
    bridge.handle({ kind: 'call', id: 7, tool: 'x.delete_everything', args: {} })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      kind: 'result',
      id: 7,
      ok: false,
      error: 'unknown tool: x.delete_everything',
    })
  })

  it('exposes exactly the granted ids to the sandbox', () => {
    const bridge = new Bridge(
      { tools: { 'a.one': async () => 1, 'b.two': async () => 2 } },
      () => {},
    )
    expect(bridge.toolIds).toEqual(['a.one', 'b.two'])
  })

  it('settles once, so a late failure cannot overwrite a finished run', async () => {
    const bridge = new Bridge({ tools: {} }, () => {})
    const done = bridge.begin()
    bridge.handle({ kind: 'done', ok: true, value: 'first' })
    bridge.fail('too late')
    const r = await done
    expect(r.ok).toBe(true)
    expect(r.value).toBe('first')
  })
})

describe('toolTableFrom', () => {
  it('grants only the tools named in the allow list', async () => {
    const calls: string[] = []
    const client = {
      callTool: async (name: string) => {
        calls.push(name)
        return { content: [{ type: 'text', text: `text from ${name}` }] }
      },
    }
    const table = toolTableFrom({ deepwiki: client }, { deepwiki: ['read_wiki_contents'] })

    expect(Object.keys(table)).toEqual(['deepwiki.read_wiki_contents'])
    expect(await table['deepwiki.read_wiki_contents']({ repoName: 'a/b' })).toBe(
      'text from read_wiki_contents',
    )
    expect(calls).toEqual(['read_wiki_contents'])
  })

  it('grants nothing when no allow list is given', () => {
    const client = { callTool: async () => ({ content: [] }) }
    expect(Object.keys(toolTableFrom({ deepwiki: client }))).toEqual([])
  })

  it('hands the program plain text, not the MCP envelope', async () => {
    const client = {
      callTool: async () => ({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'two' },
        ],
      }),
    }
    const table = toolTableFrom({ s: client }, { s: ['t'] })
    expect(await table['s.t']({})).toBe('one\ntwo')
  })
})
