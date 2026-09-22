import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ARM_NAMES,
  CACHED_ARMS,
  DEFAULT_ARMS,
  FILE_TOOLS,
  UNCACHED_ARMS,
  armOptions,
  canReadFiles,
  disallowedFor,
  expectedToolsFor,
} from '../arms.mjs'

const task = {
  servers: { deepwiki: ['read_wiki_contents'] },
  systemPrompt: 'Answer.',
}
// The live names on 2026-09-22. ask_question became ask_wiki_question that day.
const serverTools = { deepwiki: ['ask_wiki_question', 'read_wiki_contents', 'read_wiki_structure'] }

beforeAll(() => {
  // armEnv refuses to build an environment without a credential. None is used here.
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'test-only')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const ctx = {
  task,
  picked: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
  cfg: { model: 'claude-opus-5' },
  configDir: '/tmp/cml-cfg-test',
  workDir: '/tmp/cml-work-test',
  disallowed: disallowedFor(task, serverTools),
  codemode: { type: 'sdk', name: 'codemode' },
}

describe('both arms declare the same tools', () => {
  it('removes every live tool the task does not allow, by its current name', () => {
    expect(disallowedFor(task, serverTools)).toEqual([
      'mcp__deepwiki__ask_wiki_question',
      'mcp__deepwiki__read_wiki_structure',
    ])
  })

  it('expects exactly the allowed tools at init, per arm', () => {
    expect(expectedToolsFor('floor', task)).toEqual([])
    expect(expectedToolsFor('A-uncached', task)).toEqual(['mcp__deepwiki__read_wiki_contents'])
    expect(expectedToolsFor('A-raw', task)).toEqual(['mcp__deepwiki__read_wiki_contents'])
    expect(expectedToolsFor('A-files', task)).toEqual([
      'mcp__deepwiki__read_wiki_contents',
      ...FILE_TOOLS,
    ])
    expect(expectedToolsFor('B-cached', task)).toEqual(['mcp__codemode__run_code'])
  })
})

describe('armOptions', () => {
  const opts = (arm) => armOptions(arm, ctx)

  it('builds every arm, and refuses one it does not know', () => {
    for (const arm of ARM_NAMES) expect(() => opts(arm)).not.toThrow()
    expect(() => opts('A-magic')).toThrow(/unknown arm/)
  })

  it('runs every arm in an empty directory with its own config directory', () => {
    // The default cwd was the repository, where tasks/<id>/task.json holds the
    // grading strings. An arm that can Grep would find them.
    for (const arm of ARM_NAMES) {
      const o = opts(arm)
      expect(o.cwd).toBe('/tmp/cml-work-test')
      expect(o.env.CLAUDE_CONFIG_DIR).toBe('/tmp/cml-cfg-test')
      expect(o.permissionMode).toBe('dontAsk')
      expect(o.settingSources).toEqual([])
    }
  })

  it('removes the disallowed tools from every direct arm', () => {
    for (const arm of ['A-uncached', 'A-cached', 'A-files', 'A-raw']) {
      expect(opts(arm).disallowedTools).toEqual(ctx.disallowed)
      expect(opts(arm).mcpServers).toBe(ctx.picked)
    }
  })

  it('gives A-files Read and Grep, and nothing that reaches the network', () => {
    const o = opts('A-files')
    expect(o.tools).toEqual(['Read', 'Grep'])
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Grep']))
    expect(o.tools).not.toContain('Bash')
    expect(o.additionalDirectories).toEqual(['/tmp/cml-cfg-test'])
    expect(canReadFiles('A-files')).toBe(true)
    expect(canReadFiles('A-uncached')).toBe(false)
  })

  it('raises the MCP output limit only for A-raw', () => {
    expect(opts('A-raw').env.MAX_MCP_OUTPUT_TOKENS).toBe('1000000')
    expect(opts('A-raw').maxBudgetUsd).toBe(15)
    for (const arm of ARM_NAMES.filter((a) => a !== 'A-raw')) {
      expect(opts(arm).env.MAX_MCP_OUTPUT_TOKENS).toBeUndefined()
    }
  })

  it('turns caching off in exactly the uncached arms', () => {
    for (const arm of UNCACHED_ARMS) expect(opts(arm).env.DISABLE_PROMPT_CACHING).toBe('1')
    for (const arm of CACHED_ARMS) expect(opts(arm).env.DISABLE_PROMPT_CACHING).toBeUndefined()
  })

  it('gives the code mode arms one tool and no remote server', () => {
    for (const arm of ['B-uncached', 'B-cached']) {
      expect(opts(arm).allowedTools).toEqual(['mcp__codemode__run_code'])
      expect(Object.keys(opts(arm).mcpServers)).toEqual(['codemode'])
    }
  })

  it('keeps the default set to the five arms of the original design', () => {
    expect(DEFAULT_ARMS).toEqual(['floor', 'A-uncached', 'A-cached', 'B-uncached', 'B-cached'])
  })
})
