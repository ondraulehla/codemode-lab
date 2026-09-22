# Methodology

How every number in this repository was produced, and what it does not prove.

Every figure carries the date it was measured, because the servers are live and
change. Run the commands yourself and you will get different numbers. That is the
point of shipping the commands.

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

One module counts bytes: `packages/meter`. Nothing in the CLI, the harness or the
scripts computes a size of its own.

Counting uses `TextEncoder`, so a byte is a UTF-8 byte. `String.length` counts
UTF-16 code units and would undercount any non-ASCII document.

Sizes are printed in binary units with binary names: 1 KiB is 1,024 bytes and
1 MiB is 1,048,576 bytes. Until 2026-09-22 the formatter printed "kB" for 1,024
bytes while task texts used "kB" for 1,000, so the same payload of 392,601 bytes
appeared as 383.4 kB in one document and 392 kB in another.

## Two kinds of token figure

**Billed tokens** come from the harness. It runs each arm through the Claude Agent
SDK and reads the usage the API counted off the final result message. They are
exact for that run, and they are reported in their own columns.

**Estimated tokens** are everything else. This repository ships no tokenizer, so
`estimateTokens(bytes)` divides by `BYTES_PER_TOKEN_ESTIMATE = 3.8`, and display
code widens that to a band of 3.3 to 3.8 bytes per token.

Rules the repo holds itself to:

1. An estimate is always shown as a band, never as one confident number.
2. An estimate is always labelled as an estimate at the point it is shown.
3. A billed number is never averaged with an estimate.

The band is not calibrated for the model the harness runs. Claude models from 4.7
on use a tokenizer that makes up to about a third more tokens from the same text,
so for claude-opus-5 the true ratio is likely below 3.3 bytes per token. That makes
every estimate here low, never high. The free `count_tokens` endpoint of the
Anthropic API gives the exact count for a given model, and calibrating the band
with it is open work.

