#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { formatBytes, estimateTokens } from '@codemode-lab/meter'
import { McpClient, SERVERS } from '@codemode-lab/mcp-client'
import { generateSurface } from '@codemode-lab/typegen'
import { scanServer, verdict } from './scan.js'
import { listTasks, loadTask } from './tasks.js'
import { runCodeModeArm } from './run.js'

const HELP = `
codemode-lab - measure what an MCP server costs you, payloads included

  npx codemode-lab scan <url|server-id>   what the server costs: definitions AND payloads
  npx codemode-lab surface <url|server-id> print the TypeScript surface a code mode model reads
  npx codemode-lab run <task-id>          run a task's code mode arm and measure the boundary
  npx codemode-lab tasks                  list the built-in tasks
  npx codemode-lab servers                list the known public servers

Options
  --json                machine-readable output
  --no-probe            skip payload probes (definitions only, no calls made)
  --window <tokens>     context window to compare against (default 200000)

Known server ids: ${SERVERS.map((s) => s.id).join(', ')}

Why this exists: every other MCP cost tool measures tool definitions. That term is
small. The payload a single call returns is routinely 100x larger and decides
whether your task fits in a context window at all.
`

const DIM = process.stdout.isTTY ? '\x1b[2m' : ''
const BOLD = process.stdout.isTTY ? '\x1b[1m' : ''
const RESET = process.stdout.isTTY ? '\x1b[0m' : ''
const RED = process.stdout.isTTY ? '\x1b[31m' : ''

