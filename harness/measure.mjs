/**
 * What the harness reads off one arm's message stream, and how it grades it.
 *
 * Everything here is a pure function of SDK messages, so it is tested offline
 * against recorded shapes. run.mjs only feeds messages in and writes records out.
 */

/**
 * The path fragment Claude Code puts in a tool result it moved to a file.
 *
 * A result over the MCP output limit (25,000 tokens by default) is saved to the
 * session's `tool-results` directory, and the conversation gets a message that
 * names the file instead of the result. Documented at code.claude.com/docs/en/mcp.
 */
const SPILL_MARK = /[\\/]tool-results[\\/]/

/**
 * Collects per-turn usage and tool traffic from one arm's stream.
 *
 * Usage is recorded per API response, not per SDK message: while a response
 * streams, the SDK emits one assistant message per content block, and each of them
 * carries the same message id and the same usage. Summing them would count one turn
 * several times. Only the input side is read here. The input side is fixed when a
 * response starts. The output side is not final until the result message, so
 * output tokens are read from `modelUsage` there and never from here.
 */
export class TurnLog {
  constructor() {
    /** One entry per main-loop API response, in order. */
    this.turns = []
    /** One entry per tool call the model made in the main loop. */
    this.calls = []
    /** One entry per tool result that reached the conversation. */
    this.results = []
    this.seen = new Set()
  }

  /** Feed one SDK message. Messages from a subagent are kept apart. */
  push(m) {
    if (m?.type === 'assistant') this.#assistant(m)
    else if (m?.type === 'user') this.#user(m)
  }

  #assistant(m) {
    const msg = m.message ?? {}
    const main = m.parent_tool_use_id == null
    if (msg.id && !this.seen.has(msg.id)) {
      this.seen.add(msg.id)
      const u = msg.usage ?? {}
      const input = u.input_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheCreation = u.cache_creation_input_tokens ?? 0
      this.turns.push({
        model: msg.model ?? null,
        main,
        input,
        cacheRead,
        cacheCreation,
        // Everything the model read on this turn, cached or not. This is what
        // occupies the window, whatever it cost.
        prompt: input + cacheRead + cacheCreation,
      })
    }
    for (const block of msg.content ?? []) {
      if (block?.type === 'tool_use') this.calls.push({ id: block.id, name: block.name, main })
    }
  }

  #user(m) {
    const content = m.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const text = resultText(block.content)
      this.results.push({
        toolUseId: block.tool_use_id ?? null,
        bytes: utf8(text),
        spilled: SPILL_MARK.test(text),
        isError: block.is_error === true,
        main: m.parent_tool_use_id == null,
      })
    }
  }

  /** The numbers a sweep records for this arm. */
  summary() {
    const main = this.turns.filter((t) => t.main)
    return {
      turns: main.length,
      // The first request carries the system prompt, the tool definitions and the
      // question, and nothing else. Against the floor arm's first request it is the
      // definition tax, counted by the API.
      turn1Prompt: main[0]?.prompt ?? null,
      // The fullest the window got on any one request. This is the desk in the
      // README's picture, and a sum over turns cannot show it.
      peakPrompt: main.length ? Math.max(...main.map((t) => t.prompt)) : null,
      toolCalls: countBy(this.calls.filter((c) => c.main).map((c) => c.name)),
      toolResults: this.results.filter((r) => r.main).length,
      toolResultBytes: this.results.filter((r) => r.main).reduce((n, r) => n + r.bytes, 0),
      spilledResults: this.results.filter((r) => r.main && r.spilled).length,
      subagentTurns: this.turns.length - main.length,
      perTurn: main.map(({ input, cacheRead, cacheCreation }) => ({
        input,
        cacheRead,
        cacheCreation,
      })),
    }
  }
}

/** The text of a tool_result block, whichever of its two shapes it has. */
export function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/**
 * The answer an arm gave: the final result text, never the whole transcript.
 *
 * Grading the whole transcript let an arm pass on a string it wrote on the way and
 * then corrected away from. The result message carries exactly what the arm
 * handed back. The last assistant text is the fallback for a run that ended
 * without one.
 */
export function finalAnswer(result, transcript = []) {
  if (typeof result?.result === 'string' && result.result.trim()) return result.result
  return transcript.at(-1)?.text ?? ''
}

/**
 * Grade an answer deterministically.
 *
 * Substring checks a human can verify by reading. A model grading a model would put
 * the thing under test inside the measurement.
 */
export function grade(task, answer) {
  const must = task?.expect?.mustMention ?? []
  if (!must.length) return { graded: false, reason: 'no expect.mustMention in task.json' }
  const text = String(answer ?? '').toLowerCase()
  const missing = must.filter((m) => !text.includes(String(m).toLowerCase()))
  return { graded: true, pass: missing.length === 0, missing }
}

/**
 * Why an arm failed, in words a reader can check against the transcript.
 *
 * "No answer" and "wrong answer" are different findings. An arm whose only copy of
 * the data went to a file it had no tool to read never saw the data. An arm that
 * saw the data and still failed got it wrong. The published scoreboard once called
 * both "no answer".
 */
export function answerClass({ grade: g, spilledResults = 0, canReadFiles = false }) {
  if (!g?.graded) return 'ungraded'
  if (g.pass) return 'correct'
  if (spilledResults > 0 && !canReadFiles) return 'no-data'
  return 'wrong'
}

/**
 * The definition tax, counted by the API.
 *
 * First request against first request, both uncached. The only difference is what
 * the arm declares: tool definitions, and any server instructions the client adds.
 * Returns null when either side is missing rather than a number that looks real.
 */
export function definitionTax(floorTurn1, armTurn1) {
  if (floorTurn1 == null || armTurn1 == null) return null
  return armTurn1 - floorTurn1
}

/**
 * Every extra input token an arm used over the floor, across all turns.
 *
 * This includes tool results, the definitions resent on every turn, and the arm's
 * own earlier output read back as input. The sweep once published it as "tool tax"
 * and described it as the definitions alone. It is not.
 */
export function extraInputOverFloor(floorUsage, armUsage) {
  if (!floorUsage || !armUsage) return null
  return armUsage.input - floorUsage.input
}

function countBy(names) {
  const out = {}
  for (const n of names) out[n] = (out[n] ?? 0) + 1
  return out
}

const encoder = new TextEncoder()
function utf8(s) {
  return encoder.encode(s).length
}
