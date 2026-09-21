import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { McpTool } from '@codemode-lab/mcp-client'
import { getServer } from '@codemode-lab/mcp-client'
import { planProbes, verdict } from '../src/scan.js'
import type { ScanReport } from '../src/scan.js'

/** The real DeepWiki tools, from the captured tools/list response. */
const DEEPWIKI_TOOLS: McpTool[] = (() => {
  const body = readFileSync(
    fileURLToPath(new URL('../../../test/fixtures/deepwiki-tools-list.sse', import.meta.url)),
    'utf8',
  )
  const data = body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .join('\n')
  return (JSON.parse(data) as { result: { tools: McpTool[] } }).result.tools
})()

const tool = (
  name: string,
  inputSchema: McpTool['inputSchema'] = {},
  rest: Partial<McpTool> = {},
): McpTool => ({
  name,
  inputSchema,
  ...rest,
})

describe('planProbes', () => {
  it('skips tools whose name says they spend the provider money', () => {
    const names = [
      'ask_question',
      'chat',
      'complete_text',
      'generate_image',
      'run_actor',
      'create_issue',
      'delete_repo',
      'update_file',
      'write_note',
      'post_message',
      'send_email',
    ]
    const plan = planProbes(names.map((n) => tool(n, { type: 'object' })))
    expect(plan).toEqual([])
  })

  it('probes a read-only tool that needs nothing', () => {
    expect(planProbes([tool('list_repos', { type: 'object' })])).toEqual([
      { tool: 'list_repos', args: {} },
    ])
  })

  it('skips a tool with a required argument it cannot invent', () => {
    const plan = planProbes([
      tool('search', {
        type: 'object',
        properties: { filter: { type: 'object', properties: { since: { type: 'string' } } } },
        required: ['filter'],
      }),
      tool('by_list', {
        type: 'object',
        properties: { ids: { type: 'array' } },
        required: ['ids'],
      }),
      tool('no_schema_for_it', { type: 'object', required: ['mystery'] }),
    ])
    // Reporting "not probed" beats inventing an object and reporting its error.
    expect(plan).toEqual([])
  })

  it('invents only the required arguments, by type', () => {
    const plan = planProbes([
      tool('search', {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          depth: { type: 'number' },
          verbose: { type: 'boolean' },
          optional: { type: 'string' },
        },
        required: ['query', 'limit', 'depth', 'verbose'],
      }),
    ])
    expect(plan).toEqual([
      { tool: 'search', args: { query: 'getting started', limit: 1, depth: 1, verbose: false } },
    ])
  })

  it('prefers the first enum value over an invented string', () => {
    const plan = planProbes([
      tool('docs', {
        type: 'object',
        properties: { language: { type: 'string', enum: ['python', 'csharp'] } },
        required: ['language'],
      }),
    ])
    expect(plan[0].args).toEqual({ language: 'python' })
  })

  it('reads the first entry of a type array', () => {
    const plan = planProbes([
      tool('q', {
        type: 'object',
        properties: { s: { type: ['string', 'null'] } },
        required: ['s'],
      }),
    ])
    expect(plan[0].args).toEqual({ s: 'getting started' })
  })

  it('skips a tool that declares itself not read-only', () => {
    const plan = planProbes([
      tool('mutate_thing', { type: 'object' }, { annotations: { readOnlyHint: false } }),
      tool('read_thing', { type: 'object' }, { annotations: { readOnlyHint: true } }),
    ])
    expect(plan.map((p) => p.tool)).toEqual(['read_thing'])
  })

  it('lets a hint override the generic query', () => {
    const plan = planProbes(
      [
        tool('microsoft_docs_search', {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        }),
      ],
      { microsoft_docs_search: { query: 'durable functions orchestration patterns' } },
    )
    // Measured: the generic query returns 14 bytes here, a real one returns 24 kB.
    // A probe is only as honest as its arguments.
    expect(plan).toEqual([
      {
        tool: 'microsoft_docs_search',
        args: { query: 'durable functions orchestration patterns' },
      },
    ])
  })

  it('lets a hint reach a tool the name filter would have skipped', () => {
    const plan = planProbes([tool('ask_question', { type: 'object' })], {
      ask_question: { repoName: 'nodejs/undici', question: 'what is a Pool' },
    })
    expect(plan.map((p) => p.tool)).toEqual(['ask_question'])
  })

  it('plans the real DeepWiki tools the way the repo says it does', () => {
    const plain = planProbes(DEEPWIKI_TOOLS)
    // ask_question is skipped by name. Both read tools take one string.
    expect(plain).toEqual([
      { tool: 'read_wiki_contents', args: { repoName: 'getting started' } },
      { tool: 'read_wiki_structure', args: { repoName: 'getting started' } },
    ])

    // "getting started" is not a repository, so the registry carries real hints.
    const hinted = planProbes(DEEPWIKI_TOOLS, getServer('deepwiki').probeHints)
    expect(hinted).toEqual([
      { tool: 'read_wiki_contents', args: { repoName: 'cloudflare/agents' } },
      { tool: 'read_wiki_structure', args: { repoName: 'cloudflare/agents' } },
    ])
  })
})

