import { armEnv } from './env.mjs'

/**
 * The MCP servers each arm sees.
 *
 * `alwaysLoad` points the SDK straight at the live endpoint, so the server's own
 * JSON Schema reaches the model unmodified. Wrapping the servers in a proxy or
 * re-declaring the tools by hand would insert a schema this project authored, and
 * every byte of difference would land in the number being measured.
 *
 * `permission_policy: 'always_deny'` on the expensive tools is deliberate. The
 * definition stays in context, so the tax stays real, but the call is blocked. Two
 * of these tools are backed by a language model and spend the provider's money.
 */
export const SERVERS = {
  deepwiki: {
    type: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    alwaysLoad: true,
    timeout: 60_000,
    tools: [{ name: 'ask_question', permission_policy: 'always_deny' }],
  },
  context7: {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    alwaysLoad: true,
    timeout: 30_000,
  },
  mslearn: {
    // maxTokenBudget caps the payload. Without it one search can add tens of
    // thousands of tokens to the uncached arm on every later turn.
    url: 'https://learn.microsoft.com/api/mcp?maxTokenBudget=2000',
    type: 'http',
    alwaysLoad: true,
    timeout: 30_000,
  },
  apify: apifyServer(),
}

/**
 * Apify, in whichever of its two shapes is available.
 *
 * Without a token the server answers only when `?tools=` pins a subset, and that
 * subset costs 21,539 bytes of tool JSON across four tools. With a token it serves
 * its default set, which is the larger and more interesting number: Apify is the
 * one server in this benchmark where the DEFINITION tax is the big term, not the
 * payload. Recording both shapes is the point, so the arm reports which one ran.
 *
 * The token never reaches the browser demo. This file is CI and local only.
 */
export function apifyServer() {
  const token = process.env.APIFY_TOKEN
  if (!token) {
    return {
      type: 'http',
      url:
        'https://mcp.apify.com/?tools=search-actors,fetch-actor-details,' +
        'search-apify-docs,fetch-apify-docs&telemetry-enabled=false',
      alwaysLoad: true,
      timeout: 60_000,
      shape: 'anonymous-4-tools',
    }
  }
  return {
    type: 'http',
    url: 'https://mcp.apify.com/?telemetry-enabled=false',
    headers: { Authorization: `Bearer ${token}` },
    alwaysLoad: true,
    timeout: 60_000,
    shape: 'authenticated-default-set',
  }
}

/**
 * Settings shared by every arm.
 *
 * `tools: []` removes all built-in tools. `settingSources: []` removes CLAUDE.md,
 * settings files and plugins. Together they give bare-level isolation without bare
 * mode, which matters because bare mode does not read the OAuth token. Left at the
 * defaults, an arm would carry roughly 35,000 tokens of Claude Code's own surface,
 * and the MCP signal this benchmark looks for is about 8,000 tokens. The signal
 * would sit inside the noise.
 */
export function base(task, cfg) {
  return {
    model: cfg.model,
    // Thinking tokens bill as output and vary run to run. Pinning effort is what
    // keeps repetitions comparable. It does not touch the input side.
    effort: 'low',
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    permissionMode: 'bypassPermissions',
    systemPrompt: { type: 'custom', prompt: task.systemPrompt, snapshot: false },
    maxTurns: cfg.maxTurns ?? 12,
    maxBudgetUsd: cfg.maxBudgetUsd ?? 2,
  }
}

/**
 * Four arms, not three.
 *
 * The floor arm carries no MCP servers at all. It is how the overhead is
 * subtracted in real tokens rather than estimated:
 *
 *   tool_tax = A_uncached.turn1.input_tokens - floor.turn1.input_tokens
 *
 * Both arms run uncached, so the whole prompt lands in `input_tokens`, and both
 * share a system prompt, a model and a working directory. The only difference
 * between them is the tool definitions. No token-counting endpoint is needed.
 *
 * Cached and uncached are run for BOTH modes. Comparing a cached direct arm
 * against an uncached code mode arm, or the reverse, is the dishonest framing that
 * makes published code mode numbers look better than they are.
 */
export function arms(task, picked, cfg) {
  const b = () => base(task, cfg)
  return {
    floor: { ...b(), mcpServers: {}, env: armEnv('floor', { DISABLE_PROMPT_CACHING: '1' }) },
    'A-uncached': {
      ...b(),
      mcpServers: picked,
      env: armEnv('a-unc', { DISABLE_PROMPT_CACHING: '1' }),
    },
    'A-cached': { ...b(), mcpServers: picked, env: armEnv('a-cac') },
    'B-uncached': { ...b(), mcpServers: {}, env: armEnv('b-unc', { DISABLE_PROMPT_CACHING: '1' }) },
    'B-cached': { ...b(), mcpServers: {}, env: armEnv('b-cac') },
  }
}

/** Arms whose results must show zero cache activity, asserted after the run. */
export const UNCACHED_ARMS = ['floor', 'A-uncached', 'B-uncached']
export const CACHED_ARMS = ['A-cached', 'B-cached']
export const CODEMODE_ARMS = ['B-uncached', 'B-cached']
