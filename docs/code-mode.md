# Code mode: the sources, and what they actually claim

Code mode is a simple idea with a loud number attached to it. This page
separates the idea from the number.

Every source below was opened and read. Where a figure is a measurement, it says
so. Where a figure is a worked example of a hypothetical task, it says that
instead.

## The idea

A normal MCP agent works like this:

1. All tool schemas load into context.
2. The model emits a tool call.
3. The whole tool result lands in context.
4. Repeat.

Code mode changes step 3 and only step 3:

1. The tool schemas become a typed surface, usually TypeScript declarations.
2. The model writes a program against that surface.
3. The program runs in a sandbox. Tool results land **in the sandbox**.
4. Only the program's return value reaches the model.

That is the whole mechanism. The model still chooses what to call. The tokens it
saves are the tool-result tokens it never sees.

Two separate savings hide inside that description, and most writing about code
mode mixes them:

- **The definition saving.** A typed surface is smaller than raw JSON Schema,
  and a surface can be loaded on demand instead of all at once. Measured in this
  repo on 2026-09-22: 27% smaller on DeepWiki, 36% smaller on Microsoft Learn.
  Small numbers on small numbers.
- **The payload saving.** A result the program filters never enters context.
  Measured in this repo on 2026-09-22: 1,393,773 bytes (1.33 MiB) in, 371 bytes
  out on `table-heavy-page`.

The first is what the famous percentages measure. The second is what decides
whether a task runs.

## Anthropic: Code execution with MCP

