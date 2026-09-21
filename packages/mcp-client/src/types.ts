/** The subset of JSON Schema that MCP tool inputs actually use in the wild. */
export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  default?: unknown
  format?: string
  additionalProperties?: boolean | JsonSchema
  [k: string]: unknown
}

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: unknown }
  | { type: string; [k: string]: unknown }

export interface ToolResult {
  content: ContentBlock[]
  structuredContent?: unknown
  isError?: boolean
}
