# codemode-lab

[![npm](https://img.shields.io/npm/v/codemode-lab)](https://www.npmjs.com/package/codemode-lab)
[![license](https://img.shields.io/npm/l/codemode-lab)](https://github.com/ondraulehla/codemode-lab/blob/main/LICENSE)

**Measure what an MCP server actually costs you. Not its tool definitions, its
payloads.**

Every other MCP cost tool measures the tool schemas. On three public servers
that is about 11.3 kB, roughly 3,000 estimated tokens, 1.5% of a 200K window.

One `read_wiki_contents` call on DeepWiki returns 683.7 kB of text. That is 459
times the whole definition surface of the same server, and 92% to 106% of the
window. One call. Measured 2026-09-21.

## Use it

<!-- readme-ci skip -->

```bash
npx codemode-lab scan deepwiki
```

Output:

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
```

The verdict is derived from what was measured, and it will tell you not to
bother. On Microsoft Learn the payloads are small, so it says to turn on prompt
caching instead of reaching for a sandbox.

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

- **Token figures are estimates.** Bytes divided by 3.3 to 3.8 bytes per token,
  always shown as a band. This package ships no tokenizer and never prints a
  single confident token number. For exact counts use
  [`mcp-context-cost`](https://github.com/athakur3/mcp-context-cost).
- **Wire bytes are not context bytes.** SSE framing and JSON escaping roughly
  double the wire size. Every context claim uses text bytes.
- **Probe arguments are printed with the result.** A generic query flatters a
  server: Microsoft Learn returns 14 bytes for "getting started" and 23.6 kB for
  a real question. Judge the arguments, not just the number.
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
