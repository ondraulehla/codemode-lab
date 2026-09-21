# codemode-lab

[![CI](https://github.com/ondraulehla/codemode-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/ondraulehla/codemode-lab/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/codemode-lab)](https://www.npmjs.com/package/codemode-lab)
[![docs checked by readme-ci](https://img.shields.io/badge/docs-checked%20by%20readme--ci-orange)](https://github.com/ondraulehla/codemode-lab/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/codemode-lab)](LICENSE)

**Every MCP cost tool measures the tool definitions. That is the small number.
Nobody measures what one tool call gives back. That is the number that decides
whether your task runs at all.**

This repo measures both, against live public MCP servers, and shows its work.

## The finding

One `read_wiki_contents` call on the public [DeepWiki](https://mcp.deepwiki.com/mcp)
server returns this much text. Measured on 2026-09-21.

| repo                         |     wire |     text | est. tokens (3.8 to 3.3 B/tok) | % of a 200K window |
| ---------------------------- | -------: | -------: | -----------------------------: | -----------------: |
| apify/apify-mcp-server       |  1.48 MB | 728.2 kB |             196,225 to 225,956 |         98 to 113% |
| vercel/ai                    |  1.42 MB | 712.8 kB |             192,090 to 221,194 |         96 to 111% |
| cloudflare/agents            |  1.37 MB | 683.7 kB |             184,250 to 212,167 |         92 to 106% |
| withastro/astro              |  1.13 MB | 563.5 kB |             151,854 to 174,863 |          76 to 87% |
| e2b-dev/E2B                  | 825.2 kB | 403.0 kB |             108,588 to 125,041 |          54 to 63% |
| modelcontextprotocol/servers | 791.3 kB | 383.4 kB |             103,316 to 118,970 |          52 to 59% |
| nodejs/undici                | 571.1 kB | 274.4 kB |               73,944 to 85,148 |          37 to 43% |

All seven together are 3.66 MB of text, about 1.01M estimated tokens. That is
5.1 times a 200K context window.

Now the other side of the ledger. This is the whole tool definition surface of
the three keyless servers this repo tracks, measured as the `tools/list`
response body:

| server          | tools | `tools/list` body |
| --------------- | ----: | ----------------: |
| DeepWiki        |     3 |           1,526 B |
| Context7        |     2 |           4,874 B |
| Microsoft Learn |     3 |           4,868 B |
| **total**       | **8** |      **11,268 B** |

About 11.3 kB. Roughly 2,970 to 3,410 estimated tokens. That is 1.5% to 1.7%
of a 200K window, paid once per turn.

**One DeepWiki payload is 459 times the entire definition surface of the server
that produced it.** One call fills a 200K window. Two calls are not possible.

Three things about those token numbers, because they are the point of the repo:

- **Wire bytes are not context bytes.** The wire column includes SSE framing and
  JSON string escaping. The text column is what would enter a model's context.
  They differ by about 2x. This repo always talks about context in text bytes.
- **Token counts here are estimates.** They come from byte counts divided by 3.3
  to 3.8 bytes per token. This repo ships no tokenizer and never prints a single
  confident token number. Billed token counts come later, from the Anthropic API
  in CI.
- **No percentage is inflated to make a point.** One call is 92% to 113% of a
  window. That is already the whole argument.

## What everyone else measures

Several good tools measure MCP context cost. They all measure the same term: the
tool schemas that load into context on every turn.

| tool                   | what it measures                                                                           | link                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `mcp-context-cost`     | tool schemas from your own config, with a real `o200k_base` tokenizer and a CI budget gate | [github.com/athakur3/mcp-context-cost](https://github.com/athakur3/mcp-context-cost) |
| MCPView                | tool schema footprint of any server URL, ranked per tool                                   | [mcpview.teamcopilot.ai](https://mcpview.teamcopilot.ai/)                            |
| PolicyLayer token cost | tool schema cost per request across connected servers                                      | [policylayer.com/token-cost](https://policylayer.com/token-cost)                     |
| mcpfold calculator     | tool schema tokens per turn, and what curation saves                                       | [mcpfold.com/mcp-token-calculator](https://mcpfold.com/mcp-token-calculator/)        |

None of them is wrong. `mcp-context-cost` in particular is more rigorous than
this repo about tokens, because it runs a real tokenizer and this one does not.

They measure a different term. Tool definitions are a fixed tax of a few thousand
tokens. A single tool result can be two hundred times that, and it arrives after
you already committed to the call. The table above is the gap this repo fills.

See [docs/prior-art.md](docs/prior-art.md) for the longer comparison.

## See it yourself

Install and build:

<!-- readme-ci skip -->

```bash
git clone https://github.com/ondraulehla/codemode-lab
cd codemode-lab
npm install
npx tsc --build
```

Scan a server. The scan connects, reads `tools/list`, generates the typed
surface, then calls the read-only tools with realistic arguments and measures
what comes back.

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan deepwiki
```

Real output, 2026-09-21:

```text
deepwiki https://mcp.deepwiki.com/mcp (stateless)

The definition tax - what every other tool measures
  3 tools
  raw tools/list JSON       1.5 kB  ~402-462 tokens
  typed code mode surface   1.1 kB  ~304-351 tokens

The payload tax - what nobody measures
  read_wiki_contents               683.7 kB  ~184,250-212,167 tok  92% of window
                                 #####################################
  read_wiki_structure                1.7 kB  ~470-541 tok  0% of window
                                 #

Verdict
  deepwiki: 3 tools cost about 402 tokens to declare. Its largest probed result,
  read_wiki_contents, returned 683.7 kB of text, roughly 184,250 to 212,167 tokens,
  which is 92% to 106% of a 200K window and 459x the entire tool definition surface.
  Two or three calls exhaust the window. Filtering inside a sandbox is the
  difference between possible and not.

Token figures are estimates from byte counts at 3.3 to 3.8 bytes per token.
This tool does not ship a tokenizer and does not pretend to have measured them.
```

The same command on Microsoft Learn is the honest counter-example. The tool
definitions are three times larger than DeepWiki's, and the payloads are small.
The verdict says so.

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan mslearn
```

Real output, 2026-09-21:

```text
mslearn https://learn.microsoft.com/api/mcp (stateless)

The definition tax - what every other tool measures
  3 tools
  raw tools/list JSON       4.8 kB  ~1,281-1,475 tokens
  typed code mode surface   2.7 kB  ~738-850 tokens

The payload tax - what nobody measures
  microsoft_docs_search             23.6 kB  ~6,365-7,329 tok  3% of window
                                 #
  microsoft_code_sample_search      10.3 kB  ~2,777-3,198 tok  1% of window
                                 #
  microsoft_docs_fetch               2.2 kB  ~601-692 tok  0% of window
                                 #

Verdict
  mslearn: 3 tools cost about 1,281 tokens to declare. Its largest probed result,
  microsoft_docs_search, returned 23.6 kB of text, roughly 6,365 to 7,329 tokens,
  which is 3% to 4% of a 200K window and 5x the entire tool definition surface.
  Payloads are small on this server, so code mode will mostly cost you a round trip.
  Turn on prompt caching first.
```

A tool that told you to adopt code mode on both servers would be selling
something. On Microsoft Learn the right move is prompt caching, not a sandbox.

Other commands:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js servers          # the measured server table
node packages/cli/dist/bin.js surface deepwiki # the typed surface a model reads
node packages/cli/dist/bin.js tasks            # the task set, winners and losers
node packages/cli/dist/bin.js run cross-repo-scan
```

## What code mode is, mechanically

Code mode changes where the tool result lands. Nothing else.

1. **The tools become a typed surface.** `tools/list` becomes a TypeScript
   declaration file. DeepWiki's three tools compile to 1,157 bytes of `.d.ts`,
   down 24% from the 1,526 bytes of raw schema JSON. Microsoft Learn drops 42%,
   from 4,868 to 2,806 bytes. See `packages/typegen`.
2. **The model writes a program**, not a tool call. It reads the surface and
   emits JavaScript that calls those functions.
3. **The program runs in a sandbox.** Each function call crosses a bridge to the
   real MCP client and the result comes back into the sandbox, not into context.
4. **Only the return value reaches the model.** Everything the program read and
   did not return is gone.

Here is that difference measured. The `cross-repo-scan` task asks one question
about four repositories. Real run, 2026-09-21:

```text
Which of these repos document a WebSocket API, and where?

  [sandbox] cloudflare/agents: 699986 chars scanned, 134 hits
  [sandbox] e2b-dev/E2B: 412590 chars scanned, 0 hits
  [sandbox] modelcontextprotocol/servers: 392127 chars scanned, 0 hits
  [sandbox] nodejs/undici: 280976 chars scanned, 88 hits

The boundary
  tools -> sandbox      1.70 MB  ~470,098-541,325 tokens
  sandbox -> model        603 B  ~159-183 tokens
  2,962x smaller across 4 tool calls in 117.6s
```

The four wiki dumps are 1.70 MB. The model reads 603 bytes: four rows with a
repo name, a count and one line of evidence each. A direct-calling agent cannot
even begin this task. One of those four payloads is already 92% of the window.

## Where code mode loses

Two of the three tasks in this repo predict a code mode **loss**, and the
prediction is written into `task.json` before the run. If a losing task ever
wins, that is a finding, not a bug to hide.

**`single-call`.** One call, a small answer. Real run:

```text
The boundary
  tools -> sandbox       1.0 kB  ~271-312 tokens
  sandbox -> model       1.0 kB  ~280-322 tokens
  1x smaller across 1 tool call in 0.4s
```

The program returned more bytes than it received, because JSON quoting is not
free. Add the tokens to write the program and the round trip to run it, and
direct tool calling wins outright.

**`sequential-pair`.** Two calls where the second needs the first. Real run:

```text
The boundary
  tools -> sandbox       6.1 kB  ~1,631-1,878 tokens
  sandbox -> model       4.2 kB  ~1,143-1,316 tokens
  1x smaller across 2 tool calls in 3.0s
```

Nothing to run in parallel, nothing worth filtering. The program moves two calls
one hop further from the model and charges for the trip.

This matches the only vendor number published with a losing case attached.
Anthropic measured programmatic tool calling on τ²-bench, where each turn makes
one or two sequential calls: scores unchanged, cost about 8% higher. Their own
documentation states that sequential single-call workflows do not benefit. See
[Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling).

The same page reports the wins: about 38% fewer billed input tokens on a 75-tool
agent benchmark with no accuracy change, and 20% to 40% typical savings for
requests carrying 10 to 49 tool definitions.

There is also a published per-query dataset where code mode loses badly on a
large payload. In the Bifrost benchmark, round 2 query H6 went from 835,600
input tokens without code mode to 1,466,500 with it, a 75% regression, because a
large GitHub API response inflated the execution context. Same run, same
harness, 84.5% average saving. See
[docs/code-mode.md](docs/code-mode.md) for the full reading of that dataset.

Use code mode when you fan out, when you loop, or when you filter a payload
larger than the answer. Do not use it for one call and a short reply.

## The sandbox, stated precisely

This repo has two sandboxes. They are not equally strong, and the difference
matters.

**The browser sandbox is a real security boundary.** `packages/runtime/src/browser.ts`
runs the program in an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`. The frame gets an opaque origin, so it cannot touch the
page's DOM, storage or cookies. The frame document carries a CSP of
`default-src 'none'`, so the program cannot fetch, cannot load a script and
cannot open a socket. It has no network at all. Every capability it has arrives
as a function over a `postMessage` bridge, and the host checks message identity
by source window, not by origin string.

**The Node sandbox is not a security boundary.** `packages/runtime/src/node.ts`
runs the program in a `worker_threads` worker. A worker isolates globals and
contains a crash. It does not stop hostile code. The network globals inside the
worker are replaced with getters that throw `egress-denied`, which stops an
accident, not an attacker. This sandbox exists so the CLI can measure what a
program costs. Do not run untrusted code in it.

Both sandboxes enforce the same rule for measurement: the program reaches MCP
only through the bridge, so every byte crossing in or out is counted exactly
once.

## Methodology

Every number in this repository came from a command you can re-run.

- **Payload sizes** come from `scripts/measure-payloads.mjs`, which calls
  `read_wiki_contents` on seven repositories and records wire bytes and text
  bytes per call.
- **Definition sizes** come from a plain `curl` POST of `tools/list`, and from
  `packages/typegen` for the generated surface.
- **Boundary sizes** come from `packages/runtime`, which fires a `BoundaryEvent`
  for every byte entering or leaving the sandbox.
- **Byte counting** happens in exactly one module, `packages/meter`. Nothing
  else in the repo computes a number.
- **Token figures are estimates.** Bytes divided by 3.3 to 3.8. Always shown as
  a band, always labelled. Billed tokens will come from the Anthropic API in CI
  and will be reported separately, never mixed with estimates.
- **What is not measured:** accuracy. The direct arm counts volume, not answer
  quality. This repo claims that a payload does not fit. It does not claim that
  code mode gives better answers.

Reproduce the headline table in one command:

<!-- readme-ci skip -->

```bash
node scripts/measure-payloads.mjs
```

Full detail, including the exact commands and the known limits, is in
[docs/methodology.md](docs/methodology.md).

## Repository map

| path                  | what it holds                                                 |
| --------------------- | ------------------------------------------------------------- |
| `packages/meter`      | the only module that counts bytes                             |
| `packages/mcp-client` | streamable HTTP MCP client, SSE parser, measured server table |
| `packages/typegen`    | `tools/list` to a TypeScript surface                          |
| `packages/runtime`    | the iframe sandbox, the worker sandbox, the bridge            |
| `packages/cli`        | the `codemode-lab` npm package                                |
| `tasks/`              | one question asked two ways, winners and losers               |
| `scripts/`            | the measurement scripts behind the tables                     |
| `docs/`               | methodology, code mode sources, server table, prior art       |

## Documentation

- [docs/methodology.md](docs/methodology.md) – how every number was produced,
  and what it does not prove
- [docs/code-mode.md](docs/code-mode.md) – the primary sources, and which of
  their figures are measurements and which are worked examples
- [docs/servers.md](docs/servers.md) – the measured capability table for each
  public server
- [docs/prior-art.md](docs/prior-art.md) – what already exists, and how this
  differs

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: bring a measurement,
not an opinion, and keep the honest counter-examples in the set.

## License

MIT © Ondrej Ulehla
