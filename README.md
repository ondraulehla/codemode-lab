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
an agent writing a program. Same model, same question, same tools. Each approach
runs as two arms, one with the prompt cache and one without.

The prediction for each was written down **before** the run.

| task               |          direct |    code mode | list price, uncached | list price, cached | predicted       | held               |
| ------------------ | --------------: | -----------: | -------------------: | -----------------: | --------------- | ------------------ |
| `table-heavy-page` | 7,105 ✗ no data |  **5,715** ✓ |                 0.67 |               0.76 | code mode wins  | yes                |
| `one-big-payload`  | 5,458 ✗ no data |  **5,456** ✓ |                 0.98 |               0.86 | code mode wins  | yes                |
| `topic-overlap`    |        10,717 ✓ | **10,456** ✓ |                 0.96 |               1.06 | _uncertain_     | no verdict         |
| `structure-rank`   |         7,769 ✓ |  **5,039** ✓ |             **0.31** |           **0.30** | code mode loses | no                 |
| `outline-leaves`   |         5,297 ✓ |  **5,269** ✓ |                 1.04 |               0.72 | code mode loses | on list price only |

The first two columns are prompt tokens counted by the Anthropic API for the
uncached arms: input, cache reads and cache writes together, the median of five
runs. A tick or a cross is the answer most of the five runs gave. The list price
columns divide what code mode cost by what the direct arm cost, run by run, so
below 1 means code mode was cheaper. They weight output at five times input and
cache reads at a tenth, from [harness/prices.mjs](harness/prices.mjs). They are an
equivalent of the billed tokens, not a bill. claude-sonnet-5, effort low,
2026-09-22, **five runs per arm**. Code mode answered correctly in all 50 of its
runs.

**Where the data fits, the arms are close.** On `outline-leaves` the prompts are
within 1% of each other. On `topic-overlap` they are within 3%, and the direct arm
was right in 9 runs of 10.

**One predicted loss was a clear win.** On `structure-rank` code mode used 35% fewer
prompt tokens and cost 31% of the direct arm's list price. The direct arm read four
outlines into its window and wrote about three times as many output tokens, 854
against 293. On the first sweep, 2026-09-21 on claude-opus-5 with one run, this task was a narrow
loss for code mode. The check on claude-opus-5 below, with the current harness,
found the same clear win as claude-sonnet-5, so that loss came from the harness the
first sweep ran on, not from the model. Two of the four directional predictions held
on prompt tokens.

The first sweep is kept in `results/` as it was written. Its table said the same
about the two large tasks and the opposite about `structure-rank`.

## Why the direct arm failed

On the two large tasks the direct arm never saw the data. On the first sweep it
stopped and said so:

> "All three dumps were fetched successfully but each exceeds the output token
> limit, so they were written to files under /tmp/... I'm blocked and need your
> input."

