/**
 * The assertions that decide whether a run is recorded or discarded.
 *
 * A harness that writes whatever came back is not a measurement. The worst failure
 * mode in this whole design is a crashed run: it carries zeroed usage, so it looks
 * like a valid arm that used no tokens. That does not read as an error. It reads
 * as a finding. These checks exist to stop that from ever reaching results/.
 */

export class AssertionFailed extends Error {
  constructor(check, detail) {
    super(`${check}: ${detail}`)
    this.name = 'AssertionFailed'
    this.check = check
  }
}

/**
 * Check one completed arm.
 *
 * `expectedTools` is the exact tool list the arm should have loaded. Comparing it
 * catches a server that hit the five second `alwaysLoad` connect timeout, which
 * would otherwise silently produce a smaller and wrong tool tax.
 */
export function checkArm({ arm, result, initTools, expectedTools, cached }) {
  if (!result) {
    throw new AssertionFailed('result-present', `arm ${arm} produced no result message`)
  }

  if (result.is_error) {
    throw new AssertionFailed(
      'is-error',
      `arm ${arm} returned is_error with subtype ${result.subtype}`,
    )
  }

  if (result.subtype === 'error_during_execution' || result.subtype === 'error_max_turns') {
    throw new AssertionFailed(
      'subtype',
      `arm ${arm} ended as ${result.subtype}, usage would be unreliable`,
    )
  }

  if (expectedTools) {
    const got = [...(initTools ?? [])].sort()
    const want = [...expectedTools].sort()
    if (got.join('|') !== want.join('|')) {
      throw new AssertionFailed(
        'tool-list',
        `arm ${arm} loaded ${got.length} tools, expected ${want.length}. ` +
          `missing: [${want.filter((t) => !got.includes(t)).join(', ')}] ` +
          `extra: [${got.filter((t) => !want.includes(t)).join(', ')}]`,
      )
    }
  }

  const u = totalUsage(result)

  // Assert the OUTCOME, never trust that the environment variable fired.
  if (!cached && (u.cacheRead > 0 || u.cacheCreation > 0)) {
    throw new AssertionFailed(
      'uncached',
      `arm ${arm} should carry no cache but read ${u.cacheRead} and created ${u.cacheCreation}`,
    )
  }
  if (cached && u.cacheRead === 0) {
    throw new AssertionFailed('cached', `arm ${arm} should read from cache but cache_read was 0`)
  }

  // Proves the five minute bucket ran. A one hour cache exists in only one billing
  // state, so a one hour number is not reproducible by a reader on another credential.
  if (u.ephemeral1h > 0) {
    throw new AssertionFailed(
      'cache-ttl',
      `arm ${arm} used the 1h cache bucket (${u.ephemeral1h} tokens). FORCE_PROMPT_CACHING_5M did not take effect.`,
    )
  }

  return u
}

/**
 * Read the usage that actually covers the whole run.
 *
 * `result.usage` is the main agent loop only. It excludes subagents, sidechains and
 * auxiliary calls. `result.modelUsage` covers them, and it is cumulative, so only
 * the last result message is read. Per-step output_tokens on assistant messages are
 * placeholders copied from message_start and must never be summed.
 */
export function totalUsage(result) {
  const out = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    ephemeral1h: 0,
    ephemeral5m: 0,
    byModel: {},
  }

  const models = result.modelUsage ?? {}
  for (const [model, u] of Object.entries(models)) {
    const input = u.inputTokens ?? u.input_tokens ?? 0
    const output = u.outputTokens ?? u.output_tokens ?? 0
    const cacheRead = u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0
    const cacheCreation = u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0
    const cc = u.cache_creation ?? u.cacheCreation ?? {}

    out.input += input
    out.output += output
    out.cacheRead += cacheRead
    out.cacheCreation += cacheCreation
    out.ephemeral1h += cc.ephemeral_1h_input_tokens ?? 0
    out.ephemeral5m += cc.ephemeral_5m_input_tokens ?? 0
    out.byModel[model] = { input, output, cacheRead, cacheCreation }
  }

  if (Object.keys(models).length === 0 && result.usage) {
    const u = result.usage
    out.input = u.input_tokens ?? 0
    out.output = u.output_tokens ?? 0
    out.cacheRead = u.cache_read_input_tokens ?? 0
    out.cacheCreation = u.cache_creation_input_tokens ?? 0
    out.degraded = 'modelUsage was empty, fell back to result.usage which excludes subagents'
  }

  return out
}

/**
 * The tool tax, in tokens the API counted.
 *
 * This is the identity the whole four-arm design exists to make available. Both
 * arms run uncached, so the entire prompt lands in input_tokens, and the only
 * difference between them is the tool definitions.
 */
export function toolTax(floorUsage, armUsage) {
  return armUsage.input - floorUsage.input
}
