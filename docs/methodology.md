# Methodology

How every number in this repository was produced, and what it does not prove.

All figures below were measured on 2026-09-21 against live public servers. Run
the commands yourself and you will get different numbers, because the servers
change. That is the point of shipping the commands.

## The one rule

**Wire bytes are not context bytes.**

A streamable HTTP MCP response arrives as Server-Sent Events. The body carries
`event:` and `data:` framing, and the JSON inside escapes every newline, quote
and backslash in the document. Those bytes travel. They do not enter a context
window.

`packages/meter` records both, per call:

- `wireBytes` – what a proxy or a devtools panel would show
- `textBytes` – the concatenated text content inside the result, which is what a
  model would actually read

They differ by about 2x on documentation payloads. Every context claim in this
repo uses `textBytes`. If you see a wire figure, it is labelled `wire`.

## Byte counting

One module counts bytes: `packages/meter`. Nothing in the CLI, the site or the
scripts computes a size of its own.

Counting uses `TextEncoder`, so a byte is a UTF-8 byte. `String.length` counts
UTF-16 code units and would undercount any non-ASCII document.

## Tokens are estimated, never measured

This repository does not ship a tokenizer.

`estimateTokens(bytes)` divides by `BYTES_PER_TOKEN_ESTIMATE = 3.8`. Display
code widens that to a band of 3.3 to 3.8 bytes per token, which is the observed
range for English markdown mixed with code.

Rules the repo holds itself to:

1. A token figure is always shown as a band, never as one confident number.
2. A token figure is always labelled as an estimate at the point it is shown.
3. Billed token counts will come from the Anthropic API in CI. When they land
   they will be reported as billed tokens, in their own column, and never
   averaged together with an estimate.

