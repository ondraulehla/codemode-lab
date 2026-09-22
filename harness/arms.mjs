import { armEnv } from './env.mjs'

/**
 * The MCP servers each arm sees.
 *
 * `alwaysLoad` points the SDK straight at the live endpoint, so the server's own
 * JSON Schema reaches the model unmodified. Wrapping the servers in a proxy or
 * re-declaring the tools by hand would insert a schema this project authored, and
 * every byte of difference would land in the number being measured.
 *
 * No tool is named here. The tools a task does not allow are computed from the
 * server's live `tools/list` at sweep time and removed with `disallowedTools`. A
 * name written here goes stale: DeepWiki renamed `ask_question` to
 * `ask_wiki_question` on 2026-09-22, and a deny rule on the old name protected
 * nothing.
 */
export const SERVERS = {
  deepwiki: {
    type: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    alwaysLoad: true,
    timeout: 60_000,
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
 * The token never reaches a page. This file runs locally only.
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
 * Every arm the harness knows, in the order a sweep runs them.
 *
 * - `floor` carries no tools. Its first request is the baseline for the
 *   definition tax, and its answer is the memory control: it must fail.
 * - `A-uncached` and `A-cached` call the tools directly, the way every published
 *   comparison does.
 * - `A-files` calls the tools directly and can also Read and Grep. Claude Code
 *   writes a result over 25,000 tokens to a file, so this is the direct arm a
 *   real session is: it can open the file.
 * - `A-raw` calls the tools directly with the output limit raised, so a large
 *   result lands in the context window instead of in a file. This is the arm that
 *   measures the payload tax itself.
 * - `B-uncached` and `B-cached` write a program. That is code mode.
 */
export const ARM_NAMES = [
  'floor',
  'A-uncached',
  'A-cached',
  'A-files',
  'A-raw',
  'B-uncached',
  'B-cached',
]

/** The arms every task runs. Tasks name further arms in `extraArms`. */
export const DEFAULT_ARMS = ['floor', 'A-uncached', 'A-cached', 'B-uncached', 'B-cached']

/** Arms whose results must show zero cache activity, asserted after the run. */
export const UNCACHED_ARMS = ['floor', 'A-uncached', 'A-raw', 'B-uncached']
/**
 * A-files is cached because Claude Code caches whenever Read and Grep are loaded,
 * DISABLE_PROMPT_CACHING or not: on 2026-09-22 it wrote 4,209 cache tokens on its
 * first request with the variable set. So it runs as what it is, a cached arm, and
 * the summary compares it with cached code mode.
 */
export const CACHED_ARMS = ['A-cached', 'A-files', 'B-cached']
export const CODEMODE_ARMS = ['B-uncached', 'B-cached']
export const DIRECT_ARMS = ['A-uncached', 'A-cached', 'A-files', 'A-raw']

/**
 * The built-in tools `A-files` adds. Read and Grep only.
 *
 * Bash would let the arm fetch the payload again with curl and bypass the MCP tool
 * under test, which is exactly what the tool-less floor arm pretended to do in its
 * text on 2026-09-21.
 */
export const FILE_TOOLS = ['Read', 'Grep']

/**
 * The exact tools an arm may call, as a hard allowlist.
 *
 * A permission policy is a request. This is a lock, and it fixes a bug the first
 * sweep exposed: the direct arm loaded every tool its servers offered, while the
 * code mode arm was wrapped to only the tools the task declared.
 */
export function allowedToolsFor(task) {
  return Object.entries(task.servers).flatMap(([server, tools]) =>
    tools.map((t) => `mcp__${server}__${t}`),
  )
}

/**
 * Every live tool a task does not allow, as the SDK names it.
 *
 * These are removed from the direct arms' context with `disallowedTools`, so both
 * arms declare the same tools. Before this, the direct arm declared three DeepWiki
 * tools and was allowed to call one, while the code mode surface declared only the
 * one. The two extra definitions were resent on every turn, and on the two tasks
 * code mode lost, they were larger than the margin it lost by.
 */
export function disallowedFor(task, serverTools) {
  return Object.entries(task.servers).flatMap(([server, allowed]) =>
    (serverTools[server] ?? [])
      .filter((t) => !allowed.includes(t))
      .map((t) => `mcp__${server}__${t}`),
  )
}

/** The tool list the SDK must report at init, per arm. Asserted in assert.mjs. */
export function expectedToolsFor(arm, task) {
  if (arm === 'floor') return []
  if (CODEMODE_ARMS.includes(arm)) return ['mcp__codemode__run_code']
  if (arm === 'A-files') return [...allowedToolsFor(task), ...FILE_TOOLS]
  return allowedToolsFor(task)
}

/** Whether an arm has a tool that can open a file Claude Code spilled a result into. */
export function canReadFiles(arm) {
  return arm === 'A-files'
}

/**
 * Options for one run of one arm.
 *
 * `tools: []` removes all built-in tools. `settingSources: []` removes CLAUDE.md,
 * settings files and plugins. Together they give bare-level isolation without bare
 * mode, which matters because bare mode does not read the OAuth token. Left at the
 * defaults, an arm would carry roughly 35,000 tokens of Claude Code's own surface,
 * and the MCP signal this benchmark looks for is about 8,000 tokens.
 *
 * `cwd` is an empty directory made for this run. The default was the repository,
 * and an arm that can Read and Grep would then find tasks/<id>/task.json, which
 * holds the grading strings.
 *
 * `configDir` is also made for this run. A config directory kept between runs
 * keeps Claude Code's MCP discovery cache, and a cached tool list is how a renamed
 * tool comes back from the dead.
 */
export function armOptions(arm, { task, picked, cfg, configDir, workDir, disallowed, codemode }) {
  const common = {
    model: cfg.model,
    // Thinking tokens bill as output and vary run to run. Pinning effort is what
    // keeps repetitions comparable. It does not touch the input side.
    effort: cfg.effort ?? 'low',
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    // NOT bypassPermissions. That mode bypasses ALL permission checks, including
    // deny rules, and the first sweep proved it: a tool this harness had denied,
    // because it spends the provider's money, was called anyway. 'dontAsk' denies
    // what is not pre-approved instead.
    permissionMode: 'dontAsk',
    systemPrompt: { type: 'custom', prompt: task.systemPrompt, snapshot: false },
    maxTurns: cfg.maxTurns ?? 12,
    maxBudgetUsd: cfg.maxBudgetUsd ?? 2,
    cwd: workDir,
  }

  const uncached = { DISABLE_PROMPT_CACHING: '1' }
  const direct = {
    ...common,
    mcpServers: picked,
    allowedTools: allowedToolsFor(task),
    disallowedTools: disallowed,
  }
  const codeMode = {
    ...common,
    mcpServers: { codemode },
    allowedTools: ['mcp__codemode__run_code'],
  }

  switch (arm) {
    case 'floor':
      return { ...common, mcpServers: {}, env: armEnv(arm, uncached, configDir) }
    case 'A-uncached':
      return { ...direct, env: armEnv(arm, uncached, configDir) }
    case 'A-cached':
      return { ...direct, env: armEnv(arm, {}, configDir) }
    case 'A-files':
      return {
        ...direct,
        // Reading a 383 KiB file through Read takes many turns. At the shared cap of
        // 12 the first attempt ran out before it answered, which measured the cap.
        maxTurns: cfg.filesMaxTurns ?? 40,
        tools: FILE_TOOLS,
        allowedTools: [...direct.allowedTools, ...FILE_TOOLS],
        // The spilled result lands under the config directory. Nothing else is
        // readable: cwd is empty.
        additionalDirectories: [configDir],
        env: armEnv(arm, {}, configDir),
      }
    case 'A-raw':
      return {
        ...direct,
        // A large result read into the window costs dollars per turn. The cap is
        // separate so the other arms keep their tight one.
        maxBudgetUsd: cfg.rawMaxBudgetUsd ?? 15,
        env: armEnv(
          arm,
          { ...uncached, MAX_MCP_OUTPUT_TOKENS: String(cfg.rawMaxOutputTokens ?? 1_000_000) },
          configDir,
        ),
      }
    case 'B-uncached':
      return { ...codeMode, env: armEnv(arm, uncached, configDir) }
    case 'B-cached':
      return { ...codeMode, env: armEnv(arm, {}, configDir) }
    default:
      throw new Error(`unknown arm "${arm}". Known: ${ARM_NAMES.join(', ')}`)
  }
}