[anthropic.com/engineering/code-execution-with-mcp](https://www.anthropic.com/engineering/code-execution-with-mcp)

This post introduced the pattern to a wide audience, and it carries the figure
everyone repeats: token usage falling from 150,000 to 2,000, a saving of 98.7%.

**That figure is a worked example of a hypothetical task, not a measurement.**
The post walks through a Google Drive to Salesforce scenario and computes what
the two approaches would cost. No benchmark, no harness, no runs.

The post is a good design document. The 98.7% is arithmetic on an illustration,
and the sentence around it is about loading only the tool definitions a task
needs. Anyone quoting it as a measured result is quoting something the post does
not say.

The post does name the payload term too. It describes a meeting transcript that
passes through the context twice, about 50,000 extra tokens for a two hour
meeting, and says a larger document can break the workflow. It describes that
term. It does not measure it.

Simon Willison covered it the same day, on 4 November 2025:
[simonwillison.net/2025/Nov/4/code-execution-with-mcp/](https://simonwillison.net/2025/Nov/4/code-execution-with-mcp/).
He calls the approach a sensible use of a coding agent's strengths, and closes by
noting that Anthropic set out the proposal in detail but shipped no code to
execute on it. That gap is part of why this repository exists.

## Cloudflare: Code Mode

[blog.cloudflare.com/code-mode-mcp/](https://blog.cloudflare.com/code-mode-mcp/)

Title: "Code Mode: give agents an entire API in 1,000 tokens", 20 February 2026.

The figure here is 99.9%. Read what it is measured over.

Cloudflare's API has more than 2,500 endpoints. Declaring each one as an MCP
tool would produce about 1.17 million tokens of **tool definitions**. Code Mode
replaces all of them with two general tools, `search()` and `execute()`, which
costs about 1,000 tokens. 1,000 against 1.17 million is the 99.9%.

**That is a measurement of a tool definition blob, not of tokens consumed by a
task.** The post counted it with tiktoken, which is an OpenAI tokenizer, not
Claude's. It is a real and useful number: it says a 2,500-endpoint API cannot be
exposed as 2,500 tool definitions, which is true and important. It says nothing
about what happens when `execute()` returns a large response.

So both famous percentages describe the definition term. Neither measures the
payload term.

The first Cloudflare post,
[Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/)
(26 September 2025), gives no numbers at all. Its argument is that models have seen
far more real code than tool calls, and that chained calls stop copying each output
through the model.

## Anthropic: Programmatic tool calling

[platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)

This is the product page for the same pattern, and it is the most honest vendor
source on the subject, because it publishes a case where the pattern loses.

Measurements it reports from internal evaluations:

| evaluation                                                                | result                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 75-tool project management agent benchmark                                | about 38% fewer billed input tokens, no change in task accuracy |
| Production API traffic, 10 to 49 tool definitions per request             | typical savings of 20% to 40%                                   |
| [τ²-bench](https://arxiv.org/abs/2506.07982), airline, retail and telecom | scores unchanged, cost about 8% **higher**                      |
| BrowseComp and DeepSearchQA, with search tools                            | about 11% better performance, 24% fewer input tokens            |

The τ² row is the one to remember. Each turn in that benchmark makes one or two
sequential tool calls. The page states plainly that workflows of one sequential
call at a time do not benefit.

The page also lists the shapes where it does not pay: strictly sequential
workflows where each call depends on the model reasoning over the previous
result, a small number of calls with small responses, and tools that need user
feedback between calls.

This repo's `outline-leaves` and `structure-rank` tasks have that shape: a few
small results. Both were predicted to lose. See the README for how they came out,
and for why one run cannot settle it.

## Bifrost: the published per-query dataset

[github.com/maximhq/bifrost-benchmarking/.../benchmark_report.md](https://github.com/maximhq/bifrost-benchmarking/blob/main/mcp-code-mode-benchmark/benchmark_report.md)

This is the most useful public artifact in the space, because it publishes the
per-query table instead of the headline only.

Headline results, code mode off against code mode on:

| round | tools | total token reduction | input token reduction |
| ----- | ----: | --------------------: | --------------------: |
| 1     |    96 |                 57.7% |                 58.2% |
| 2     |   251 |                 84.3% |                 84.5% |
| 3     |   508 |                 92.7% |                 92.8% |

The headline percentages are total tokens. An earlier version of this page called
them input reductions. The report ran one model, Claude Sonnet 4.6, and one run per
query.

Read the per-query table and a different picture appears. Round 2, query H6:

| query | code mode OFF, input | code mode ON, input | reported input reduction |
| ----- | -------------------: | ------------------: | -----------------------: |
| R2H6  |              835,600 |           1,466,500 |                 **-75%** |

The reduction is negative, so code mode made that query 75% **more** expensive. One other query, R2M17,
regressed by 6%. The report names the cause: large GitHub API responses
inflating the execution context.

Two things follow.

**First, the headline reductions are mostly a definition-term saving.** Look at
the OFF column across round 2: query after query costs 270,000 to 1,200,000
input tokens. With 251 tool schemas re-sent every turn, most of that is
definitions. Removing them dominates the average. That is a real saving and it
is the same term Cloudflare measured.

**Second, a large payload can reverse the sign.** R2H6 is what happens when the
result is big and the program does not shrink it before returning. This is
exactly the failure mode this repo is built to surface, and Bifrost deserves
credit for publishing the row instead of trimming it.

## Measured since

Several people have measured code mode on real tasks since these sources were
written, and some of them found losses. The summary is in
[prior-art.md](prior-art.md). The short version: a large code mode saving is usually
a definition saving; code mode costs output tokens and latency; it loses when the
task is small; and a strong direct arm with a CLI or file tools is much harder to
beat than a bare one.

## What this repository adds

None of the code mode sources above measures what a single public MCP tool call
returns, as its own term.

This repo does, on live servers, with the commands in the box. One DeepWiki
`read_wiki_contents` call returned 700,150 bytes (683.7 KiB) of text on
2026-09-21, which is 92% to 106% of a 200K window and 459 times the whole
definition surface of that server.

Against that term, a 24% smaller schema file is noise, and a 98.7% saving on an
illustrated task is not a number you can plan with.

See [docs/methodology.md](methodology.md) for how each figure here was produced.