If you need exact counts for another model today,
[`mcp-context-cost`](https://github.com/athakur3/mcp-context-cost) runs a real
tokenizer and is the right tool for that job.

## Payload sizes

The seven-repository table comes from one script.

<!-- readme-ci skip -->

```bash
node scripts/measure-payloads.mjs
```

It opens one `McpClient` against `https://mcp.deepwiki.com/mcp`, calls
`read_wiki_contents` once per repository, and prints the meter record for each
call. No sampling, no averaging, no retries folded in. One call, one row.

Output on 2026-09-21, with the unit labels corrected on 2026-09-22 (the numbers
are unchanged, the formatter then wrote "kB" and "MB" for these binary units):

```text
repo                                     wire       text   ~tok@3.8   ~tok@3.3  % of 200K
apify/apify-mcp-server               1.48 MiB  728.2 KiB    196,225    225,956  98-113%
cloudflare/agents                    1.37 MiB  683.7 KiB    184,250    212,167  92-106%
withastro/astro                      1.13 MiB  563.5 KiB    151,854    174,863  76-87%
e2b-dev/E2B                         825.2 KiB  403.0 KiB    108,588    125,041  54-63%
modelcontextprotocol/servers        791.3 KiB  383.4 KiB    103,316    118,970  52-59%
vercel/ai                            1.42 MiB  712.8 KiB    192,090    221,194  96-111%
nodejs/undici                       571.1 KiB  274.4 KiB     73,944     85,148  37-43%

All 7 in one context: text=3.66 MiB  ~1,010,267 tok  = 5.1x a 200K window
```

## Definition sizes

Two different numbers carry the name "definition tax". The repo keeps them
apart.

**The `tools/list` response body**, measured with `curl`.

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
`scan` command prints as "raw tools/list JSON". For DeepWiki it was 1,526 B on
2026-09-21 and 1,548 B on 2026-09-22, the day it renamed one tool.

## Generated surface sizes

`generateSurface(serverId, tools)` turns `tools/list` into a TypeScript
declaration namespace. Its `bytes` field is the UTF-8 length of the generated
source.

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan deepwiki --no-probe --json
node packages/cli/dist/bin.js scan mslearn --no-probe --json
```

Measured 2026-09-22:

| server          | raw tools JSON | typed surface | change |
| --------------- | -------------: | ------------: | -----: |
| DeepWiki        |        1,548 B |       1,124 B |   -27% |
| Microsoft Learn |        4,868 B |       3,110 B |   -36% |

Every generated function returns `Promise<string>`, because the sandbox hands a
program the text of a result and nothing else. Until 2026-09-22 a function returned
the server's declared output schema instead. For DeepWiki that was `{ result: string }`,
a wrapper FastMCP adds, so the surface promised an object and the program got a
string. A tool with a real output schema now gets a named type for the JSON its
text holds. A typegen test type-checks every task's reference program against the
surface generated for it, which is how this kind of lie gets caught.

The saving comes from JSON Schema being verbose about types that TypeScript
states in one word. It is real, and it is also tiny next to a payload. Do not
adopt code mode for it.

## Probe arguments

A scanner that invents a generic query flatters the server. Microsoft Learn
returns 14 bytes for "getting started" and 24,187 bytes for a real question. The
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

`tools -> sandbox` is the sum of `in` events. What leaves the sandbox is counted
two ways, and the two differ whenever a program logs:

- the CLI's `run` counts the UTF-8 length of `JSON.stringify(returnValue)`,
- the harness counts the whole text of the tool result the model received: the
  value, the program's logs, or the failure message. That is `boundary.toModel`
  in a sweep file.

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js run table-heavy-page
```

## Two direct arms, and what each measures

The word "direct" names two different things in this repository. Mixing them up
is the easiest way to misread a number.

**The CLI's direct arm** (`runDirectArm`) makes exactly the calls a task allows and
sums `textBytes`. No model runs. It measures volume: what a client that keeps
every result would have to hold. The replay on the project page is this arm.

**The harness's direct arms** are real agents in Claude Code, with a model, a
grader and billed tokens. Claude Code does not keep every result. It writes any
MCP result over 25,000 tokens to a file and gives the model the path
([docs](https://code.claude.com/docs/en/mcp)). So the harness runs four direct
arms:

| arm          | what it can do with a large result                                    |
| ------------ | --------------------------------------------------------------------- |
| `A-uncached` | nothing: the result goes to a file and the arm has no tool to open it |
| `A-cached`   | the same, with prompt caching on                                      |
| `A-files`    | open the file with Read and search it with Grep                       |
| `A-raw`      | read it in the window: the output limit is raised to 1,000,000 tokens |

`A-files` and `A-raw` run only on tasks that name them in `extraArms`, with
predictions recorded before their first run.

## What the harness records for each arm

- **Billed usage** from `modelUsage` on the final result message: input, output,
  cache reads and cache writes, per model.
- **Per-turn usage**, read once per API response. The SDK streams one message per
  content block and each carries the same usage, so counting messages would count
  one turn several times. Only the input side is read per turn, because it is fixed
  when the response starts.
- **The definition tax**: the first request of an arm minus the first request of
  the floor arm, both uncached. The only difference between those two requests is
  what the arm declares. Until 2026-09-22 the sweep published the difference over
  ALL turns as the "tool tax", which includes tool results and resent history. That
  number is still recorded, as `extraInputOverFloor`, under a name that says what it
  is.
- **The peak prompt**: the fullest the window got on any one request, cached or not.
- **Spilled results**: tool results Claude Code replaced with a file path.
- **The answer class**: `correct`, `wrong`, or `no-data` when the arm's only copy of
  the data went to a file it could not open.
- **For code mode**, every program the model ran, with its failure class, its calls
  and the distinct calls. A sandbox keeps no state between programs, so a second
  program fetches the payload again.

Grading is a substring check on the **final answer** only. It used to read the
whole transcript, which let an arm pass on a string it wrote on the way and then
abandoned. The floor arm has no tools and is graded too: a floor that passes
answered from memory, and the task is not measuring data access.

Each arm runs in an empty working directory with a fresh config directory. The
default working directory was the repository, where an arm that can Grep would
find the grading strings in `tasks/<id>/task.json`.

## Cost at list price

`harness/summarize.mjs` turns billed tokens into a list-price equivalent with the
table in `harness/prices.mjs`: output at five times input, a five minute cache write
at 1.25x input, a cache read at 0.1x. A subscription run is not billed per token, so
this is an equivalent, never a cost that was paid, and it says so wherever it is
shown.

Input tokens alone hide two things: the output tokens a program costs, and the cache
discount. On the 2026-09-21 sweep they decided a verdict. `structure-rank` lost on
uncached input tokens, as predicted, and won on cached list price.

## Repetitions

A single run cannot separate a 2% difference from noise. The summary reports, per
task and arm, the median and the range over repetitions, and pass^k: whether the
arm was correct in every run. Code mode and each direct arm are paired run by run,
so each ratio compares two runs that hit the live server at about the same time.

The 2026-09-21 sweep has one run per arm. Every conclusion drawn from it says so.

## The synthetic crossover

`harness/crossover.mjs` runs the same arms against a synthetic orders server whose
payload size is set by the caller: 1 KiB to 1 MiB by default, in powers of four.
The answer is computed from the generated rows, and the order ids are random, so
the floor arm cannot know it. For each size it reports the list-price ratio of
code mode against each direct arm, and where that ratio crosses 1x. See
[harness/README.md](../harness/README.md) for the arms, the predictions and the
cost ceiling. No crossover has run yet.

## Known limits

- **No tokenizer.** Every token figure outside `results/` is an estimate, and the
  band is not calibrated for claude-opus-5.
- **Substring grading.** It cannot credit a correct answer phrased differently.
  The grading strings are chosen so that a paraphrase is unlikely, and every
  failure is read by hand before it is published.
- **One model, one effort level.** Format effects differ by model, and the published
  studies show it.
- **One sample per probe.** Server responses vary. A second run will differ.
- **Live servers drift.** DeepWiki regenerates wikis and renames tools. Every table
  prints its measurement date for that reason.
- **The Node sandbox is not a security boundary.** It isolates globals and
  contains crashes. It does not contain hostile code.
- **Predictions are recorded before runs.** Each `task.json` carries
  `expectCodeModeWins`. Two of the five tasks predict a loss and one is recorded as
  uncertain. If a losing task wins, the prediction was wrong and the prediction gets
  corrected, not the task.

## Reproducing everything

<!-- readme-ci skip -->

```bash
npm install
npx tsc --build
node scripts/measure-payloads.mjs
node packages/cli/dist/bin.js scan deepwiki
node packages/cli/dist/bin.js scan mslearn
node packages/cli/dist/bin.js run table-heavy-page
node packages/cli/dist/bin.js run outline-leaves
node packages/cli/dist/bin.js run structure-rank
```

The billed numbers need a credential and run locally. See
[harness/README.md](../harness/README.md).
