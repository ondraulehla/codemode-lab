import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { TARGET, rowLine } from './orders.mjs'

/**
 * The synthetic orders server, in the three shapes the arms need.
 *
 * - `directServer` is an in-process MCP server for the direct arms. Claude Code
 *   treats its results like any other MCP result, output limit and spill included.
 * - `toolTable` is the same function for the code mode sandbox.
 * - `mcpTools` is the same tool as a `tools/list` entry, so typegen writes the
 *   surface from the very definition the direct arm reads.
 *
 * One description for all three. Two arms told about a tool in different words
 * would not be answering the same question.
 */

export const GET_ORDERS = {
  name: 'get_orders',
  description:
    'Return one shard of the customer orders export as a markdown table with the ' +
    'columns id, region, status and amount.',
  inputSchema: {
    type: 'object',
    properties: {
      shard: { type: 'integer', description: 'Shard number, starting at 0.' },
    },
    required: ['shard'],
  },
  annotations: { readOnlyHint: true },
}

/**
 * The narrower tool: the server filters, so only matching rows travel.
 *
 * This is the third way to keep a large result out of the window, next to a
 * sandbox and a file. The verdict of `scan` names it, so the crossover measures it.
 */
export const QUERY_ORDERS = {
  name: 'query_orders',
  description:
    'Return the orders that match a region and a status, as a markdown table with ' +
    'the columns id, region, status and amount. Searches every shard.',
  inputSchema: {
    type: 'object',
    properties: {
      region: { type: 'string', description: 'Region to match, for example "north".' },
      status: { type: 'string', description: 'Status to match, for example "refunded".' },
    },
    required: ['region', 'status'],
  },
  annotations: { readOnlyHint: true },
}

/** What one call to get_orders returns. Also the error text for a shard that does not exist. */
export function getOrders(task, args) {
  const shard = Number(args?.shard)
  if (!Number.isInteger(shard) || shard < 0 || shard >= task.shards) {
    return `No shard ${args?.shard}. Shards are numbered 0 to ${task.shards - 1}.`
  }
  return task.texts[shard]
}

/** What one call to query_orders returns. */
export function queryOrders(task, args) {
  const rows = task.texts
    .flatMap((t) => t.split('\n'))
    .filter((l) => l.startsWith('| ORD-'))
    .map((l) => {
      const [id, region, status, amount] = l
        .split('|')
        .slice(1, 5)
        .map((c) => c.trim())
      return { id, region, status, amount: Number(amount) }
    })
    .filter((r) => r.region === args?.region && r.status === args?.status)
  return [
    `# Orders matching region ${args?.region} and status ${args?.status}`,
    '',
    '| id | region | status | amount |',
    '| --- | --- | --- | ---: |',
    ...rows.map(rowLine),
  ].join('\n')
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/** The in-process MCP server a direct arm connects to. */
export function directServer(task, { filter = false } = {}) {
  const tools = filter
    ? [
        tool(
          QUERY_ORDERS.name,
          QUERY_ORDERS.description,
          {
            region: z.string().describe(QUERY_ORDERS.inputSchema.properties.region.description),
            status: z.string().describe(QUERY_ORDERS.inputSchema.properties.status.description),
          },
          async (args) => text(queryOrders(task, args)),
        ),
      ]
    : [
        tool(
          GET_ORDERS.name,
          GET_ORDERS.description,
          { shard: z.number().int().describe(GET_ORDERS.inputSchema.properties.shard.description) },
          async (args) => text(getOrders(task, args)),
        ),
      ]
  return createSdkMcpServer({ name: 'synthetic', version: '0.1.0', tools })
}

/** The same function for the sandbox, keyed the way the runtime expects. */
export function toolTable(task) {
  return { 'synthetic.get_orders': async (args) => getOrders(task, args) }
}

/** The tool as a `tools/list` entry, for typegen. */
export const mcpTools = [GET_ORDERS]

/** The rows a correct program would pick, for the offline tests. */
export function expectedMatches(task) {
  return task.texts
    .flatMap((t) => t.split('\n'))
    .filter((l) => l.startsWith('| ORD-'))
    .filter((l) => l.includes(`| ${TARGET.region} | ${TARGET.status} |`))
}
