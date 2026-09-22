import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { McpTool } from '@codemode-lab/mcp-client'
import { generateSurface, schemaSurfaceBytes, schemaToType, toIdentifier } from '../src/index.js'

const run = promisify(execFile)

/** The real DeepWiki tools, read out of the captured tools/list response. */
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

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * Compile a generated surface with the real compiler.
 *
 * A surface that reads well but does not parse is worse than no surface: the model
 * writes a program against a type that does not exist. Only tsc can settle that.
 */
async function typeChecks(source: string): Promise<{ ok: boolean; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codemode-typegen-'))
  tempDirs.push(dir)
  const file = join(dir, 'surface.d.ts')
  await writeFile(file, source, 'utf8')
  const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url))
  try {
    // `--typeRoots` points at the empty temp dir and the child runs there, so the
    // repo's own @types never load. What compiles here is the generated file alone.
    const { stdout } = await run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--lib',
        'ES2022',
        '--typeRoots',
        dir,
        file,
      ],
      { cwd: dir },
    )
    return { ok: true, output: stdout }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('schemaToType', () => {
  it('renders anyOf as a union instead of collapsing it to unknown', () => {
    // DeepWiki's repoName. A model told this is only `string` writes a loop it
    // did not need, and a model told `unknown` cannot write anything at all.
    const repoName = DEEPWIKI_TOOLS.find((t) => t.name === 'ask_question')!.inputSchema.properties!
      .repoName
    expect(schemaToType(repoName)).toBe('string | string[]')
  })

  it('renders oneOf as a union and drops duplicate members', () => {
    expect(schemaToType({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      'string | number',
    )
    expect(schemaToType({ anyOf: [{ type: 'string' }, { type: 'string' }] })).toBe('string')
  })

  it('renders a type array as a union', () => {
    expect(schemaToType({ type: ['string', 'null'] })).toBe('string | null')
  })

  it('renders enum and const as literals', () => {
    expect(schemaToType({ type: 'string', enum: ['python', 'csharp'] })).toBe('"python" | "csharp"')
    expect(schemaToType({ enum: [1, true, null] })).toBe('1 | true | null')
    expect(schemaToType({ const: 'fixed' })).toBe('"fixed"')
  })

  it('renders the primitive types', () => {
    expect(schemaToType({ type: 'string' })).toBe('string')
    expect(schemaToType({ type: 'integer' })).toBe('number')
    expect(schemaToType({ type: 'number' })).toBe('number')
    expect(schemaToType({ type: 'boolean' })).toBe('boolean')
    expect(schemaToType({ type: 'null' })).toBe('null')
    expect(schemaToType(undefined)).toBe('unknown')
    expect(schemaToType({})).toBe('unknown')
  })

  it('renders arrays, including arrays of objects', () => {
    expect(schemaToType({ type: 'array', items: { type: 'string' } })).toBe('string[]')
    expect(schemaToType({ type: 'array' })).toBe('unknown[]')
    expect(
      schemaToType({
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      }),
    ).toBe('{\n  id: number\n}[]')
  })

  it('marks a property optional unless it is required', () => {
    const t = schemaToType({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    })
    expect(t).toContain('query: string')
    expect(t).toContain('limit?: number')
  })

  it('nests objects and keeps their descriptions', () => {
    const t = schemaToType({
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'narrowing',
          properties: { since: { type: 'string', description: 'ISO date' } },
          required: ['since'],
        },
      },
      required: ['filter'],
    })
    expect(t).toBe(
      '{\n  /** narrowing */\n  filter: {\n    /** ISO date */\n    since: string\n  }\n}',
    )
  })

  it('quotes property keys that are not identifiers', () => {
    const t = schemaToType({
      type: 'object',
      properties: {
        'content-type': { type: 'string' },
        '2fa': { type: 'boolean' },
        ok: { type: 'string' },
      },
      required: ['content-type', '2fa', 'ok'],
    })
    expect(t).toContain('"content-type": string')
    expect(t).toContain('"2fa": boolean')
    expect(t).toContain('ok: string')
  })

  it('treats an object with no declared properties as an open record', () => {
    expect(schemaToType({ type: 'object' })).toBe('Record<string, unknown>')
    expect(schemaToType({ type: 'object', properties: {} })).toBe('Record<string, unknown>')
  })

  it('infers object from properties alone when type is missing', () => {
    expect(schemaToType({ properties: { a: { type: 'string' } }, required: ['a'] })).toBe(
      '{\n  a: string\n}',
    )
  })

  it('renders allOf as an intersection', () => {
    expect(
      schemaToType({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      }),
    ).toBe('{\n  a: string\n} & {\n  b: number\n}')
  })

  it('reports an unhandled type rather than hiding it', () => {
    const warnings: string[] = []
    expect(schemaToType({ type: 'tuple' } as never, 0, warnings)).toBe('unknown')
    expect(warnings).toEqual(['unhandled schema type: "tuple"'])
  })

  it('does not let a description close the comment it lives in', () => {
    const t = schemaToType({
      type: 'object',
      properties: { a: { type: 'string', description: 'ends the block */ and continues' } },
      required: ['a'],
    })
    expect(t).not.toContain('*/ and')
    expect(t).toContain('* /')
  })
})

