import { McpClient } from '../packages/mcp-client/dist/index.js'
import { generateSurface, schemaSurfaceBytes } from '../packages/typegen/dist/index.js'

for (const [id, url] of [
  ['deepwiki', 'https://mcp.deepwiki.com/mcp'],
  ['mslearn', 'https://learn.microsoft.com/api/mcp'],
]) {
  const c = new McpClient({ url, name: id })
  const tools = await c.connect()
  const s = generateSurface(id, tools)
  const raw = schemaSurfaceBytes(tools)
  console.log(
    `\n=== ${id}: raw tools/list JSON ${raw} B  ->  typed surface ${s.bytes} B  (${((s.bytes / raw - 1) * 100).toFixed(0)}%)`,
  )
  if (s.warnings.length) console.log('warnings:', s.warnings)
  if (id === 'deepwiki') console.log(s.source)
}
