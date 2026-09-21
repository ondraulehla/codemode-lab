import type { JsonSchema, McpTool } from '@codemode-lab/mcp-client'

/**
 * Turn MCP tool schemas into a TypeScript surface a model can write against.
 *
 * This is the step that makes code mode possible. Direct tool calling hands the
 * model a JSON Schema per tool and asks it to fill a slot. Code mode hands it a
 * typed namespace and asks it to write a program. The schemas are the same bytes;
 * what changes is that the model can now loop, filter and compose before anything
 * returns.
 *
 * The generated text is declarations only. It never reaches the sandbox at runtime,
 * because the sandbox gets real functions over the bridge. It exists so the model
 * knows what it may call, and so a human can read the same thing the model read.
 */

export interface TypegenOptions {
  /** Namespace name in the output. Defaults to a safe form of the server id. */
  namespace?: string
  /** Include tool descriptions as JSDoc. Costs tokens, buys accuracy. */
  includeDescriptions?: boolean
  /** Cap on description length, so one verbose tool cannot dominate the surface. */
  maxDescriptionChars?: number
}

export interface GeneratedSurface {
  /** The .d.ts text. */
  source: string
  /** UTF-8 byte length, which is the number the demo compares against. */
  bytes: number
  /** One entry per tool, so the UI can show which tool cost what. */
  perTool: { name: string; bytes: number }[]
  /** Schema constructs that did not translate cleanly. Shown, never hidden. */
  warnings: string[]
}

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
])

/** MCP tool names use kebab-case and snake_case freely. TypeScript does not. */
export function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1')
  return RESERVED.has(cleaned) ? `${cleaned}_` : cleaned
}

/** Property keys that are not plain identifiers must be quoted in the output. */
function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function indent(s: string, depth: number): string {
  const pad = '  '.repeat(depth)
  return s
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n')
}

/**
 * Render one schema node as a TypeScript type.
 *
 * `anyOf` and `oneOf` become unions rather than collapsing to `unknown`, because
 * collapsing is how generated surfaces start lying. DeepWiki's `repoName` is
 * `string | string[]` and a model that believes it is only `string` will write a
 * loop it did not need.
 */
export function schemaToType(
  schema: JsonSchema | undefined,
  depth = 0,
  warnings: string[] = [],
): string {
  if (!schema) return 'unknown'

  if (schema.const !== undefined) return JSON.stringify(schema.const)

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  }

  const union = schema.anyOf ?? schema.oneOf
  if (union && union.length > 0) {
    const parts = union.map((s) => schemaToType(s, depth, warnings))
    return [...new Set(parts)].join(' | ')
  }

  if (schema.allOf && schema.allOf.length > 0) {
    // Intersections of object schemas are rare here. Render them and let the reader see it.
    return schema.allOf.map((s) => schemaToType(s, depth, warnings)).join(' & ')
  }

  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []

  if (type.length > 1) {
    return type.map((t) => schemaToType({ ...schema, type: t }, depth, warnings)).join(' | ')
  }

  switch (type[0]) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `${schemaToType(schema.items, depth, warnings)}[]`
    case 'object': {
      const props = schema.properties ?? {}
      const keys = Object.keys(props)
      if (keys.length === 0) return 'Record<string, unknown>'
      const required = new Set(schema.required ?? [])
      const lines = keys.map((k) => {
        const child = props[k]
        const opt = required.has(k) ? '' : '?'
        const doc = child?.description ? `/** ${oneLine(child.description)} */\n` : ''
        return `${doc}${propKey(k)}${opt}: ${schemaToType(child, depth + 1, warnings)}`
      })
      return `{\n${indent(lines.join('\n'), 1)}\n}`
    }
    default:
      if (!schema.type && !schema.properties) return 'unknown'
      if (schema.properties) return schemaToType({ ...schema, type: 'object' }, depth, warnings)
      warnings.push(`unhandled schema type: ${JSON.stringify(schema.type)}`)
      return 'unknown'
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim()
}

/**
 * Generate the full typed surface for one server's tools.
 *
 * The byte count returned here is the honest cost of the "tool definition tax"
 * in code mode: it is what a model must read before it can write a program.
 * Compare it against the raw `tools/list` JSON to see whether code mode's surface
 * is actually cheaper, which is a claim this repo tests rather than assumes.
 */
export function generateSurface(
  serverId: string,
  tools: McpTool[],
  opts: TypegenOptions = {},
): GeneratedSurface {
  const {
    namespace = toIdentifier(serverId),
    includeDescriptions = true,
    maxDescriptionChars = 400,
  } = opts

  const warnings: string[] = []
  const perTool: { name: string; bytes: number }[] = []
  const encoder = new TextEncoder()
  const blocks: string[] = []

  for (const tool of tools) {
    const fn = toIdentifier(tool.name)
    const argType = schemaToType(tool.inputSchema, 1, warnings)
    const ret = tool.outputSchema ? schemaToType(tool.outputSchema, 1, warnings) : 'string'

    const docParts: string[] = []
    if (includeDescriptions && tool.description) {
      const d = oneLine(tool.description)
      docParts.push(d.length > maxDescriptionChars ? `${d.slice(0, maxDescriptionChars)}...` : d)
    }
    if (tool.name !== fn) docParts.push(`MCP tool name: ${tool.name}`)
    const doc = docParts.length ? `/**\n${docParts.map((p) => ` * ${p}`).join('\n')}\n */\n` : ''

    const argsIsEmpty = argType === 'Record<string, unknown>' || argType === 'unknown'
    const sig = argsIsEmpty
      ? `export function ${fn}(): Promise<${ret}>`
      : `export function ${fn}(args: ${argType}): Promise<${ret}>`

    const block = `${doc}${sig}\n`
    perTool.push({ name: tool.name, bytes: encoder.encode(block).length })
    blocks.push(block)
  }

  const header =
    `/**\n` +
    ` * Generated from the live tools/list of "${serverId}".\n` +
    ` * ${tools.length} tool${tools.length === 1 ? '' : 's'}. Do not edit.\n` +
    ` *\n` +
    ` * Every function here runs INSIDE the sandbox and calls OUT over the bridge.\n` +
    ` * Results you do not return never leave the sandbox, which is the point.\n` +
    ` */\n`

  const source = `${header}declare namespace ${namespace} {\n${indent(blocks.join('\n'), 1)}\n}\n`

  return {
    source,
    bytes: encoder.encode(source).length,
    perTool,
    warnings: [...new Set(warnings)],
  }
}

/** Raw `tools/list` JSON byte length, the number code mode is measured against. */
export function schemaSurfaceBytes(tools: McpTool[]): number {
  return new TextEncoder().encode(JSON.stringify({ tools })).length
}
