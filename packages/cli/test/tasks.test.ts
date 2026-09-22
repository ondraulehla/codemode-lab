import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runInNodeSandbox } from '@codemode-lab/runtime/node'
import type { ToolTable } from '@codemode-lab/runtime'
import { listTasks, loadTask, type LoadedTask } from '../src/tasks.js'
// The harness is plain JavaScript outside the packages. Its arm names are the
// only list the task files may draw from.
import { ARM_NAMES, DEFAULT_ARMS } from '../../../harness/arms.mjs'

const TASKS_DIR = fileURLToPath(new URL('../../../tasks', import.meta.url))

const ids = await listTasks(TASKS_DIR)
const tasks: LoadedTask[] = await Promise.all(ids.map((id) => loadTask(TASKS_DIR, id)))
const byId = new Map(tasks.map((t) => [t.id, t]))

/** Fields the loader does not type, read straight off the task.json. */
type Extra = {
  expect: { mustMention: string[]; note: string }
  predictionUncertain?: boolean
  mayNotComplete?: string[]
  mayNotCompleteWhy?: string
  extraArms?: string[]
  extraArmsWhy?: string
  predictions?: Record<string, string>
}
const extra = (t: LoadedTask) => t as unknown as Extra

/**
 * The shipped programs are run here against fake tools.
 *
 * They are real .js files for a reason: a `\b` inside a template literal is a
 * backspace character, and a regex written that way fails silently. Executing the
 * files offline is the cheapest way to keep that from coming back.
 */
async function runTask(id: string, tools: ToolTable) {
  return runInNodeSandbox(byId.get(id)!.program, { tools, timeoutMs: 20_000 })
}

describe('the task set', () => {
  it('holds the five tasks the repo documents', () => {
    expect(ids).toEqual([
      'one-big-payload',
      'outline-leaves',
      'structure-rank',
      'table-heavy-page',
      'topic-overlap',
    ])
  })

  it('carries tasks written to lose, which is the point of the set', () => {
    const losers = tasks.filter((t) => !t.expectCodeModeWins).map((t) => t.id)
    expect(losers, 'a set with no losing case is marketing').toEqual([
      'outline-leaves',
      'structure-rank',
    ])
  })

  it('records one prediction as uncertain rather than guessing', () => {
    // Pre-registering an honest "I do not know" is worth more than a confident
    // prediction that gets quietly corrected after the run.
    const unsure = tasks.filter((t) => extra(t).predictionUncertain).map((t) => t.id)
    expect(unsure).toEqual(['topic-overlap'])
  })
})

describe('no grading string may appear in its own question', () => {
  // THIS is the test the first task set needed and did not have.
  //
  // The original question named four repositories and the grading checked that the
  // answer mentioned two of them. Both strings were in the question, so restating
  // the question scored a pass, and an arm that called no tool at all looked
  // correct. Every token number from that sweep was worthless because of it.
  for (const task of tasks) {
    it(`${task.id}`, () => {
      const question = task.question.toLowerCase()
      for (const graded of extra(task).expect.mustMention) {
        expect(
          question.includes(graded.toLowerCase()),
          `"${graded}" appears in the question, so the answer can be copied from the prompt`,
        ).toBe(false)
      }
    })
  }
})

describe('every task declares what it needs', () => {
  for (const task of tasks) {
    it(`${task.id} is complete and consistent`, () => {
      const x = extra(task)
      expect(task.question.length, 'a question must actually ask something').toBeGreaterThan(80)
      expect(x.expect.mustMention.length).toBeGreaterThan(0)
      expect(
        x.expect.note.length,
        'grading without a stated reason is not grading',
      ).toBeGreaterThan(60)
      expect(Object.keys(task.servers).length).toBeGreaterThan(0)
      expect(
        task.why.length,
        'a task that cannot say why it exists does not belong',
      ).toBeGreaterThan(80)

      // An arm may only fail where the task says so, and it must say why.
      if (x.mayNotComplete?.length) expect(x.mayNotCompleteWhy).toBeTruthy()
      for (const arm of x.mayNotComplete ?? []) expect(ARM_NAMES).toContain(arm)
    })
  }
})