describe('toIdentifier', () => {
  it('turns kebab-case and dotted MCP names into identifiers', () => {
    expect(toIdentifier('resolve-library-id')).toBe('resolve_library_id')
    expect(toIdentifier('microsoft.docs.search')).toBe('microsoft_docs_search')
    expect(toIdentifier('read_wiki_contents')).toBe('read_wiki_contents')
    expect(toIdentifier('tool name with spaces')).toBe('tool_name_with_spaces')
  })

  it('suffixes a reserved word so the declaration still parses', () => {
    expect(toIdentifier('delete')).toBe('delete_')
    expect(toIdentifier('new')).toBe('new_')
    expect(toIdentifier('function')).toBe('function_')
    expect(toIdentifier('class')).toBe('class_')
  })

  it('prefixes a leading digit', () => {
    expect(toIdentifier('2fa-check')).toBe('_2fa_check')
  })
})

describe('generateSurface', () => {
  it('reproduces the measured DeepWiki numbers', () => {
    const g = generateSurface('deepwiki', DEEPWIKI_TOOLS)
    expect(schemaSurfaceBytes(DEEPWIKI_TOOLS)).toBe(1526)
    // 1,157 B until 2026-09-22, when each function still returned the declared
    // `{ result: string }`. The runtime hands over a string, so the surface says so.
    expect(g.bytes).toBe(1103)
    expect(g.warnings).toEqual([])
    expect(g.perTool.map((p) => p.name)).toEqual([
      'ask_question',
      'read_wiki_contents',
      'read_wiki_structure',
    ])
    expect(g.perTool.reduce((n, p) => n + p.bytes, 0)).toBeLessThan(g.bytes)
    // The union survives all the way into the shipped surface.
    expect(g.source).toContain('repoName: string | string[]')
  })

  it('counts bytes as UTF-8, not as characters', () => {
    const tool: McpTool = {
      name: 'search',
      description: 'Hledá v české dokumentaci',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    }
    const g = generateSurface('cs', [tool])
    expect(g.bytes).toBe(Buffer.byteLength(g.source, 'utf8'))
    expect(g.bytes).toBeGreaterThan(g.source.length)
  })

  it('returns a plain string for a FastMCP wrapper, because that is what the runtime hands over', () => {
    // DeepWiki declares `{ result: string }` with x-fastmcp-wrap-result. The runtime
    // gives the program the text, so a surface that says `{ result: string }` lies,
    // and a model that believes it writes `.result` on a string.
    const g = generateSurface('deepwiki', DEEPWIKI_TOOLS)
    expect(DEEPWIKI_TOOLS.every((t) => t.outputSchema?.['x-fastmcp-wrap-result'] === true)).toBe(
      true,
    )
    expect(g.source).toContain('export function read_wiki_contents(args: {')
    expect(g.source.match(/Promise<string>/g)).toHaveLength(DEEPWIKI_TOOLS.length)
    expect(g.source).not.toContain('result: string')
    expect(g.source).not.toContain('_output')
  })

  it('names the inner shape when a FastMCP wrapper holds something other than a string', () => {
    const g = generateSurface('x', [
      {
        name: 'list',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'number' } } },
          required: ['result'],
          'x-fastmcp-wrap-result': true,
        },
      },
    ])
    expect(g.source).toContain('export type list_output = number[]')
    expect(g.source).toContain('export function list(): Promise<string>')
  })

  it('drops the args parameter for a tool that takes none', () => {
    const g = generateSurface('x', [{ name: 'ping', inputSchema: { type: 'object' } }])
    expect(g.source).toContain('export function ping(): Promise<string>')
  })

  it('names the MCP tool in the doc when the identifier had to change', () => {
    const g = generateSurface('context7', [
      { name: 'resolve-library-id', inputSchema: { type: 'object' } },
    ])
    expect(g.source).toContain('MCP tool name: resolve-library-id')
    expect(g.source).toContain('export function resolve_library_id()')
  })

  it('truncates a description instead of letting one tool dominate', () => {
    const g = generateSurface(
      'x',
      [{ name: 'verbose', description: 'w '.repeat(500), inputSchema: { type: 'object' } }],
      { maxDescriptionChars: 40 },
    )
    expect(g.source).toContain('...')
    expect(g.bytes).toBeLessThan(400)
  })

  it('omits descriptions when asked, which is the cheap surface', () => {
    const withDocs = generateSurface('deepwiki', DEEPWIKI_TOOLS)
    const without = generateSurface('deepwiki', DEEPWIKI_TOOLS, { includeDescriptions: false })
    expect(without.bytes).toBeLessThan(withDocs.bytes)
    expect(without.source).not.toContain('AI-powered')
  })

  it('uses a safe namespace name for a server id that is not an identifier', () => {
    const g = generateSurface('learn.microsoft.com', [{ name: 'a', inputSchema: {} }])
    expect(g.source).toContain('declare namespace learn_microsoft_com {')
  })
})

