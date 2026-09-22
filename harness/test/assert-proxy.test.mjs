import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AssertionFailed, checkArm } from '../assert.mjs'
import { RAW_MAX_RESULT_CHARS, zodShape } from '../raw-proxy.mjs'

/** A result message as the SDK ends a run, with per-model usage. */
const result = (usage, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  modelUsage: { 'claude-sonnet-5': usage },
  ...extra,
})

describe('checkArm', () => {
  it('flags a cache leak in an uncached arm instead of discarding the run', () => {
    // One Sonnet run on 2026-09-22 read 7,692 cache tokens with caching off. The
    // same arm ran clean minutes later. Throwing kept nothing; the flag keeps it all.
    const u = checkArm({
      arm: 'A-uncached',
      result: result({
        inputTokens: 5000,
        outputTokens: 700,
        cacheReadInputTokens: 7692,
        cacheCreationInputTokens: 3887,
      }),
      initTools: [],
      expectedTools: [],
      cached: false,
    })
    expect(u.cacheLeak).toEqual({ read: 7692, creation: 3887 })
    expect(u.outcome).toBe('completed')
  })

  it('reports no leak for a clean uncached arm', () => {
    const u = checkArm({
      arm: 'A-uncached',
      result: result({ inputTokens: 5000, outputTokens: 700 }),
      initTools: [],
      cached: false,
    })
    expect(u.cacheLeak).toBeNull()
  })

  it('still discards a cached arm that never read its cache', () => {
    expect(() =>
      checkArm({
        arm: 'A-cached',
        result: result({ inputTokens: 5000, outputTokens: 700 }),
        initTools: [],
        cached: true,
      }),
    ).toThrow(AssertionFailed)
  })

  it('records a run that ran out of turns when the task allows it, with its usage', () => {
    const u = checkArm({
      arm: 'A-files',
      result: result(
        { inputTokens: 90_000, outputTokens: 2_000 },
        { subtype: 'error_max_turns', is_error: true },
      ),
      initTools: [],
      cached: false,
      mayNotComplete: true,
    })
    expect(u).toMatchObject({
      outcome: 'did-not-complete',
      subtype: 'error_max_turns',
      input: 90_000,
    })
  })

  it('discards a run that ran out of turns when the task does not allow it', () => {
    expect(() =>
      checkArm({
        arm: 'A-uncached',
        result: result({ inputTokens: 1 }, { subtype: 'error_max_turns', is_error: true }),
        initTools: [],
        cached: false,
        mayNotComplete: false,
      }),
    ).toThrow(/did not declare/)
  })

  it('discards an arm that loaded a tool it should not have', () => {
    expect(() =>
      checkArm({
        arm: 'A-uncached',
        result: result({ inputTokens: 1 }),
        initTools: ['mcp__deepwiki__read_wiki_contents', 'mcp__deepwiki__ask_wiki_question'],
        expectedTools: ['mcp__deepwiki__read_wiki_contents'],
        cached: false,
      }),
    ).toThrow(/extra: \[mcp__deepwiki__ask_wiki_question\]/)
  })
})

describe('the A-raw proxy', () => {
  it('lifts the persist-to-disk threshold to the documented ceiling, and no further', () => {
    expect(RAW_MAX_RESULT_CHARS).toBe(500_000)
  })

  it('rebuilds DeepWiki input schema, the union included', () => {
    // repoName is string | string[] on DeepWiki. A proxy that narrowed it would
    // hand A-raw a different tool from the one A-uncached reads.
    const shape = zodShape({
      type: 'object',
      properties: {
        repoName: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'GitHub repository in owner/repo format',
        },
        limit: { type: 'integer' },
      },
      required: ['repoName'],
    })
    const schema = z.object(shape)
    expect(schema.parse({ repoName: 'a/b' })).toEqual({ repoName: 'a/b' })
    expect(schema.parse({ repoName: ['a/b', 'c/d'], limit: 2 })).toEqual({
      repoName: ['a/b', 'c/d'],
      limit: 2,
    })
    expect(() => schema.parse({})).toThrow()
    expect(() => schema.parse({ repoName: 'a/b', limit: 1.5 })).toThrow()
    expect(shape.repoName.description).toBe('GitHub repository in owner/repo format')
  })
})