describe('arms added to a task are named, justified and predicted', () => {
  for (const task of tasks) {
    const x = extra(task)
    if (!x.extraArms?.length) continue

    it(`${task.id} adds only arms the harness knows, with a reason`, () => {
      for (const arm of x.extraArms!) {
        expect(ARM_NAMES).toContain(arm)
        expect(DEFAULT_ARMS, `${arm} already runs on every task`).not.toContain(arm)
      }
      expect(x.extraArmsWhy?.length ?? 0).toBeGreaterThan(80)
    })

    it(`${task.id} recorded a dated prediction for each added arm before running it`, () => {
      expect(x.predictions?.recorded).toMatch(/^\d{4}-\d{2}-\d{2}, before/)
      for (const arm of x.extraArms!) {
        const said = Object.keys(x.predictions ?? {}).some((k) => k.endsWith(`vs ${arm}`))
        expect(said, `no prediction names ${arm}`).toBe(true)
      }
    })
  }
})

describe('every program is real JavaScript that targets its own tools', () => {
  for (const task of tasks) {
    const source = task.program

    it(`${task.id} parses as an async body`, () => {
      // The same construction the sandbox guest uses. A program that does not parse
      // here would fail in the sandbox for a reason unrelated to the hypothesis.
      const names = Object.keys(task.servers)
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      expect(() => Reflect.construct(AsyncFunction, [...names, 'console', source])).not.toThrow()
    })

    it(`${task.id} calls only the tools its task declares`, () => {
      for (const [server, allowed] of Object.entries(task.servers)) {
        const dotted = [
          ...source.matchAll(new RegExp(`\\b${server}\\.([A-Za-z0-9_]+)\\s*\\(`, 'g')),
        ].map((m) => m[1])
        const bracketed = [
          ...source.matchAll(new RegExp(`\\b${server}\\[['"]([^'"]+)['"]\\]\\s*\\(`, 'g')),
        ].map((m) => m[1])

        for (const used of [...dotted, ...bracketed]) {
          expect(
            allowed,
            `${task.id} calls ${server}.${used}, which its task does not allow`,
          ).toContain(used)
        }
      }
    })

    it(`${task.id} returns something`, () => {
      expect(source, 'a program with no return hands the model nothing').toMatch(/\breturn\b/)
    })
  }
})

describe('the set separates the two terms it is trying to measure', () => {
  // Payload size and fan-out moved together in the first set, so no result could say
  // which one decided the outcome. These two tasks pull them apart.
  it('one-big-payload is one call with a large payload', () => {
    expect(byId.get('one-big-payload')!.expectCodeModeWins).toBe(true)
    expect(byId.get('one-big-payload')!.program).not.toMatch(/Promise\.all/)
  })

  it('structure-rank is several small calls', () => {
    expect(byId.get('structure-rank')!.expectCodeModeWins).toBe(false)
    expect(byId.get('structure-rank')!.program).toMatch(/Promise\.all/)
  })
})

