# Prior art

What already exists, what it measures, and where this project sits next to it.

Nothing on this page is a criticism. The tools below are good, they are honest
about their own scope, and most of them are more rigorous than this repo about
tokenization. They measure a different term.

## The term everyone measures

An MCP client sends every connected server's tool schemas with the request. Name,
description and JSON Schema, on every turn, used or not. Connect five or ten
servers and that is 15,000 to 30,000 tokens before the user types anything.

Call it the **definition tax**. It is real, it recurs every turn, and it is worth
auditing.

### mcp-context-cost

[github.com/athakur3/mcp-context-cost](https://github.com/athakur3/mcp-context-cost)

Audits your own `.mcp.json`, diffs a change, and gates a token budget in CI:

<!-- readme-ci skip -->

```bash
npx -y mcp-context-cost audit --config .mcp.json --budget 20000
```

It runs a real tokenizer. It measures canonically with `o200k_base` and
separately counts what a request actually carries with the target model's own
tokenizer, so the two effects stay apart.

This is the most careful tool in the group, and it is the one to reach for when
you need exact numbers. This repository ships no tokenizer and says so on every
table.

### MCPView

[mcpview.teamcopilot.ai](https://mcpview.teamcopilot.ai/)

Paste a server URL, see its tools, resources and prompts, and the token
footprint each adds. It ranks tools by cost, which makes it fast to spot the one
tool with a deeply nested input schema that is quietly costing more than the
other twenty.

Scope: schema metadata only.

### PolicyLayer token cost

[policylayer.com/token-cost](https://policylayer.com/token-cost)

A calculator for what connected servers cost per request in tool definitions,
with the cost translated into money at model rates.

Scope: schema metadata only.

### mcpfold calculator

[mcpfold.com/mcp-token-calculator](https://mcpfold.com/mcp-token-calculator/)

Pick servers from a catalogue or paste a config, untick the tools you do not
use, and see what a scoped grant saves. The framing is useful: most of the
definition tax is tools you never call.

Scope: schema metadata per turn.

## The benchmarks

### Anthropic, programmatic tool calling

[platform.claude.com/docs/.../programmatic-tool-calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)

The vendor page for the pattern, and the only vendor source that publishes a
losing case: on τ²-bench, scores unchanged and cost about 8% higher. It also
reports about 38% fewer billed input tokens on a 75-tool agent benchmark, and
20% to 40% typical savings when a request carries 10 to 49 tool definitions.

These are billed token measurements from a real product. They are the strongest
numbers in the field. They are also aggregate: no per-task table is published,
so you cannot see which tasks moved which way.

### Bifrost MCP code mode benchmark

[github.com/maximhq/bifrost-benchmarking](https://github.com/maximhq/bifrost-benchmarking/blob/main/mcp-code-mode-benchmark/benchmark_report.md)

The most useful public artifact here, because it publishes the per-query table.
Three rounds at 96, 251 and 508 tools, with 57.7%, 84.3% and 92.7% input token
reductions.

Read the rows and two queries in round 2 regress: R2M17 by 6% and R2H6 by 75%,
both from large API responses inflating the execution context. The report names
the cause rather than dropping the rows.

Note what the baseline is doing. Round 2 sends 251 tool schemas every turn, so
the off-arm spends 270,000 to 1,200,000 input tokens per query. Most of the
reported saving is the definition term again, measured at a scale where it stops
being small.

## Where this project is different

Three things.

**1. It measures the payload, not the schema.** One DeepWiki
`read_wiki_contents` call returns 683.7 kB of text. That is 459 times the entire
definition surface of the server that produced it, and 92% to 106% of a 200K
window. No tool above reports that number for any server.

**2. It publishes its losing cases as tasks, not as footnotes.** Two of the
three tasks in `tasks/` carry `expectCodeModeWins: false`, recorded before the
run. `single-call` returns more bytes than it received. `sequential-pair` saves
nothing and adds a hop. They run in the same command as the winner and print the
same table.

**3. It refuses to state a token count it did not measure.** Every token figure
is a band from byte counts at 3.3 to 3.8 bytes per token, labelled as an
estimate at the point of display. There is no "98.7% reduction" headline here
because this repo cannot honestly produce one.

## What this project does not do

- **No tokenizer.** Use `mcp-context-cost` when you need exact counts.
- **No accuracy measurement.** The direct arm counts volume, with no model in
  the loop. This repo claims a payload does not fit. It does not claim better
  answers.
- **No config auditing.** It does not read your `.mcp.json` or tell you which of
  your connected servers to drop. The tools above do that well.

Use those tools to decide which servers to connect. Use this one to find out
what happens after you call them.