If you need exact token counts today, use a tool that runs a real tokenizer.
[`mcp-context-cost`](https://github.com/athakur3/mcp-context-cost) uses
`o200k_base` and is the right tool for that job.

## Payload sizes

The seven-repository table in the README comes from one script.

<!-- readme-ci skip -->

```bash
node scripts/measure-payloads.mjs
```

It opens one `McpClient` against `https://mcp.deepwiki.com/mcp`, calls
`read_wiki_contents` once per repository, and prints the meter record for each
call. No sampling, no averaging, no retries folded in. One call, one row.

Output on 2026-09-21:

```text
repo                                     wire       text   ~tok@3.8   ~tok@3.3  % of 200K
apify/apify-mcp-server                1.48 MB   728.2 kB    196,225    225,956  98-113%
cloudflare/agents                     1.37 MB   683.7 kB    184,250    212,167  92-106%
withastro/astro                       1.13 MB   563.5 kB    151,854    174,863  76-87%
e2b-dev/E2B                          825.2 kB   403.0 kB    108,588    125,041  54-63%
modelcontextprotocol/servers         791.3 kB   383.4 kB    103,316    118,970  52-59%
vercel/ai                             1.42 MB   712.8 kB    192,090    221,194  96-111%
nodejs/undici                         571.1 kB   274.4 kB     73,944     85,148  37-43%

All 7 in one context: text=3.66 MB  ~1,010,267 tok  = 5.1x a 200K window
```

## Definition sizes

Two different numbers carry the name "definition tax". The repo keeps them
apart.

**The `tools/list` response body**, measured with `curl`. This is what the
`servers` command reports and what the README's definition table shows.

<!-- readme-ci skip -->

```bash
curl -s -X POST https://mcp.deepwiki.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | wc -c
```

This wire figure is NOT what the repo records, and the reason is worth stating.
Three of these servers answer as `text/event-stream`, so a wire measurement
counts SSE framing. A session server cannot answer a bare `tools/list` at all,
so the same command would measure its `initialize` reply instead. Two numbers
produced that way are not comparable with each other.

The repo hit that exactly once. `toolsListBytes` held a wire figure for DeepWiki
and a JSON figure for Apify, and the liveness probe then reported a 75 percent
drift on Apify that had not happened. It was comparing an `initialize` response
against a recorded tool list. One definition, applied everywhere, is the fix.

**The tools array as JSON**, which is what a client puts in a request. This is
`schemaSurfaceBytes(tools)` in `packages/typegen`, and it is the number the
`scan` command prints as "raw tools/list JSON". For DeepWiki it is 1,526 B.

The two differ because one includes the JSON-RPC envelope and the SSE frame and
the other does not. Both are honest. Quoting one and labelling it as the other
would not be.

## Generated surface sizes

`generateSurface(serverId, tools)` turns `tools/list` into a TypeScript
declaration namespace. Its `bytes` field is the UTF-8 length of the generated
source.

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan deepwiki --no-probe --json
node packages/cli/dist/bin.js scan mslearn --no-probe --json
```

Measured 2026-09-21:

| server          | raw tools JSON | typed surface | change |
| --------------- | -------------: | ------------: | -----: |
| DeepWiki        |        1,526 B |       1,157 B |   -24% |
| Microsoft Learn |        4,868 B |       2,806 B |   -42% |

The saving comes from JSON Schema being verbose about types that TypeScript
states in one word. It is real, and it is also tiny next to a payload. Do not
adopt code mode for it.

## Probe arguments

A scanner that invents a generic query flatters the server. Microsoft Learn
returns 14 bytes for "getting started" and over 23 kB for a real question. The
payload figure is only as honest as the arguments that produced it.

So `packages/mcp-client/src/servers.ts` carries `probeHints`: realistic
arguments per tool, written by hand. `planProbes` uses a hint when one exists.
Without a hint it builds arguments from the schema, and it refuses to call a
tool whose name suggests the call spends the provider's money, or whose
`readOnlyHint` is false. A skipped tool is reported as "not probed". Reporting a
gap beats inventing a call.

Every probe in this repo is a single call with the arguments printed next to the
result. Nothing is averaged.

## Boundary sizes

`packages/runtime` fires a `BoundaryEvent` for every value crossing the sandbox
edge:

```ts
interface BoundaryEvent {
  direction: 'in' | 'out'
  tool: string
  bytes: number
  id: number
}
```

`tools -> sandbox` is the sum of `in` events. `sandbox -> model` is the UTF-8
length of `JSON.stringify(returnValue)`, because that string is what a model
would receive as the code execution result.

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js run cross-repo-scan
```

## What the direct arm does and does not measure

`runDirectArm` makes exactly the calls a task allows and sums `textBytes`. It
runs no model.

That makes it a claim about **volume**, not about **accuracy**. This repo says a
payload does not fit in a window. It does not say code mode produces better
answers. Any accuracy claim would need a model in both arms, a grader, and
repeats, and none of that is here.

## Known limits

- **No tokenizer.** See above. Every token figure is an estimate.
- **No accuracy measurement.** Volume only.
- **One sample per probe.** Server responses vary. A second run will differ.
- **Live servers drift.** DeepWiki regenerates wikis. The 2026-09-21 numbers
  will not reproduce exactly, and the repo prints the measurement date next to
  every table for that reason.
- **The Node sandbox is not a security boundary.** It isolates globals and
  contains crashes. It does not contain hostile code. See the README.
- **Predictions are recorded before runs.** Each `task.json` carries
  `expectCodeModeWins`. Two of the three tasks predict a loss. If a losing task
  wins, the prediction was wrong and the prediction gets corrected, not the
  task.

## Reproducing everything

<!-- readme-ci skip -->

```bash
npm install
npx tsc --build
node scripts/measure-payloads.mjs
node packages/cli/dist/bin.js scan deepwiki
node packages/cli/dist/bin.js scan mslearn
node packages/cli/dist/bin.js run cross-repo-scan
node packages/cli/dist/bin.js run single-call
node packages/cli/dist/bin.js run sequential-pair
```
