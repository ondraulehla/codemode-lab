import { McpClient } from '../packages/mcp-client/dist/index.js'
import { Meter, formatBytes, estimateTokens } from '../packages/meter/dist/index.js'

const meter = new Meter()
const targets = [
  ['DeepWiki', 'https://mcp.deepwiki.com/mcp'],
  ['Context7', 'https://mcp.context7.com/mcp'],
  ['MS Learn', 'https://learn.microsoft.com/api/mcp'],
  ['GitMCP', 'https://gitmcp.io/docs'],
  ['HuggingFace', 'https://huggingface.co/mcp'],
]

for (const [name, url] of targets) {
  try {
    const c = new McpClient({ url, name, meter })
    const tools = await c.connect()
    console.log(
      `${name.padEnd(12)} mode=${c.mode.padEnd(9)} tools=${String(tools.length).padStart(2)}  ${tools
        .map((t) => t.name)
        .slice(0, 4)
        .join(', ')}`,
    )
  } catch (e) {
    console.log(`${name.padEnd(12)} FAILED: ${e.message}`)
  }
}

console.log('\n--- streaming a 1.4 MB payload, with live progress ---')
let ticks = 0
const dw = new McpClient({
  url: 'https://mcp.deepwiki.com/mcp',
  name: 'DeepWiki',
  meter,
  onProgress: (n) => {
    ticks++
    if (ticks % 40 === 0) process.stdout.write(`\r  ${formatBytes(n).padEnd(12)}`)
  },
})
const t0 = Date.now()
const res = await dw.callTool('read_wiki_contents', { repoName: 'cloudflare/agents' })
const rec = meter.records.at(-1)
console.log(
  `\r  wire=${formatBytes(rec.wireBytes)}  text=${formatBytes(rec.textBytes)}  ~${estimateTokens(rec.textBytes).toLocaleString()} tok (est)  ${Math.round(rec.ms)}ms  progressTicks=${ticks}`,
)
console.log(
  `  content blocks: ${res.content.length}, first 80 chars: ${JSON.stringify(res.content[0].text.slice(0, 80))}`,
)