describe('the programs behave, run offline against fake tools', () => {
  it('one-big-payload ignores mermaid fences, which a naive count would not', async () => {
    const dump = [
      '# Page: Small',
      '```js',
      'a',
      '```',
      '# Page: Winner',
      '## The Heading',
      '```ts',
      'b',
      '```',
      '```js',
      'c',
      '```',
      '# Page: Diagrams',
      '```mermaid',
      'graph TD',
      '```',
      '```mermaid',
      'graph LR',
      '```',
      '```mermaid',
      'graph BT',
      '```',
    ].join('\n')

    const r = await runTask('one-big-payload', {
      'deepwiki.read_wiki_contents': async () => dump,
    })
    expect(r.ok, r.error).toBe(true)
    // Diagrams has the most fenced blocks and must still lose.
    expect(r.value).toEqual({ title: 'Winner', blocks: 2, heading: '## The Heading' })
  })

  it('one-big-payload fails loudly when the dump has no page markers', async () => {
    // A quiet null used to come back here, and a null reads like an answer.
    const r = await runTask('one-big-payload', {
      'deepwiki.read_wiki_contents': async () => 'This repository has not been indexed yet.',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no '# Page:' markers")
  })

  it('table-heavy-page fails loudly when a dump has no page markers', async () => {
    const r = await runTask('table-heavy-page', {
      'deepwiki.read_wiki_contents': async () => 'Repository not found.',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no '# Page:' markers")
  })

  it('outline-leaves takes top level entries only, not every childless entry', async () => {
    // The bug this asserts against: an earlier program called any entry with no
    // deeper neighbour a leaf, which matched sub-entries too and returned 17 titles
    // where the truth is 4.
    const outline = [
      'Available pages for withastro/astro:',
      '',
      '- 1 Alpha',
      '- 2 Beta',
      '  - 2.1 Beta Child',
      '  - 2.2 Beta Other',
      '- 3 Gamma',
    ].join('\n')

    const r = await runTask('outline-leaves', {
      'deepwiki.read_wiki_structure': async () => outline,
    })
    expect(r.ok, r.error).toBe(true)
    expect(r.value).toEqual(['Alpha', 'Gamma'])
  })

  it('structure-rank counts dash entries and joins the ranking', async () => {
    const sizes: Record<string, number> = {
      'apify/apify-mcp-server': 3,
      'cloudflare/agents': 5,
      'nodejs/undici': 1,
      'withastro/astro': 2,
    }
    const r = await runTask('structure-rank', {
      'deepwiki.read_wiki_structure': async (args) => {
        const repo = (args as { repoName: string }).repoName
        return Array.from({ length: sizes[repo] }, (_, i) => `- ${i + 1} Page`).join('\n')
      },
    })
    expect(r.ok, r.error).toBe(true)
    expect(r.value).toBe(
      'cloudflare/agents > apify/apify-mcp-server > withastro/astro > nodejs/undici',
    )
  })

  it('table-heavy-page counts pipe rows per page and keeps the first as evidence', async () => {
    const dump = [
      '# Page: Thin',
      '| only |',
      '# Page: Fat',
      '| first | row |',
      '| second | row |',
    ].join('\n')

    const r = await runTask('table-heavy-page', {
      'deepwiki.read_wiki_contents': async () => dump,
    })
    expect(r.ok, r.error).toBe(true)
    const rows = r.value as { repo: string; title: string; rows: number; evidence: string }[]
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.title).toBe('Fat')
      expect(row.rows).toBe(2)
      expect(row.evidence).toBe('| first | row |')
    }
  })

  it('topic-overlap keeps titles shared by two or more, and drops the numbering', async () => {
    const outlines: Record<string, string[]> = {
      'apify/apify-mcp-server': ['1 Shared', '2 Only Apify'],
      'cloudflare/agents': ['1 Shared', '2 Also Shared'],
      'e2b-dev/E2B': ['1 Also Shared'],
      'modelcontextprotocol/servers': ['1 Lonely'],
      'nodejs/undici': ['1 Shared'],
      'vercel/ai': ['1 Solo'],
      'withastro/astro': ['1 Single'],
    }
    const r = await runTask('topic-overlap', {
      'deepwiki.read_wiki_structure': async (args) => {
        const repo = (args as { repoName: string }).repoName
        return outlines[repo].map((l) => `- ${l}`).join('\n')
      },
    })
    expect(r.ok, r.error).toBe(true)
    expect(r.value).toEqual([
      {
        title: 'Shared',
        count: 3,
        repos: ['apify/apify-mcp-server', 'cloudflare/agents', 'nodejs/undici'],
      },
      { title: 'Also Shared', count: 2, repos: ['cloudflare/agents', 'e2b-dev/E2B'] },
    ])
  })
})
