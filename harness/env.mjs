/**
 * The environment each arm runs in.
 *
 * `options.env` REPLACES the subprocess environment rather than extending it, so
 * this file is an allowlist, not a patch. That matters more than it looks: this
 * machine exports ANTHROPIC_BASE_URL and about twenty-five CLAUDE_CODE_* variables.
 * Inheriting them changes what the measured arm actually loads, which silently
 * moves the number the harness exists to report.
 */

/** Variables that must never reach an arm, with the reason each one is out. */
export const EXCLUDED = {
  ANTHROPIC_API_KEY: 'would outrank the OAuth token and change which credential pays',
  ANTHROPIC_AUTH_TOKEN: 'same',
  ANTHROPIC_BASE_URL: 'already exported on this machine; would redirect the arm',
  CLAUDE_CODE_ENTRYPOINT: 'leaks the parent session identity into the child',
  CLAUDE_CODE_SESSION_ID: 'same',
}

/**
 * Build the environment for one arm.
 *
 * FORCE_PROMPT_CACHING_5M is not a detail. Cache TTL is one hour on a subscription
 * inside included usage and five minutes on an API key. Left unpinned,
 * `cache_read_input_tokens` measures the billing state rather than the task, and
 * nobody else could reproduce the number. Pinning five minutes costs this benchmark
 * nothing, because the second turn follows the first within seconds, and it makes
 * every figure reproducible on any credential.
 */
export function armEnv(arm, vars = {}, configDir = `/tmp/cml-cfg-${arm}`) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'No credential. Run `claude setup-token`, save it to ~/.codemode-lab-token, ' +
        'then `source ~/.codemode-lab-token`. See harness/README.md.',
    )
  }

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Each run gets its own config dir so no state leaks between arms or between
    // repetitions. run.mjs makes a fresh one per run and deletes it afterwards.
    CLAUDE_CONFIG_DIR: configDir,
    // Belt to alwaysLoad's braces: tool search would defer definitions out of
    // context and shrink the very number being measured.
    ENABLE_TOOL_SEARCH: 'false',
    FORCE_PROMPT_CACHING_5M: '1',
    ...vars,
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
  } else {
    // The documented fallback. Every other setting stays identical, which is why
    // the two credentials produce comparable numbers.
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  }

  return env
}

export function credentialKind() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription-oauth' : 'api-key'
}