function resolveUrl(target: string): { url: string; name?: string } {
  const known = SERVERS.find((s) => s.id === target)
  if (known) return { url: known.url, name: known.id }
  if (/^https?:\/\//.test(target)) return { url: target }
  throw new Error(
    `"${target}" is neither a URL nor a known server id (${SERVERS.map((s) => s.id).join(', ')})`,
  )
}

/**
 * Credentials a scan may use, read from the environment and never from a flag.
 *
 * A token on the command line lands in shell history and in `ps` output. This is
 * also why no token ever reaches the browser demo: it has no way to receive one.
 */
function authFor(serverId?: string): { url: string; headers: Record<string, string> } | null {
  if (serverId === 'apify' && process.env.APIFY_TOKEN) {
    return {
      url: 'https://mcp.apify.com/?telemetry-enabled=false',
      headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` },
    }
  }
  return null
}

function tokenBand(bytes: number): string {
  return `${Math.round(bytes / 3.8).toLocaleString()}-${Math.round(bytes / 3.3).toLocaleString()}`
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const probe = !argv.includes('--no-probe')
  const windowIdx = argv.indexOf('--window')
  const windowTokens = windowIdx === -1 ? 200_000 : Number(argv[windowIdx + 1])
  const positional = argv.filter(
    (a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--window',
  )

  const [cmd, target] = positional

  if (!cmd || cmd === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP.trim())
    return 0
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const tasksDir = resolve(here, '../../../tasks')

  switch (cmd) {
    case 'servers': {
      if (json) {
        console.log(JSON.stringify(SERVERS, null, 2))
        return 0
      }
      for (const s of SERVERS) {
        const flags = [
          s.session ? 'session' : 'stateless',
          s.corsOpen ? 'cors-open' : 'cors-closed',
          s.needsAuth ? 'needs-auth' : 'keyless',
        ].join(', ')
        console.log(`${BOLD}${s.id.padEnd(13)}${RESET}${s.url}`)
        console.log(`${DIM}              ${flags}${RESET}`)
        if (s.notes) console.log(`${DIM}              ${s.notes}${RESET}`)
      }
      return 0
    }

    case 'tasks': {
      const ids = await listTasks(tasksDir)
      for (const id of ids) {
        const t = await loadTask(tasksDir, id)
        const tag = t.expectCodeModeWins
          ? 'code mode should win '
          : `${RED}code mode should LOSE${RESET}`
        console.log(`${BOLD}${id}${RESET}  ${tag}`)
        console.log(`  ${t.title}`)
        console.log(`${DIM}  ${t.why}${RESET}`)
      }
      return 0
    }

    case 'surface': {
      if (!target) throw new Error('surface needs a url or server id')
      const { url, name } = resolveUrl(target)
      const client = new McpClient({ url, name })
      const tools = await client.connect()
      const s = generateSurface(name ?? new URL(url).hostname, tools)
      if (json) {
        console.log(JSON.stringify(s, null, 2))
        return 0
      }
      console.log(s.source)
      console.log(
        `${DIM}// ${s.bytes} bytes, ~${estimateTokens(s.bytes).toLocaleString()} tokens (estimate)${RESET}`,
      )
      if (s.warnings.length) console.log(`${DIM}// warnings: ${s.warnings.join('; ')}${RESET}`)
      return 0
    }

    case 'scan': {
      if (!target) throw new Error('scan needs a url or server id')
      const { url, name } = resolveUrl(target)
      const known = SERVERS.find((sv) => sv.url === url)
      // Apify serves four tools anonymously and its full default set with a token.
      // The authenticated shape is the interesting one, because Apify is the server
      // where the DEFINITION tax is the big term rather than the payload.
      const auth = authFor(known?.id)
      const report = await scanServer(auth?.url ?? url, {
        name,
        probe,
        hints: known?.probeHints,
        headers: auth?.headers,
      })
      if (auth) console.log(`${DIM}using APIFY_TOKEN: scanning the full default tool set${RESET}`)
      if (json) {
        console.log(JSON.stringify({ ...report, verdict: verdict(report, windowTokens) }, null, 2))
        return 0
      }

      console.log(
        `\n${BOLD}${report.server}${RESET} ${DIM}${report.url} (${report.mode})${RESET}\n`,
      )
      console.log(
        `${BOLD}The definition tax${RESET} ${DIM}- what every other tool measures${RESET}`,
      )
      console.log(`  ${report.toolCount} tools`)
      console.log(
        `  raw tools/list JSON   ${formatBytes(report.schemaBytes).padStart(10)}  ~${tokenBand(report.schemaBytes)} tokens`,
      )
      console.log(
        `  typed code mode surface ${formatBytes(report.surfaceBytes).padStart(8)}  ~${tokenBand(report.surfaceBytes)} tokens`,
      )

      if (report.probes.length) {
        console.log(`\n${BOLD}The payload tax${RESET} ${DIM}- what nobody measures${RESET}`)
        const sorted = [...report.probes].sort((a, b) => b.textBytes - a.textBytes)
        for (const p of sorted) {
          if (p.error) {
            console.log(`  ${p.tool.padEnd(30)} ${DIM}not probed: ${p.error.slice(0, 50)}${RESET}`)
            continue
          }
          const pct = Math.round((p.textBytes / 3.8 / windowTokens) * 100)
          const bar = '#'.repeat(Math.min(40, Math.max(1, Math.round(pct / 2.5))))
          console.log(
            `  ${p.tool.padEnd(30)} ${formatBytes(p.textBytes).padStart(10)}  ~${tokenBand(p.textBytes)} tok  ${pct}% of window`,
          )
          console.log(`  ${' '.repeat(30)} ${DIM}${bar}${RESET}`)
        }
      } else {
        console.log(`\n${DIM}No payloads probed (--no-probe). Definitions only.${RESET}`)
      }

      console.log(`\n${BOLD}Verdict${RESET}\n  ${verdict(report, windowTokens)}\n`)
      console.log(
        `${DIM}Token figures are estimates from byte counts at 3.3 to 3.8 bytes per token.`,
      )
      console.log(
        `This tool does not ship a tokenizer and does not pretend to have measured them.${RESET}\n`,
      )
      return 0
    }

    case 'run': {
      if (!target) throw new Error('run needs a task id. Try: codemode-lab tasks')
      const task = await loadTask(tasksDir, target)
      const tokens: Record<string, string> = {}
      if (process.env.APIFY_TOKEN) tokens.apify = process.env.APIFY_TOKEN

      // --json means machine-readable, so nothing else may reach stdout. The prose
      // below used to print first, which made `run --json | jq` fail on the title.
      if (json) {
        const res = await runCodeModeArm(task, { tokens })
        console.log(
          JSON.stringify(
            {
              task: task.id,
              question: task.question,
              expectCodeModeWins: task.expectCodeModeWins,
              ok: res.ok,
              failure: res.failure ?? null,
              error: res.error ?? null,
              boundaryIn: res.boundaryIn,
              returnedBytes: res.returnedBytes,
              ratio: res.returnedBytes > 0 ? res.boundaryIn / res.returnedBytes : null,
              calls: res.calls,
              ms: res.ms,
              logs: res.logs,
              value: res.value,
            },
            null,
            2,
          ),
        )
        return res.ok ? 0 : 1
      }

      console.log(`\n${BOLD}${task.title}${RESET}`)
      console.log(`${DIM}${task.question}${RESET}\n`)
      if (!task.expectCodeModeWins) {
        console.log(`${RED}This task is expected to LOSE.${RESET} ${DIM}${task.why}${RESET}\n`)
      }

      const res = await runCodeModeArm(task, { tokens })
      for (const l of res.logs) console.log(`  ${DIM}[sandbox]${RESET} ${l}`)

      console.log(`\n${BOLD}The boundary${RESET}`)
      console.log(
        `  tools -> sandbox   ${formatBytes(res.boundaryIn).padStart(10)}  ~${tokenBand(res.boundaryIn)} tokens`,
      )
      console.log(
        `  sandbox -> model   ${formatBytes(res.returnedBytes).padStart(10)}  ~${tokenBand(res.returnedBytes)} tokens`,
      )
      if (res.returnedBytes > 0) {
        console.log(
          `  ${BOLD}${Math.round(res.boundaryIn / res.returnedBytes).toLocaleString()}x smaller${RESET} across ${res.calls} tool call${res.calls === 1 ? '' : 's'} in ${(res.ms / 1000).toFixed(1)}s`,
        )
      }
      if (!res.ok) {
        console.log(
          `\n  ${RED}failed (${res.failure ?? 'unknown'})${RESET}: ${res.error?.split('\n')[0]}`,
        )
        return 1
      }
      console.log(`\n${BOLD}What the model would read${RESET}`)
      console.log(`  ${JSON.stringify(res.value, null, 2).split('\n').join('\n  ')}`)
      return 0
    }

    default:
      console.error(`unknown command: ${cmd}\n`)
      console.log(HELP.trim())
      return 2
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${RED}error:${RESET} ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
