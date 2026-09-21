/**
 * The gate. Run this before any sweep.
 *
 * It answers one question: does `settingSources: []` still work with subscription
 * OAuth? That combination is what makes the whole benchmark possible, because it
 * strips CLAUDE.md, settings files and plugins from the context while keeping the
 * credential that costs nothing per run.
 *
 *   source ~/.codemode-lab-token && node harness/probe-auth.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { armEnv, credentialKind } from './env.mjs'

const started = Date.now()
console.log(`credential: ${credentialKind()}`)

const q = query({
  prompt: 'Reply with exactly: OK',
  options: {
    model: 'claude-haiku-4-5',
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    systemPrompt: { type: 'custom', prompt: 'Answer in one word.', snapshot: false },
    env: armEnv('probe'),
  },
})

let sawResult = false
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    console.log(`tools in context: ${(m.tools ?? []).length} ${JSON.stringify(m.tools ?? [])}`)
  }
  if (m.type === 'result') {
    sawResult = true
    console.log(`is_error : ${m.is_error}`)
    console.log(`subtype  : ${m.subtype}`)
    console.log(`result   : ${JSON.stringify(m.result)}`)
    console.log(`modelUsage: ${JSON.stringify(m.modelUsage)}`)
    if (m.is_error) {
      console.error(
        '\nGATE FAILED. Switch to the ANTHROPIC_API_KEY fallback, see harness/README.md.',
      )
      process.exit(1)
    }
  }
}

if (!sawResult) {
  console.error('\nGATE FAILED: no result message. The SDK did not complete a turn.')
  process.exit(1)
}
console.log(`\nGATE PASSED in ${((Date.now() - started) / 1000).toFixed(1)}s. The sweep can run.`)
