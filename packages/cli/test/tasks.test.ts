import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { utf8Bytes } from '@codemode-lab/meter'
import { SERVERS } from '@codemode-lab/mcp-client'
import { runInNodeSandbox } from '@codemode-lab/runtime/node'
import type { BoundaryEvent, ToolTable } from '@codemode-lab/runtime'
import { listTasks, loadTask } from '../src/tasks.js'

const TASKS_DIR = fileURLToPath(new URL('../../../tasks', import.meta.url))

/**
 * The shipped programs are run here against fake tools.
 *
 * They are real .js files for a reason: a `\b` inside a template literal is a
 * backspace character, and a regex written that way fails silently. Executing the
 * files offline is the cheapest way to keep that from coming back.
 */
async function runTask(
  id: string,
  tools: ToolTable,
): Promise<{ value: unknown; in: number; returnedBytes: number; ok: boolean; error?: string }> {
  const task = await loadTask(TASKS_DIR, id)
  const boundary: BoundaryEvent[] = []
  const r = await runInNodeSandbox(task.program, {
    tools,
    timeoutMs: 15_000,
    onBoundary: (ev) => boundary.push(ev),
  })
  return {
    value: r.value,
    ok: r.ok,
    error: r.error,
    in: boundary.filter((b) => b.direction === 'in').reduce((n, b) => n + b.bytes, 0),
    returnedBytes: utf8Bytes(r.value === undefined ? '' : JSON.stringify(r.value)),
  }
}

describe('the task set', () => {
  it('holds the three tasks the repo documents', async () => {
    expect(await listTasks(TASKS_DIR)).toEqual([
      'cross-repo-scan',
      'sequential-pair',
      'single-call',
    ])
  })

  it('predicts a loss more often than a win, which is the point of the set', async () => {
    const ids = await listTasks(TASKS_DIR)
    const tasks = await Promise.all(ids.map((id) => loadTask(TASKS_DIR, id)))
    const wins = tasks.filter((t) => t.expectCodeModeWins)
    expect(wins.map((t) => t.id)).toEqual(['cross-repo-scan'])
    // Every task says why it is in the set, including the ones written to lose.
    for (const t of tasks) {
      expect(t.why.length).toBeGreaterThan(40)
      expect(t.question.length).toBeGreaterThan(20)
      expect(t.id).toBe(ids[ids.indexOf(t.id)])
    }
  })

  it('names only servers the client knows, and never one that needs a token', async () => {
    for (const id of await listTasks(TASKS_DIR)) {
      const task = await loadTask(TASKS_DIR, id)
      for (const serverId of Object.keys(task.servers)) {
        const spec = SERVERS.find((s) => s.id === serverId)
        expect(spec, `${id} names ${serverId}`).toBeDefined()
        expect(spec!.needsAuth, `${id} uses ${serverId}`).toBe(false)
        expect(task.servers[serverId].length).toBeGreaterThan(0)
      }
    }
  })

  it('ships a program that parses, for every task', async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    for (const id of await listTasks(TASKS_DIR)) {
      const task = await loadTask(TASKS_DIR, id)
      const names = Object.keys(task.servers)
      // The same construction the guest uses, so a program that parses here parses there.
      expect(
        () => Reflect.construct(AsyncFunction, [...names, 'console', task.program]),
        `${id}/program.js`,
      ).not.toThrow()
    }
  })

  it('writes no em dash in any task file', async () => {
    for (const id of await listTasks(TASKS_DIR)) {
      const task = await loadTask(TASKS_DIR, id)
      expect(task.program, `${id}/program.js`).not.toContain('\u2014')
      expect(`${task.title}${task.question}${task.why}`, `${id}/task.json`).not.toContain('\u2014')
    }
  })

  it('reports a missing task by its path', async () => {
    await expect(loadTask(TASKS_DIR, 'no-such-task')).rejects.toThrow(/ENOENT/)
  })
})