describe('the generated surface is real TypeScript', () => {
  it('compiles the DeepWiki surface with tsc --strict', async () => {
    const { ok, output } = await typeChecks(generateSurface('deepwiki', DEEPWIKI_TOOLS).source)
    expect(output).toBe('')
    expect(ok).toBe(true)
  })

  it('compiles a surface built from every hard construct at once', async () => {
    const hard: McpTool[] = [
      {
        name: 'delete',
        description: 'A reserved word, and a name that must be suffixed.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'resolve-library-id',
        description: 'Kebab-case, plus a union and an enum.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryName: {
              anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            mode: { type: 'string', enum: ['strict', 'loose'] },
            'content-type': { type: 'string' },
            nested: {
              type: 'object',
              properties: { deep: { type: 'array', items: { type: 'object' } } },
              required: ['deep'],
            },
          },
          required: ['libraryName'],
        },
        outputSchema: {
          type: 'object',
          properties: { hits: { type: 'array', items: { type: 'string' } } },
          required: ['hits'],
        },
      },
      { name: '2fa-check', inputSchema: { type: 'object' } },
      {
        name: 'weird',
        description: 'Contains */ which must not close the JSDoc block.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: ['string', 'null'] } },
          required: ['a'],
        },
      },
    ]
    const g = generateSurface('everything', hard)
    const { ok, output } = await typeChecks(g.source)
    expect(output).toBe('')
    expect(ok).toBe(true)
  })

  it('declares a named JSON shape but still returns a string for a real output schema', async () => {
    const g = generateSurface('x', [
      {
        name: 'search',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { hits: { type: 'array', items: { type: 'string' } } },
          required: ['hits'],
        },
      },
    ])
    expect(g.source).toContain('export function search(): Promise<string>')
    expect(g.source).toContain('export type search_output = {')
    expect(g.source).toContain('hits: string[]')
    expect((await typeChecks(g.source)).ok).toBe(true)
  })

  it('a surface that did not escape a comment would be caught by this check', async () => {
    // Proof the compile step can fail. If this passed, the two tests above prove nothing.
    const broken =
      'declare namespace x {\n  /** oops */ and more */\n  export function a(): void\n}\n'
    expect((await typeChecks(broken)).ok).toBe(false)
  })
})

