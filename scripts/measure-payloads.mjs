import { McpClient } from '../packages/mcp-client/dist/index.js'
import { Meter, formatBytes, estimateTokens } from '../packages/meter/dist/index.js'

const REPOS = [
  'apify/apify-mcp-server',
  'cloudflare/agents',
  'withastro/astro',
  'e2b-dev/E2B',
  'modelcontextprotocol/servers',
  'vercel/ai',
  'nodejs/undici',
]
const meter = new Meter()
const c = new McpClient({ url: 'https://mcp.deepwiki.com/mcp', name: 'DeepWiki', meter })
await c.connect()

console.log(
  `${'repo'.padEnd(34)} ${'wire'.padStart(10)} ${'text'.padStart(10)} ${'~tok@3.8'.padStart(10)} ${'~tok@3.3'.padStart(10)}  % of 200K`,
)
const rows = []
for (const repo of REPOS) {
  try {
    await c.callTool('read_wiki_contents', { repoName: repo })
    const r = meter.records.at(-1)
    const lo = Math.round(r.textBytes / 3.8),
      hi = Math.round(r.textBytes / 3.3)
    rows.push({ repo, ...r, lo, hi })
    console.log(
      `${repo.padEnd(34)} ${formatBytes(r.wireBytes).padStart(10)} ${formatBytes(r.textBytes).padStart(10)} ${lo.toLocaleString().padStart(10)} ${hi.toLocaleString().padStart(10)}  ${((lo / 200000) * 100).toFixed(0)}-${((hi / 200000) * 100).toFixed(0)}%`,
    )
  } catch (e) {
    console.log(`${repo.padEnd(34)} FAILED ${e.message}`)
  }
}
const t = meter.totals
console.log(
  `\nAll ${rows.length} in one context: text=${formatBytes(t.textBytes)}  ~${estimateTokens(t.textBytes).toLocaleString()} tok  = ${(estimateTokens(t.textBytes) / 200000).toFixed(1)}x a 200K window`,
)