It did not invent an answer. The window did not stop it. Claude Code did: it writes
any MCP result over [25,000 tokens](https://code.claude.com/docs/en/mcp) to a file
and gives the model the path. `A-uncached` and `A-cached` have no built-in tools, so
they cannot open the file.

A normal session could. So the 2026-09-22 sweep adds two direct arms that do reach
the data. `A-files` keeps Read and Grep. `A-raw` goes through a proxy that raises
the limit, so the whole result lands in its window.

| task               | direct arm |    direct | code mode | right, direct | right, code mode | direct ÷ code mode, list price |
| ------------------ | ---------- | --------: | --------: | ------------: | ---------------: | -----------------------------: |
| `one-big-payload`  | `A-files`  |   163,814 |     5,531 |        3 of 5 |           5 of 5 |                12x (6x to 21x) |
| `one-big-payload`  | `A-raw`    |   168,548 |     5,456 |        4 of 5 |           5 of 5 |               28x (26x to 30x) |
| `table-heavy-page` | `A-files`  | 1,683,743 |     5,347 |        2 of 5 |           5 of 5 |               63x (28x to 79x) |

Prompt tokens, the median of five runs. `A-files` is paired with the code mode arm
that caches, `A-raw` with the one that does not. `A-files` reads the file in parts,
and every part stays in the prompt of every later turn. On `table-heavy-page` it
ran out of turns, at 40, in three runs of five.

`topic-overlap` was different on the first sweep. Its payloads are small, the direct
arm read every one, and it still got the counts wrong. With five runs on
claude-sonnet-5 it was right in 9 of 10. In the check on claude-opus-5 it was wrong
in all 4 runs, and code mode was right in all 4. That finding holds for one model
and not for the other.

## A check on claude-opus-5

The same harness, the same tasks, two runs per arm, 2026-09-22. `A-files` and
`A-raw` ran on `one-big-payload` only, to keep the check small.

| task               |           direct |   code mode | list price, uncached | list price, cached | right, direct | right, code mode |
| ------------------ | ---------------: | ----------: | -------------------: | -----------------: | ------------: | ---------------: |
| `table-heavy-page` | 51,742 ✗ no data | **5,112** ✓ |                 0.10 |               0.22 |        0 of 4 |           4 of 4 |
| `one-big-payload`  | 34,677 ✗ no data | **4,997** ✓ |                 0.14 |               0.25 |        0 of 4 |           4 of 4 |
| `topic-overlap`    |   10,534 ✗ wrong | **9,383** ✓ |                 0.80 |               0.93 |        0 of 4 |           4 of 4 |
| `structure-rank`   |          7,585 ✓ | **4,836** ✓ |                 0.55 |               0.29 |        4 of 4 |           4 of 4 |
| `outline-leaves`   |          5,114 ✓ | **5,111** ✓ |                 1.03 |               0.84 |        4 of 4 |           4 of 4 |

Prompt tokens of the uncached arms, the median of two runs. On `one-big-payload`,
`A-files` answered correctly in both runs on 89,243 prompt tokens and `A-raw` on
168,366, at about 9 and 27 times the list price of code mode. No uncached run read
the cache on claude-opus-5.

On cost, the two models agree. On the large tasks the direct arm without file tools
spends more on claude-opus-5 before it gives up: 9 or 10 turns, where
claude-sonnet-5 stopped after 2. So on claude-opus-5 code mode is cheaper even
against an arm that never reached the data.

## Where it does not pay off

Two of the five tasks exist to lose. With the current harness neither did, on either
model: `outline-leaves` is a tie, and `structure-rank` is a clear code mode win,
because the direct arm counts four outlines in its own output. The first sweep had
both as narrow losses, on a harness that has been fixed since. Where the data fits
and there is little to compute, code mode is close to even.

If you take one practical thing from this repository, take this one. Code mode is
for results that do not fit, not for tidiness. When a result does not fit, it has
to be processed outside the window, and a program in a sandbox was the cheaper way
on every task here. Other people found the same shape: see
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

Every arm of the 2026-09-21 sweep ran with no file tools, and a normal Claude Code
session keeps them. The 2026-09-22 sweep answers that caveat with `A-files` and
`A-raw`: both reach the data, and on these tasks both cost 12 to 63 times as much as
code mode and were right less often.

The claim this work makes is still a narrow one: **a payload that does not fit has
to be processed outside the context window. Code mode is one way to do that, and
not the only one.** A file and a search tool is another. On these two tasks it was
the expensive one.

The model is checked once: claude-opus-5, two runs per arm, agrees on cost and
differs on the accuracy of one task. Both models ran at low effort.

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
  raw tools/list JSON      1.5 KiB  ~407-645 tokens
  typed code mode surface  1.1 KiB  ~296-469 tokens

The payload tax - what one call returns
  read_wiki_contents              683.7 KiB  ~184,250-291,729 tok  92% of window

Verdict
  deepwiki: 3 tools cost about 407 to 645 tokens to declare, which is 0% of a 200K
  window. Its largest probed result, read_wiki_contents, returned 683.7 KiB of text
  ... 452x the entire tool definition surface. A second call of this size does not
  fit. Process the result outside the context window: in a sandbox (code mode), in
  a file the agent can search, or through a narrower tool call.
```

That is the output of 2026-09-22, and the ratio is 452x, not 459x. DeepWiki renamed
one tool that day and its card grew by 22 bytes. Live servers drift, which is why
every table here carries a date. Its token figures are derived again at the band of
2.4 to 3.8 bytes per token; the byte counts are as measured.

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
- **Token counts anywhere else are estimates**, shown as a band at 2.4 to 3.8 bytes
  per token. This repo ships no tokenizer and will not print a single confident
  token number. The high end is measured: on 2026-09-22, a result of 392,601 bytes
  grew the prompt by 163,895 tokens on claude-sonnet-5 and by 163,861 on
  claude-opus-5, about 2.4 bytes per token. The band used to end at 3.3, which put
  every estimate for these models too low.
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
