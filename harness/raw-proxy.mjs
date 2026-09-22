import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { McpClient } from '@codemode-lab/mcp-client'

/**
 * A pass-through server for the A-raw arm.
 *
 * A-raw exists to put a large result into the context window, where its cost is
 * counted. Raising MAX_MCP_OUTPUT_TOKENS is not enough: the first sweep attempt on
 * 2026-09-22 raised it to 1,000,000 and Claude Code still wrote the 392,601
 * character result to a file. The documentation names a separate persist-to-disk
 * threshold, which only a tool itself can raise, through
 * `_meta["anthropic/maxResultSizeChars"]`, up to a hard ceiling of 500,000
 * characters. A remote server we do not own cannot be asked to set it.
 *
 * So A-raw talks to an in-process server that forwards every call to the live
 * server and declares that ceiling. It copies the live tool description and input
 * schema, and passes the live server's instructions through, as the SDK asks a
 * proxy to. The schema reaches the model through the SDK's own conversion, so its
 * bytes can differ slightly from the live JSON. Next to a payload of 100,000
 * tokens, that difference does not move a result.
 *
 * A result over 500,000 characters still goes to a file. Claude Code allows no
 * larger result into the window, from any tool.
 */
export const RAW_MAX_RESULT_CHARS = 500_000

/** A zod shape for the JSON Schema of a tool's input, for the cases MCP tools use. */
export function zodShape(schema) {
  const props = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  return Object.fromEntries(
    Object.entries(props).map(([key, s]) => {
      const t = zodType(s)
      return [key, required.has(key) ? t : t.optional()]
    }),
  )
}

export function zodType(s = {}) {
  const described = (t) => (s.description ? t.describe(s.description) : t)
  const union = s.anyOf ?? s.oneOf
  if (Array.isArray(union) && union.length) {
    const parts = union.map((u) => zodType(u))
    return described(parts.length === 1 ? parts[0] : z.union(parts))
  }
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string') && s.enum.length) {
    return described(z.enum(s.enum))
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type
  switch (type) {
    case 'string':
      return described(z.string())
    case 'integer':
      return described(z.number().int())
    case 'number':
      return described(z.number())
    case 'boolean':
      return described(z.boolean())
    case 'array':
      return described(z.array(s.items ? zodType(s.items) : z.unknown()))
    case 'object':
      return described(z.object(zodShape(s)))
    default:
      return described(z.unknown())
  }
}

/**
 * The in-process server A-raw connects to, named like the live one, so its tools
 * keep their live names: `mcp__<id>__<tool>`.
 */
export async function rawProxyServer({ id, url, headers, allowed }) {
  const client = new McpClient({ url, name: id, headers })
  const tools = (await client.connect()).filter((t) => allowed.includes(t.name))
  const instructions = await client.getInstructions()

  const defs = tools.map((t) => {
    const def = tool(t.name, t.description ?? '', zodShape(t.inputSchema), async (args) => {
      const res = await client.callTool(t.name, args)
      return { content: res.content, ...(res.isError ? { isError: true } : {}) }
    })
    def._meta = { ...(def._meta ?? {}), 'anthropic/maxResultSizeChars': RAW_MAX_RESULT_CHARS }
    return def
  })

  const server = createSdkMcpServer({
    name: id,
    version: 'raw-proxy',
    ...(instructions ? { instructions } : {}),
    tools: defs,
  })
  // A 700 KiB dump can take a minute and a half to arrive.
  server.timeout = 180_000
  return server
}
