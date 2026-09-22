# Prior art

What already exists, what it measures, and where this project sits next to it.

Nothing on this page is a criticism. The tools and studies below are good, most are
honest about their own scope, and several are more rigorous than this repo about
tokenization and repetitions. Checked on 2026-09-22.

## The term most tools measure

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

## The payload term is not new

Result size is measured often. It is rarely measured as a term of its own in a
code mode comparison.

- **Anthropic's [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)**
  post (November 2025) describes a transcript passing through the context twice, and
  says a larger document can break the workflow. It describes the term. It does not
  measure it.
- **[Toolathlon](https://arxiv.org/abs/2510.25726)** (ICLR 2026) cuts tool results at
  100,000 characters and gives the agent a paging tool. Depending on the model, 15%
  to 35% of results are that long, and most models succeed less often when they meet
  one.
- **StackOne**, [MCP token optimization](https://stackone.com/blog/mcp-token-optimization/)
  (March 2026): "response bloat" often takes more context than "schema bloat", and
  gets less attention.
- **Issue trackers and client errors** carry exact single-call sizes. On the GitHub
  MCP server one call returned 36,000 to about 100,000 tokens, depending on the
  tool, before the maintainers shipped smaller response types.
- **Every major client caps results.** Claude Code writes a result over 25,000 tokens
  to a file. Codex CLI truncates at 10 KiB. Gemini CLI caps at 40,000 characters. Even
  Cloudflare's code mode runtime returns at most 6,000 tokens by default.

## The benchmarks

### Anthropic, programmatic tool calling

[platform.claude.com/docs/.../programmatic-tool-calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)

The vendor page for the pattern, and it publishes a losing case: on τ²-bench,
scores unchanged and cost about 8% higher. It also reports about 38% fewer billed
input tokens on a 75-tool agent benchmark, and 20% to 40% typical savings when a
request carries 10 to 49 tool definitions.

These are billed token measurements from a real product. They are also aggregate:
no per-task table is published, so you cannot see which tasks moved which way.

### Bifrost MCP code mode benchmark

[github.com/maximhq/bifrost-benchmarking](https://github.com/maximhq/bifrost-benchmarking/blob/main/mcp-code-mode-benchmark/benchmark_report.md)

It publishes the per-query table, which is rare. Three rounds at 96, 251 and 508
tools, with 57.7%, 84.3% and 92.7% fewer **total** tokens. The input reductions are
58.2%, 84.5% and 92.8%. One model, Claude Sonnet 4.6, and one run per query.

Read the rows and two queries in round 2 regress: R2M17 by 6% and R2H6 by 75%,
both from large GitHub API responses inflating the execution context. The report
names the cause rather than dropping the rows.

Note what the baseline is doing. Round 2 sends 251 tool schemas every turn, so
the off-arm spends 270,000 to 1,200,000 input tokens per query. Most of the
reported saving is the definition term, measured at a scale where it stops
being small.

### AXI

[github.com/kunchenguid/axi](https://github.com/kunchenguid/axi) (March 2026)

17 GitHub tasks, five ways to reach GitHub, five runs each: 425 runs with Claude
Sonnet 4.6, graded by a model. The only study here that puts code mode next to a
plain CLI:

| arm             | success | cost per task | time per task |
| --------------- | ------: | ------------: | ------------: |
| AXI CLI         |    100% |        $0.050 |        15.7 s |
| `gh` CLI        |     86% |        $0.054 |        17.4 s |
| GitHub MCP      |     87% |        $0.148 |        34.2 s |
| MCP + code mode |     84% |        $0.101 |        43.4 s |

Code mode beat raw MCP on cost and lost to both CLIs on cost, success and time.

### The Bitter Lesson of Tool Calling

[arxiv.org/abs/2608.06370](https://arxiv.org/abs/2608.06370) (August 2026)

14 models on 309 BFCL v4 items, programmatic tool calling against JSON calls, same
schemas in both arms. Programmatic calling matched or beat JSON on 11 of 14 models.
Three older models lost 20 to 27 points, because they wrote a literal `\n` into
their scripts, which is the same class of bug this repository found with `\b`.

It reports a break-even: below about 26 parallel calls, programmatic calling uses
more tokens, because of its fixed prompt. Its tools are stubs that return at once,
so it measures fan-out and says nothing about payload size.

### AIMultiple

[aimultiple.com/code-execution-with-mcp](https://aimultiple.com/code-execution-with-mcp) (August 2026)

GPT-4.1 on two tasks, 50 runs each. Both arms succeeded every time. Input tokens
fell 78.5%, mostly because the direct arm resent about 15,400 tokens of tool
definitions per call. Output tokens rose 120% and latency 7%.

### CE-MCP

[arxiv.org/abs/2602.15945](https://arxiv.org/abs/2602.15945) (February 2026)

34 MCP-Bench tasks on 10 servers, three GPT models, one run each. Code execution
used fewer tokens and less time on average. It did worse on some tasks that span
three servers, it had more latency outliers, and the paper counts a much larger
attack surface as the cost.

### AWS Bedrock

[Implementing programmatic tool calling on Amazon Bedrock](https://aws.amazon.com/blogs/machine-learning/implementing-programmatic-tool-calling-on-amazon-bedrock/) (May 2026)

One task with a large payload, an expense audit over hundreds of records, on eight
models. Tokens fell 87% to 92%. With programmatic calls all eight answered
correctly. Without them, only the two Claude models did: the others made errors in
filtering and adding up, which is the accuracy effect this repository saw on
`topic-overlap`.

### Apify code-runtime eval

[github.com/apify/apify-mcp-server, res/code_runtime_eval_results.md](https://github.com/apify/apify-mcp-server/blob/master/res/code_runtime_eval_results.md) (August 2026)

Seven tasks, two modes, Claude Sonnet 5. The direct arm kept its file tools, so it
could write results to disk and process them with a shell. Code mode was about 2.9x
cheaper in total and 1.6x faster. It cost more on the two smallest tasks, and it
failed one of six graded checks that the direct arm passed. It also records what most studies leave out: the platform cost of the Actor runs both
modes started.

## Where this project is different

Three things.

**1. It measures the payload as its own term.** One DeepWiki `read_wiki_contents`
call returned 700,150 bytes (683.7 KiB) of text on 2026-09-21. That is 459 times the
entire definition surface of the server that produced it. None of the code mode
benchmarks above reports the size of one result, and the Bitter Lesson paper, the
most careful of them, uses stubs that return nothing.

**2. It publishes its losing cases as tasks, not as footnotes.** Two of the five
tasks in `tasks/` carry `expectCodeModeWins: false`, recorded before the run. They
run in the same command as the winners and print the same table.

**3. It keeps billed and estimated tokens apart.** Billed counts come from the
harness and sit in their own columns. Everything else is a band from byte counts at
3.3 to 3.8 bytes per token, labelled as an estimate where it is shown.

## What this project does not do yet

- **Repetitions.** The first sweep ran each arm once. The studies above run 5 to 50.
- **A strong direct arm.** The first sweep's direct arms had no file tools. `A-files`
  and `A-raw` exist now and have not run.
- **A tokenizer.** Use `mcp-context-cost` when you need exact counts.
- **Config auditing.** It does not read your `.mcp.json` or tell you which of
  your connected servers to drop. The tools above do that well.

Use those tools to decide which servers to connect. Use this one to find out
what happens after you call them.
