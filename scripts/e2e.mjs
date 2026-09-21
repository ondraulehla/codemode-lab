import { McpClient } from '../packages/mcp-client/dist/index.js'
import { Meter, formatBytes, estimateTokens } from '../packages/meter/dist/index.js'
import { runInNodeSandbox } from '../packages/runtime/dist/node.js'
import { toolTableFrom } from '../packages/runtime/dist/index.js'

const meter = new Meter()
const deepwiki = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', name: 'deepwiki', meter })
await deepwiki.connect()

const tools = toolTableFrom(
  { deepwiki },
  { deepwiki: ['read_wiki_contents', 'read_wiki_structure'] },
)

// This is the kind of program a model writes in code mode. It loops, it filters,
// and it returns a summary. The big payloads never leave the sandbox.
const program = `
const repos = ['cloudflare/agents', 'e2b-dev/E2B', 'modelcontextprotocol/servers', 'nodejs/undici']
const needle = /\bWebSocket\b/
const out = []
for (const repo of repos) {
  const wiki = await deepwiki.read_wiki_contents({ repoName: repo })
  const lines = wiki.split('\\n')
  const hits = lines.filter(l => needle.test(l))
  console.log(repo + ': ' + wiki.length + ' chars in, ' + hits.length + ' matching lines')
  out.push({ repo, chars: wiki.length, hits: hits.length, first: hits[0] ? hits[0].trim().slice(0, 100) : null })
}
return out
`

let boundaryIn = 0,
  boundaryOut = 0
const t0 = Date.now()
const result = await runInNodeSandbox(program, {
  tools,
  meter,
  timeoutMs: 120000,
  onLog: (lvl, text) => console.log('   [sandbox]', text),
  onBoundary: (ev) => {
    if (ev.direction === 'in') boundaryIn += ev.bytes
    else boundaryOut += ev.bytes
  },
})

const returned = JSON.stringify(result.value ?? null)
console.log('\n--- the boundary ---')
console.log(
  `   into the sandbox from tools : ${formatBytes(boundaryIn).padStart(10)}  (~${estimateTokens(boundaryIn).toLocaleString()} tok est)`,
)
console.log(
  `   out of the sandbox to host  : ${formatBytes(returned.length).padStart(10)}  (~${estimateTokens(returned.length).toLocaleString()} tok est)`,
)
console.log(
  `   ratio                       : ${(boundaryIn / returned.length).toFixed(0)}x smaller`,
)
console.log(`   ok=${result.ok} failure=${result.failure ?? 'none'} ms=${result.ms}`)
if (result.error) console.log('   ERROR:', result.error.slice(0, 600))
console.log('\n--- what the model would see ---')
console.log(returned)
