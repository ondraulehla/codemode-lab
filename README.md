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

Everyone publishing about code mode measures the **catalogue card**: the list of
which tools exist and what arguments they take. It is small.

| what                                                           |   bytes |
| -------------------------------------------------------------- | ------: |
| tool definitions of three public MCP servers, 8 tools in total |  11,268 |
| text returned by **one call** to one of those tools            | 683,700 |

One result is **459 times** the entire catalogue of the server it came from.

Measuring the card and ignoring the manuals is how you get a headline like
"98.7 percent saved". That number is real, and it is about the card.

## What I measured

Five questions, each asked twice: once by an agent calling tools directly, once by
an agent writing a program. Same model, same question, same tools.

The prediction for each was written down **before** the run.

| task               |      direct |   code mode | predicted       | held     |
| ------------------ | ----------: | ----------: | --------------- | -------- |
| `table-heavy-page` |    53,416 ✗ | **8,788** ✓ | code mode wins  | yes      |
| `one-big-payload`  |    26,179 ✗ | **8,879** ✓ | code mode wins  | yes      |
| `topic-overlap`    |    11,085 ✗ | **9,600** ✓ | _uncertain_     | resolved |
| `structure-rank`   | **8,133** ✓ |     8,275 ✓ | code mode loses | yes      |
| `outline-leaves`   | **5,665** ✓ |     5,860 ✓ | code mode loses | yes      |

Input tokens counted by the Anthropic API, not estimated. Uncached arms,
claude-opus-5, 2026-09-21. ✓ means the arm answered the question correctly.

**The direct arm does not crash.** On the three large tasks it stopped and said so:

> "All three dumps were fetched successfully but each exceeds the output token
> limit, so they were written to files under /tmp/... I'm blocked and need your
> input."

It did not invent an answer. It correctly refused. That is a better finding than a
failure, and it is the honest shape of the problem: **a payload that does not fit
has to be processed somewhere other than the context window.**

## Where it does not pay off

Two of the five tasks exist to lose, and they lost. Code mode cost **195 and 142
more input tokens** than calling the tools directly.

That is not a disaster. It is simply pointless. When the data already fits in the
window there is nothing to filter, so the program is a round trip you paid for and
did not need.

If you take one practical thing from this repository, take that one. Code mode is
for large results, not for tidiness.

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
   one. The comparison was rigged, and not in the direction I assumed.
4. **A permission setting bypassed a tool ban.** DeepWiki's `ask_question` is backed
   by a language model and spends the provider's money, so this harness banned it.
   `bypassPermissions` bypassed the ban and it was called anyway.

Every replacement question is graded on a string the documentation generator
invented, checked with GitHub code search to return zero hits inside its own
repository. A model cannot produce those strings without reading the data.

### The caveat this work earns

Every arm ran with no file tools. A normal Claude Code session keeps them, so it
could open the spilled file and grep it, and answer without code mode at all.

So the narrow claim is not "code mode wins". It is: **a payload that does not fit
must be processed outside the context window. Code mode is one way to do that, and
not the only one.**

## Try it

```bash
npm install && npm run build
```

Ask what a public MCP server actually costs you, both ways round:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan deepwiki
```

```
The definition tax - what every other tool measures
  3 tools
  raw tools/list JSON       1.5 kB  ~402-462 tokens
  typed code mode surface   1.1 kB  ~304-351 tokens

The payload tax - what nobody measures
  read_wiki_contents               683.7 kB  ~184,250-212,167 tok  92% of window

Verdict
  deepwiki: 3 tools cost about 402 tokens to declare, which is 0% of a 200K window.
  Its largest probed result returned 683.7 kB of text ... 459x the entire tool
  definition surface. Two or three calls exhaust the window.
```

Point it at a server with the opposite shape and it tells you the opposite thing:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js scan apify
```

```
  apify: 11 tools cost about 20,222 tokens to declare, which is 10% of a 200K
  window ... 7.7x SMALLER than the tool definitions. This is the inverted case:
  the definitions are the expensive term, not the results.
```

Run one task's code mode arm against the live server:

<!-- readme-ci skip -->

```bash
node packages/cli/dist/bin.js run one-big-payload
```

## Repository map

| path                  | what it is                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `packages/mcp-client` | MCP over HTTP: both transports, and the event stream three of five public servers answer with |
| `packages/runtime`    | the sandbox. An opaque-origin iframe in a browser, a worker in Node                           |
| `packages/typegen`    | turns tool schemas into the TypeScript surface a model writes against                         |
| `packages/meter`      | the only thing in the repo that counts bytes                                                  |
| `packages/cli`        | `scan`, `surface`, `run`, `tasks`, `servers`                                                  |
| `harness/`            | the five arms that report billed tokens. Runs locally, never in CI                            |
| `tasks/`              | the five questions, their grading, and a reference program each                               |
| `results/`            | committed measurements, each with a run id and a model id                                     |

## Honest about the numbers

- **Byte counts are exact.** They are measured at the boundary and stated as fact.
- **Token counts in `results/` are billed**, read off the API response.
- **Token counts anywhere else are estimates**, shown as a band at 3.3 to 3.8 bytes
  per token. This repo ships no tokenizer and will not print a single confident
  token number.
- **Context figures never use wire bytes.** SSE framing and JSON escaping make the
  wire figure roughly twice the text, and only the text reaches a model.
- **No dollar figure is published as measured.** There is no server-side usage API
  for an individual account, so any cost would be a client-side estimate.

More in [docs/methodology.md](docs/methodology.md), the sources and what is claim
versus measurement in [docs/code-mode.md](docs/code-mode.md), the measured server
table in [docs/servers.md](docs/servers.md), and what already exists in
[docs/prior-art.md](docs/prior-art.md).

A daily [liveness probe](.github/workflows/liveness.yml) re-measures every published
claim and fails when one goes stale. These are live documents on somebody else's
free servers, so the numbers here rot unless something watches them.

## License

MIT. See [LICENSE](LICENSE).