const report = (over: Partial<ScanReport> = {}): ScanReport => ({
  server: 'DeepWiki',
  url: 'https://mcp.deepwiki.com/mcp',
  mode: 'stateless',
  toolCount: 3,
  schemaBytes: 1526,
  surfaceBytes: 1157,
  probes: [],
  warnings: [],
  ...over,
})

const probe = (textBytes: number, tool = 'read_wiki_contents') => ({
  tool,
  args: {},
  wireBytes: textBytes * 2,
  textBytes,
  ms: 1000,
})

describe('verdict', () => {
  it('says nothing was probed when nothing was', () => {
    expect(verdict(report())).toBe('DeepWiki: 3 tools, no payload probed.')
    expect(verdict(report({ probes: [{ ...probe(0), error: 'HTTP 400' }] }))).toContain(
      'no payload probed',
    )
  })

  it('says a single call does not fit when it fills the window', () => {
    // 800 kB of text. At 3.3 to 3.8 bytes per token that is 105% to 121% of 200K.
    const v = verdict(report({ probes: [probe(800_000)] }))
    expect(v).toContain('One call does not fit')
    expect(v).toContain('it is the only way to run the task')
  })

  it('warns about two or three calls in the middle band', () => {
    const v = verdict(report({ probes: [probe(200_000)] }))
    expect(v).toContain('Two or three calls exhaust the window')
    expect(v).not.toContain('does not fit')
  })

  it('recommends prompt caching first when payloads are small', () => {
    const v = verdict(report({ probes: [probe(20_000)] }))
    expect(v).toContain('Turn on prompt caching first')
    expect(v).toContain('mostly cost you a round trip')
  })

  it('judges by the largest successful probe and ignores failed ones', () => {
    const v = verdict(
      report({
        probes: [
          { ...probe(900_000, 'read_wiki_contents'), error: 'timeout' },
          probe(20_000, 'read_wiki_structure'),
        ],
      }),
    )
    expect(v).toContain('read_wiki_structure')
    expect(v).toContain('Turn on prompt caching first')
  })

  it('always states a band and never a single confident token count', () => {
    const v = verdict(report({ probes: [probe(683_700)] }))
    // The measured cloudflare/agents payload: 92% to 106% of a 200K window.
    expect(v).toMatch(/roughly [\d,]+ to [\d,]+ tokens/)
    expect(v).toMatch(/which is \d+% to \d+% of a 200K window/)
    expect(v).toContain('179,921 to 207,182 tokens')
    expect(v).toContain('90% to 104% of a 200K window')
  })

  it('takes the window size from the caller', () => {
    const v = verdict(report({ probes: [probe(200_000)] }), 1_000_000)
    expect(v).toContain('of a 1000K window')
    expect(v).toContain('Turn on prompt caching first')
  })

  it('compares the payload against the whole definition surface', () => {
    const v = verdict(report({ schemaBytes: 1526, probes: [probe(762_000)] }))
    expect(v).toContain('499x the entire tool definition surface')
    expect(v).toContain('about 402 tokens to declare')
  })

  it('writes no em dash, which is the house rule for every string that ships', () => {
    for (const bytes of [20_000, 200_000, 800_000]) {
      expect(verdict(report({ probes: [probe(bytes)] }))).not.toContain('\u2014')
    }
  })
})
