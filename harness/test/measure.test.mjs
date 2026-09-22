import { describe, expect, it } from 'vitest'
import {
  TurnLog,
  answerClass,
  definitionTax,
  extraInputOverFloor,
  finalAnswer,
  grade,
  resultText,
} from '../measure.mjs'

/** An assistant message as the SDK streams it: one per content block. */
const assistant = (id, usage, content = [], parent = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, model: 'claude-opus-5', usage, content },
})

const toolResult = (content, parent = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
})

describe('TurnLog', () => {
  it('counts one turn per API response, not one per streamed block', () => {
    // The SDK emits one assistant message per content block, all with the same id
    // and the same usage. Counting each would triple this turn.
    const log = new TurnLog()
    const usage = { input_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    log.push(assistant('msg_1', usage, [{ type: 'thinking' }]))
    log.push(assistant('msg_1', usage, [{ type: 'text', text: 'hi' }]))
    log.push(assistant('msg_1', usage, [{ type: 'tool_use', id: 't1', name: 'mcp__deepwiki__x' }]))
    expect(log.summary().turns).toBe(1)
    expect(log.summary().toolCalls).toEqual({ mcp__deepwiki__x: 1 })
  })

  it('reads the prompt of a turn as input plus both cache fields', () => {
    const log = new TurnLog()
    log.push(
      assistant('a', {
        input_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    )
    log.push(
      assistant('b', {
        input_tokens: 10,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 900,
      }),
    )
    const s = log.summary()
    expect(s.turns).toBe(2)
    expect(s.turn1Prompt).toBe(500)
    // The peak is what the model read on its fullest request, cached or not.
    expect(s.peakPrompt).toBe(4910)
    expect(s.perTurn[1]).toEqual({ input: 10, cacheRead: 4000, cacheCreation: 900 })
  })

  it('keeps a subagent out of the main loop figures', () => {
    const log = new TurnLog()
    log.push(assistant('main', { input_tokens: 100 }))
    log.push(assistant('sub', { input_tokens: 90_000 }, [], 'toolu_parent'))
    const s = log.summary()
    expect(s.turns).toBe(1)
    expect(s.peakPrompt).toBe(100)
    expect(s.subagentTurns).toBe(1)
  })

  it('flags a result Claude Code moved to a file', () => {
    // The notice names a path in the session's tool-results directory. That path
    // segment is documented; the wording around it is not, so only it is matched.
    const log = new TurnLog()
    log.push(
      toolResult(
        'Output too large. Saved to /tmp/cml-cfg-a/projects/x/abc/tool-results/toolu_1.txt',
      ),
    )
    log.push(toolResult([{ type: 'text', text: '# Page: One\nbody' }]))
    const s = log.summary()
    expect(s.toolResults).toBe(2)
    expect(s.spilledResults).toBe(1)
    expect(s.toolResultBytes).toBeGreaterThan(0)
  })

  it('reads both shapes of tool_result content', () => {
    expect(resultText('plain')).toBe('plain')
    expect(
      resultText([
        { type: 'text', text: 'a' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
    expect(resultText(undefined)).toBe('')
  })
})

describe('grading the final answer', () => {
  const task = { expect: { mustMention: ['Filesystem Tools Reference'] } }

  it('takes the result text, not the whole transcript', () => {
    // An arm that wrote the right string on the way and then answered something
    // else passed when the whole transcript was graded. It fails now.
    const transcript = [
      { text: 'Maybe Filesystem Tools Reference? Let me check.' },
      { text: 'The page is Everything Server.' },
    ]
    const answer = finalAnswer({ result: 'The page is Everything Server.' }, transcript)
    expect(grade(task, answer).pass).toBe(false)
  })

  it('falls back to the last assistant text when there is no result text', () => {
    expect(finalAnswer(undefined, [{ text: 'first' }, { text: 'last' }])).toBe('last')
    expect(finalAnswer({ result: '   ' }, [{ text: 'last' }])).toBe('last')
  })

  it('matches case-insensitively and names what is missing', () => {
    expect(grade(task, 'filesystem tools reference')).toEqual({
      graded: true,
      pass: true,
      missing: [],
    })
    expect(grade(task, 'nothing')).toEqual({
      graded: true,
      pass: false,
      missing: ['Filesystem Tools Reference'],
    })
    expect(grade({}, 'x').graded).toBe(false)
  })
})

describe('answerClass', () => {
  const pass = { graded: true, pass: true }
  const fail = { graded: true, pass: false }

  it('separates an arm that never saw the data from one that got it wrong', () => {
    expect(answerClass({ grade: pass })).toBe('correct')
    expect(answerClass({ grade: fail, spilledResults: 1 })).toBe('no-data')
    expect(answerClass({ grade: fail, spilledResults: 0 })).toBe('wrong')
    // An arm that could open the file saw the data. Its failure is a wrong answer.
    expect(answerClass({ grade: fail, spilledResults: 2, canReadFiles: true })).toBe('wrong')
    expect(answerClass({ grade: { graded: false } })).toBe('ungraded')
  })
})

describe('the two tax figures', () => {
  it('measures the definition tax on the first request only', () => {
    expect(definitionTax(416, 1250)).toBe(834)
    expect(definitionTax(null, 1250)).toBeNull()
    expect(definitionTax(416, undefined)).toBeNull()
  })

  it('keeps all extra input as a separate, honestly named number', () => {
    expect(extraInputOverFloor({ input: 1415 }, { input: 26179 })).toBe(24764)
    expect(extraInputOverFloor(null, { input: 1 })).toBeNull()
  })
})