describe('cross-repo-scan, the task that should win', () => {
  it('scans four payloads and returns four short rows', async () => {
    // A quarter of a megabyte per repo, with one real WebSocket line buried in each.
    const wiki = (repo: string) =>
      [
        '# ' + repo,
        'filler '.repeat(30_000),
        'The Agent exposes a WebSocket API on /ws.',
        'more text',
      ].join('\n')

    const seen: string[] = []
    const tools: ToolTable = {
      'deepwiki.read_wiki_contents': async (args) => {
        const { repoName } = args as { repoName: string }
        seen.push(repoName)
        return wiki(repoName)
      },
    }

    const r = await runTask('cross-repo-scan', tools)
    expect(r.ok, r.error).toBe(true)

    const rows = r.value as {
      repo: string
      charsScanned: number
      mentions: number
      evidence: string
    }[]
    expect(rows).toHaveLength(4)
    expect(seen.sort()).toEqual([
      'cloudflare/agents',
      'e2b-dev/E2B',
      'modelcontextprotocol/servers',
      'nodejs/undici',
    ])

    for (const row of rows) {
      // The word-boundary regex has to survive being read from a file.
      expect(row.mentions).toBe(1)
      expect(row.evidence).toBe('The Agent exposes a WebSocket API on /ws.')
      expect(row.charsScanned).toBeGreaterThan(200_000)
    }

    // The shape the project claims: a lot in, a little out.
    expect(r.in).toBeGreaterThan(800_000)
    expect(r.returnedBytes).toBeLessThan(600)
    expect(Math.round(r.in / r.returnedBytes)).toBeGreaterThan(1_000)
  })

  it('returns a null evidence line rather than inventing one', async () => {
    const tools: ToolTable = {
      'deepwiki.read_wiki_contents': async () => 'nothing about sockets here\nnor here',
    }
    const rows = (await runTask('cross-repo-scan', tools)).value as {
      mentions: number
      evidence: null
    }[]
    expect(rows.every((row) => row.mentions === 0 && row.evidence === null)).toBe(true)
  })

  it('does not match WebSocketish words, which is what \\b is for', async () => {
    const tools: ToolTable = {
      'deepwiki.read_wiki_contents': async () => 'see MyWebSocketFactory and websocketing',
    }
    const rows = (await runTask('cross-repo-scan', tools)).value as { mentions: number }[]
    expect(rows.every((row) => row.mentions === 0)).toBe(true)
  })
})

describe('the tasks written to lose', () => {
  it('single-call returns the whole payload, so nothing is saved', async () => {
    const structure = '- 1 Overview\n- 2 Getting Started\n- 3 Content Collections'
    const r = await runTask('single-call', {
      'deepwiki.read_wiki_structure': async () => structure,
    })
    expect(r.ok, r.error).toBe(true)
    expect(r.value).toBe(structure)
    // Everything that came in went back out. Code mode only added a round trip.
    expect(r.returnedBytes).toBeGreaterThanOrEqual(r.in)
  })

  it('sequential-pair chains two calls and still returns the whole document', async () => {
    const doc = 'Server actions are async functions. '.repeat(200)
    const calls: string[] = []
    const r = await runTask('sequential-pair', {
      'context7.resolve-library-id': async () => {
        calls.push('resolve')
        return 'Best match: /vercel/next.js (trust score 10)'
      },
      'context7.query-docs': async (args) => {
        calls.push(`query:${(args as { libraryId: string }).libraryId}`)
        return doc
      },
    })

    expect(r.ok, r.error).toBe(true)
    // The second call depends on the first, so the order is fixed and serial.
    expect(calls).toEqual(['resolve', 'query:/vercel/next.js'])
    expect(r.value).toBe(doc)
    // Truncating here would post a flattering ratio by throwing the answer away.
    expect(r.returnedBytes).toBeGreaterThan(utf8Bytes(doc))
  })

  it('sequential-pair falls back to a known library id when the match fails', async () => {
    const calls: string[] = []
    const r = await runTask('sequential-pair', {
      'context7.resolve-library-id': async () => 'no match found',
      'context7.query-docs': async (args) => {
        calls.push((args as { libraryId: string }).libraryId)
        return 'docs'
      },
    })
    expect(r.ok, r.error).toBe(true)
    expect(calls).toEqual(['/vercel/next.js'])
  })
})
