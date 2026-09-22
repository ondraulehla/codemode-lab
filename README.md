# codemode-lab

[![CI](https://github.com/ondraulehla/codemode-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/ondraulehla/codemode-lab/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/ondraulehla/codemode-lab)](LICENSE)

**When does it help to let an AI agent write a program instead of calling tools one
at a time? I measured it, including the cases where it does not help at all.**

## Start here, no background needed

An AI agent has a finite memory. When it calls a tool, the whole result lands in
that memory.

Picture an assistant at a desk. You ask which of five thick manuals mentions a
particular thing.

**Way A.** The assistant photocopies all five manuals and piles them on the desk.
The desk overflows after the second manual. They never finish.

**Way B.** The assistant sends a note to the archive: _"go through these five, count
the mentions, come back with one sheet."_ The desk only ever holds one sheet.

The desk is the context window. The photocopies are tool results. Way B is what
people call **code mode**: the agent writes a small program, the program runs
somewhere else and calls the tools itself, and only its answer comes back.

This repository measures when Way B is worth it.

## The number that turns the argument round

Most published code mode numbers measure the **catalogue card**: the list of which
tools exist and what arguments they take. It is small.

| what                                                |   bytes |
| --------------------------------------------------- | ------: |
| DeepWiki's card, all 3 of its tools                 |   1,526 |
| the cards of three public servers, 8 tools in total |  11,268 |
| text returned by **one call** to one DeepWiki tool  | 700,150 |

Measured 2026-09-21. One result is **459 times** DeepWiki's whole card, and **62
times** the cards of all three servers put together.

Measuring the card and ignoring the manuals is how you get a headline like
"98.7 percent saved". That number is real, and it is about the card.

> Those byte figures are exact and each ratio divides one of them by another, so
> check them. `700,150 B` is `683.7 KiB`, because 1 KiB is 1,024 bytes. This README
> once said `683,700`, which is the KiB figure written as if it were bytes, and it
> made one of the ratios wrong. The formatter now prints KiB, so the label says
> which unit it is.

The manuals are not a secret. Anthropic's
[own post](https://www.anthropic.com/engineering/code-execution-with-mcp) describes
tool results passing through the context, and
[Toolathlon](https://arxiv.org/abs/2510.25726) counts how often a result is too long.
What I did not find is a code mode benchmark that measures the result as its own
term, call by call, on public servers. That is what this repository adds.

## What I measured

Five questions, each asked twice: once by an agent calling tools directly, once by
an agent writing a program. Same model, same question, same tools.

The prediction for each was written down **before** the run.

| task               |           direct |   code mode | list price, uncached | list price, cached | predicted       |
| ------------------ | ---------------: | ----------: | -------------------: | -----------------: | --------------- |
| `table-heavy-page` | 53,416 ✗ no data | **8,788** ✓ |                 0.19 |               0.35 | code mode wins  |
| `one-big-payload`  | 26,179 ✗ no data | **8,879** ✓ |                 0.38 |               0.46 | code mode wins  |
| `topic-overlap`    |   11,085 ✗ wrong | **9,600** ✓ |                 1.08 |               0.68 | _uncertain_     |
| `structure-rank`   |      **8,133** ✓ |     8,275 ✓ |                 1.05 |           **0.65** | code mode loses |
| `outline-leaves`   |      **5,665** ✓ |     5,860 ✓ |                 1.15 |               1.30 | code mode loses |

The first two columns are input tokens counted by the Anthropic API, uncached arms.
The list price columns divide what code mode cost by what the direct arm cost, so
below 1 means code mode was cheaper. They weight output at five times input and
cache reads at a tenth, from [harness/prices.mjs](harness/prices.mjs). They are an
equivalent of the billed tokens, not a bill. claude-opus-5, effort low, 2026-09-21,
**one run per arm**.

**One run is not a result.** The two predicted losses held on input tokens, by 3.4%
and 1.7%. At list price the gaps are 15% and 5%, because a program is output, and
output costs more. With caching on, `structure-rank` went the other way: code mode
was 35% cheaper. One run cannot tell those apart from noise, so the next sweep runs
every arm five times.

## Why the direct arm failed

On the two large tasks the direct arm stopped and said so:

> "All three dumps were fetched successfully but each exceeds the output token
> limit, so they were written to files under /tmp/... I'm blocked and need your
> input."

It did not invent an answer. The mechanism matters more than it first looks.
claude-opus-5 has a 1M token window, so the window did not stop it. Claude Code
did: it writes any MCP result over
[25,000 tokens](https://code.claude.com/docs/en/mcp) to a file and gives the model
the path. This harness removes every built-in tool, so the arm had no way to open
the file.

So read those two rows narrowly. Code mode reached the data and the direct arm did
not. That is not yet a measurement of what carrying the data in the window costs.

`topic-overlap` is different. Its payloads are small, the direct arm read every
one, and it still got the counts wrong. A set intersection done by reading is less
reliable than one done by a program. That is a finding about accuracy, not tokens.

## Where it does not pay off

Two of the five tasks exist to lose. Code mode cost 195 and 142 more input tokens
than calling the tools directly, and more again at list price.

That is not a disaster. It is simply pointless. When the data already fits in the
window there is nothing to filter, so the program is a round trip you paid for and
did not need.

If you take one practical thing from this repository, take that one. Code mode is
for large results, not for tidiness. Other people found the same shape: see
[What others found](#what-others-found).

## How I know I am not fooling myself

The first measurement was wrong four different ways. Reading the transcripts is
what found them, and every one is now a rule the build enforces.

1. **The question could be answered from memory.** It asked whether some
   repositories document a WebSocket API. The model already knew. It could answer
   correctly having called no tool at all, so the benchmark measured recall, not
   data access. Every token number from that run was worthless.
2. **The grading strings were inside the question.** Restating the question scored
   a pass. A test now fails the build if that ever recurs.
3. **The two arms had different tools.** The direct arm loaded three, code mode got
   one. The first fix made both arms call the same tool. They still declared
   different ones until 2026-09-22: the direct arm carried two definitions it could
   not call. Now every tool a task does not allow is removed from its context.
4. **A permission setting bypassed a tool ban.** DeepWiki's question tool is backed
   by a language model and spends the provider's money, so this harness banned it.
   `bypassPermissions` bypassed the ban and it was called anyway.

Every replacement question is graded on a string the documentation generator
invented, checked with GitHub code search to return zero hits inside its own
repository. A model cannot produce those strings without reading the data.

### The second audit, 2026-09-22

A review of the first sweep found nine more faults. None of them changes a
headline above, and every one would have misled a later reader.

1. **The cached code mode arm counted the uncached arm's calls.** One counter was
   reset once per task. Its boundary figures were exactly double in four of five
   tasks.
2. **The check that each arm loaded the right tools never ran.** The sweep did not
   pass the expected list to it.
3. **The "tool tax" was not the tool definitions.** It was all input over the
   tool-less floor arm, across every turn, results included. The definitions are
   now counted on the first request only, and the old number keeps an honest name.
4. **The types lied to the model.** The typed surface said DeepWiki returns
   `{ result: string }`. The sandbox hands over a string. A test now type-checks
   every reference program against the surface, and it found a null that one
   program did not handle.
5. **The daily liveness probe reported two stale claims and still went green.**
   `| tee` swallowed the exit code.
6. **Five documents still described the three retired tasks.** A test now fails the
   build when a document names a task that does not exist.
7. **The grader read the whole transcript.** It now reads the final answer only.
8. **One label meant two units.** "kB" was 1,024 bytes in the formatter and 1,000 in
   the task texts, so one payload appeared as 383.4 kB and as 392 kB.
9. **Server instructions reached one arm only.** Claude Code gives DeepWiki's 3,129
   bytes of instructions to the direct arm, and nothing gave them to code mode, so
   every code mode request started about 418 tokens lighter. Both arms get them now,
   and their definition taxes agree to 7 tokens.

### The caveat this work earns

Every arm of the 2026-09-21 sweep ran with no file tools. A normal Claude Code
session keeps them, so it could open the spilled file and grep it, and answer
without code mode at all.

Two new arms test exactly that, on the two large tasks. `A-files` can Read and Grep.
`A-raw` raises the output limit, so the payload lands in the window and its cost is
counted. Their predictions were written down on 2026-09-22, before either ran.
They have not run yet.

Until they do, the narrow claim is the only one this work makes: **a payload that
does not fit has to be processed outside the context window. Code mode is one way
to do that, and not the only one.**

## What others found

- **Anthropic, [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)**
  (November 2025). The 150,000 to 2,000 token figure is a worked example of a
  hypothetical task, not a run.
- **Anthropic, [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling).**
  On τ²-bench, scores did not change and cost went up about 8%.
- **[AXI](https://github.com/kunchenguid/axi)** (March 2026). 425 runs on 17 GitHub
  tasks with Claude Sonnet 4.6. Code mode: 84% success, $0.101 a task, the slowest
  arm. A plain CLI: 86% at $0.054.
- **[The Bitter Lesson of Tool Calling](https://arxiv.org/abs/2608.06370)** (August
  2026). 14 models on BFCL v4. Programmatic calls cost more tokens below about 26
  parallel calls. Its tools return stubs, so it measures fan-out, not payload.
- **[AIMultiple](https://aimultiple.com/code-execution-with-mcp)** (August 2026).
  GPT-4.1, 2 tasks, 50 runs each. Input tokens fell 78.5%, mostly definitions.
  Output tokens rose 120%, latency 7%.

More, with what each one measured, in [docs/prior-art.md](docs/prior-art.md).

## Next

The next sweep runs every arm five times, adds the two new arms on the two large
tasks, and reports cost at list price and per-turn figures: turns, the first
request, and the fullest the window got.

The question after that is where the break-even point is. At what payload size,
with and without cache, does code mode start to pay? The Bitter Lesson paper found
a break-even for the number of calls. I found none for payload size. The
[crossover](harness/README.md#the-crossover-where-does-code-mode-start-to-pay) is
built to measure it on a synthetic server, with its predictions already written
down. It has not run yet.

## Try it

```bash
npm install && npx tsc --build
```

Ask what a public MCP server actually costs you, both ways round:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan deepwiki
```

```text
The definition tax - what schema audits measure
  3 tools
  raw tools/list JSON      1.5 KiB  ~407-469 tokens
  typed code mode surface  1.1 KiB  ~296-341 tokens

The payload tax - what one call returns
  read_wiki_contents              683.7 KiB  ~184,250-212,167 tok  92% of window

Verdict
  deepwiki: 3 tools cost about 407 to 469 tokens to declare, which is 0% of a 200K
  window. Its largest probed result, read_wiki_contents, returned 683.7 KiB of text
  ... 452x the entire tool definition surface. A second call of this size does not
  fit. Process the result outside the context window: in a sandbox (code mode), in
  a file the agent can search, or through a narrower tool call.
```

That is the output of 2026-09-22, and the ratio is 452x, not 459x. DeepWiki renamed
one tool that day and its card grew by 22 bytes. Live servers drift, which is why
every table here carries a date.

Point it at a server with the opposite shape and it tells you the opposite thing.
This output is from 2026-09-21, with an `APIFY_TOKEN`, before the verdict wording
changed:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan apify
```

```text
  apify: 11 tools cost about 20,222 tokens to declare, which is 10% of a 200K
  window ... 7.7x SMALLER than the tool definitions. This is the inverted case:
  the definitions are the expensive term, not the results.
```

Run one task's code mode arm against the live server:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js run one-big-payload
```

Summarise a sweep, with medians, ranges and list prices:

<!-- readme-ci skip -->

```bash
node harness/summarize.mjs results/latest.json
```

## Repository map

| path                  | what it is                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `packages/mcp-client` | MCP over HTTP: both transports, and the event stream three of five public servers answer with |
| `packages/runtime`    | the sandbox. An opaque-origin iframe in a browser, a worker in Node                           |
| `packages/typegen`    | turns tool schemas into the TypeScript surface a model writes against                         |
| `packages/meter`      | the only thing in the repo that counts bytes                                                  |
| `packages/cli`        | `scan`, `surface`, `run`, `tasks`, `servers`                                                  |
| `harness/`            | the seven arms that report billed tokens, and the summary. Runs locally, never in CI          |
| `tasks/`              | the five questions, their grading, and a reference program each                               |
| `results/`            | committed measurements, each with a run id and a model id, and their summaries                |

## Honest about the numbers

- **Byte counts are exact.** They are measured at the boundary and stated as fact.
  The units are B, KiB (1,024 bytes) and MiB.
- **Token counts in `results/` are billed**, read off the API response.
- **Token counts anywhere else are estimates**, shown as a band at 3.3 to 3.8 bytes
  per token. This repo ships no tokenizer and will not print a single confident
  token number. The band is not yet calibrated for claude-opus-5, whose tokenizer
  makes up to about a third more tokens from the same text than older models did.
- **Context figures never use wire bytes.** SSE framing and JSON escaping make the
  wire figure roughly twice the text, and only the text reaches a model.
- **Dollar figures are list-price equivalents**, computed from billed tokens and
  labelled as such. A subscription run is not billed per token, so no figure here
  is a bill.

More in [docs/methodology.md](docs/methodology.md), the sources and what is claim
versus measurement in [docs/code-mode.md](docs/code-mode.md), the measured server
table in [docs/servers.md](docs/servers.md), and what already exists in
[docs/prior-art.md](docs/prior-art.md).

A daily [liveness probe](.github/workflows/liveness.yml) re-measures every published
claim and fails when one goes stale. Until 2026-09-22 it did not fail: a pipe
swallowed its exit code, and it stayed green through two stale claims. These are
live documents on somebody else's free servers, so the numbers here rot unless
something watches them.

## License

MIT. See [LICENSE](LICENSE).