/**
 * Type-check a task's reference program against the surface the model would read.
 *
 * The reference programs are the ground truth for what the runtime hands a program:
 * they were run against the live server and they work. A surface they do not
 * type-check against is a surface that lies to the model. This is the check that
 * would have caught the `{ result: string }` bug before a sweep paid for it.
 */
async function programTypeChecks(
  surface: string,
  program: string,
): Promise<{ ok: boolean; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codemode-program-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'surface.d.ts'), surface, 'utf8')
  // The sandbox gives a program console.log and nothing else of the host.
  await writeFile(
    join(dir, 'globals.d.ts'),
    'declare const console: { log(...args: unknown[]): void }\n',
    'utf8',
  )
  // A program uses top level await and return, as the sandbox allows. Wrapping it
  // in an async function is what the sandbox does too.
  await writeFile(
    join(dir, 'program.js'),
    `// @ts-check\nasync function __program() {\n${program}\n}\n`,
    'utf8',
  )
  const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url))
  try {
    await run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--allowJs',
        '--checkJs',
        '--target',
        'ES2022',
        '--lib',
        'ES2022',
        '--typeRoots',
        dir,
        join(dir, 'surface.d.ts'),
        join(dir, 'globals.d.ts'),
        join(dir, 'program.js'),
      ],
      { cwd: dir },
    )
    return { ok: true, output: '' }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const TASKS_DIR = fileURLToPath(new URL('../../../tasks/', import.meta.url))
const TASK_IDS = readdirSync(TASKS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

describe('every reference program type-checks against the surface the model reads', () => {
  it('finds the tasks', () => {
    expect(TASK_IDS.length).toBeGreaterThan(0)
  })

  for (const id of TASK_IDS) {
    it(`tasks/${id}/program.js`, async () => {
      const task = JSON.parse(readFileSync(join(TASKS_DIR, id, 'task.json'), 'utf8')) as {
        servers: Record<string, string[]>
      }
      // Only DeepWiki has a captured tools/list. A task on another server needs its
      // own fixture before this check can cover it, and the test says so.
      expect(Object.keys(task.servers)).toEqual(['deepwiki'])
      const allowed = DEEPWIKI_TOOLS.filter((t) => task.servers.deepwiki.includes(t.name))
      expect(allowed.map((t) => t.name).sort()).toEqual([...task.servers.deepwiki].sort())

      const program = readFileSync(join(TASKS_DIR, id, 'program.js'), 'utf8')
      const { ok, output } = await programTypeChecks(
        generateSurface('deepwiki', allowed).source,
        program,
      )
      expect(output).toBe('')
      expect(ok).toBe(true)
    })
  }

  it('fails a program that trusts a result shape the runtime does not deliver', async () => {
    // Proof the check can fail. This is the program a model wrote against the old
    // surface, which promised `{ result: string }`.
    const program =
      "const dump = await deepwiki.read_wiki_contents({ repoName: 'a/b' })\n" +
      'return dump.result.split("\\n").length\n'
    const surface = generateSurface(
      'deepwiki',
      DEEPWIKI_TOOLS.filter((t) => t.name === 'read_wiki_contents'),
    ).source
    const { ok, output } = await programTypeChecks(surface, program)
    expect(ok).toBe(false)
    expect(output).toContain("Property 'result' does not exist on type 'string'")
  })
})
