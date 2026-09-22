# codemode-lab

[![npm](https://img.shields.io/npm/v/codemode-lab)](https://www.npmjs.com/package/codemode-lab)
[![license](https://img.shields.io/npm/l/codemode-lab)](https://github.com/ondraulehla/codemode-lab/blob/main/LICENSE)

**Measure what an MCP server actually costs you. Not only its tool definitions:
its payloads too.**

MCP cost tools audit the tool schemas. On three public servers that is about
11,300 bytes, roughly 3,000 to 4,700 estimated tokens, 1.5% to 2.3% of a 200K window.

One `read_wiki_contents` call on DeepWiki returned 700,150 bytes (683.7 KiB) of
text on 2026-09-21. That is 459 times the whole definition surface of the same
server, and 92% to 146% of the window. One call.

## Use it

<!-- readme-ci skip -->

```bash
npx codemode-lab scan deepwiki
```

Output:

```text
deepwiki https://mcp.deepwiki.com/mcp (stateless)

The definition tax - what schema audits measure
  3 tools
  raw tools/list JSON      1.5 KiB  ~407-645 tokens
  typed code mode surface  1.1 KiB  ~296-469 tokens

The payload tax - what one call returns
  read_wiki_contents              683.7 KiB  ~184,250-291,729 tok  92% of window
                                 #####################################
  read_wiki_structure               1.7 KiB  ~470-744 tok  0% of window
                                 #

Verdict
  deepwiki: 3 tools cost about 407 to 645 tokens to declare, which is 0% of a 200K
  window. Its largest probed result, read_wiki_contents, returned 683.7 KiB of text,
  roughly 184,250 to 291,729 tokens, which is 92% to 146% of the window and 452x the
  entire tool definition surface. A second call of this size does not fit. Process
  the result outside the context window: in a sandbox (code mode), in a file the
  agent can search, or through a narrower tool call.
```

Output on 2026-09-22, with its token figures derived again at the band of 2.4 to
3.8 bytes per token; the byte counts are as measured. The verdict is derived from
what was measured, and it will
tell you not to bother. On Microsoft Learn the payloads are small, so it says to
turn on prompt caching instead of reaching for a sandbox. It never says code mode is
the only way: a file the agent can search does the same job, and Claude Code
already writes any MCP result over 25,000 tokens to one.

## Commands

| command             | what it does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `scan <url\|id>`    | connect, read `tools/list`, probe the read-only tools, report both costs |
| `surface <url\|id>` | print the TypeScript surface a code mode model would read                |
| `run <task-id>`     | run a task's code mode arm and measure the sandbox boundary              |
| `tasks`             | list the built-in tasks, including the ones predicted to lose            |
| `servers`           | list the measured public servers                                         |

Flags: `--json`, `--no-probe`, `--window <tokens>` (default `200000`).

Known server ids: `deepwiki`, `context7`, `mslearn`, `gitmcp`, `huggingface`,
`apify`. Any `https://` URL works too.

`scan` makes real calls. Use `--no-probe` for definitions only, with no calls
made.

## Honesty

- **Token figures are estimates.** Bytes divided by 2.4 to 3.8 bytes per token,
  always shown as a band. This package ships no tokenizer and never prints a
  single confident token number. For exact counts use
  [`mcp-context-cost`](https://github.com/athakur3/mcp-context-cost).
- **Wire bytes are not context bytes.** SSE framing and JSON escaping roughly
  double the wire size. Every context claim uses text bytes.
- **Probe arguments are printed with the result.** A generic query flatters a
  server: Microsoft Learn returns 14 bytes for "getting started" and 24,187 bytes
  for a real question. Judge the arguments, not just the number.
- **Sizes use binary units.** 1 KiB is 1,024 bytes.
- **Expensive tools are never called.** Anything whose name starts with a verb
  like `ask`, `generate` or `create`, or whose `readOnlyHint` is false, is
  reported as "not probed".

## API

The package also exports its internals:

```ts
import {
  scanServer,
  verdict,
  planProbes,
  loadTask,
  listTasks,
  runCodeModeArm,
  runDirectArm,
} from 'codemode-lab'
```

## More

Full measurements, the sandbox security posture, and the reading of every
published code mode benchmark are in the repository:
[github.com/ondraulehla/codemode-lab](https://github.com/ondraulehla/codemode-lab).

MIT © Ondrej Ulehla
