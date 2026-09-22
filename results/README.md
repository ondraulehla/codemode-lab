# Results

Every number this project publishes comes from a file in this directory. The
project page renders what a run measured and links back here. It computes nothing.

## What lands here

| File                        | Written by                              | Contents                                                        |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `sweep-<run-id>.json`       | `harness/run.mjs`, locally              | Billed tokens, per-turn figures and answers, every arm and run. |
| `latest.json`               | `harness/run.mjs`                       | A copy of the newest sweep.                                     |
| `summary-<run-id>.json`     | `harness/summarize.mjs`                 | Medians, ranges, pass^k, list-price equivalents, verdicts.      |
| `summary-latest.json`       | `harness/summarize.mjs` on `latest.json` | The summary the project page reads.                             |
| `liveness-latest.json`      | `scripts/liveness.mjs`, daily in CI     | Every published claim, re-measured, with the drift.             |
| `recording-<task>.json`     | `scripts/record-run.mjs`                | One run with timings, for the page to replay.                   |
| `check-<task>-<run-id>.json` | `harness/run.mjs --no-latest`           | A check of the harness itself. Evidence for a change, never a result. |

`liveness-latest.json` holds the last run committed from a local check. The daily
CI run keeps its own report for 90 days as an artifact on the workflow run page.

A sweep file is committed by a human after reading it. Nothing in CI writes here.

## The sweeps

| File                                   | Model           | Runs per arm | What ran                                                    |
| -------------------------------------- | --------------- | -----------: | ----------------------------------------------------------- |
| `sweep-2026-09-21T19-48-37-498Z.json`  | claude-opus-5   |            1 | every task, the first harness. See the faults below.        |
| `sweep-2026-09-22T19-21-18-555Z.json`  | claude-sonnet-5 |            5 | every task and arm. `latest.json` is this sweep.            |
| `sweep-2026-09-22T21-08-18-316Z.json`  | claude-opus-5   |            2 | `one-big-payload`, every arm, `A-files` and `A-raw` included |
| `sweep-2026-09-22T21-16-03-133Z.json`  | claude-opus-5   |            2 | the other four tasks, the four arms without file tools      |

Each has a `summary-<run-id>.json` beside it. The two claude-opus-5 files are one
check, split in two so the expensive arms ran on one task only.

## Every published number carries its provenance

A figure that cannot be traced back to a run is not a measurement, it is a claim.
Every sweep carries:

- `runId` and `startedAt`, when the sweep started, in UTC,
- `model` and `effort`, the exact model id and effort level,
- `versions`, the Claude Code build inside the SDK and the SDK version,
- `config`, the repetitions, arms and budget caps it ran with.

`startedAt` held the finishing time in the first sweep, 2026-09-21. The run id holds
the true start. Sweeps from 2026-09-22 on also carry `finishedAt`.

## Three kinds of number

**Billed tokens** come from the Anthropic API's usage field on real calls, read by
the harness. They are exact for that run.

**List-price equivalents** are billed tokens multiplied by the published prices in
`harness/prices.mjs`, with the date of the price table. They weight output at five
times input, a cache write at 1.25x and a cache read at 0.1x. A subscription run is
not billed per token, so no such figure is a cost somebody paid, and the summary
labels it that way.

**Estimates** are derived from a byte count at 3.3 to 3.8 bytes per token. They are
always printed as a band, never as a single figure, and always with the word
estimate beside it. They appear outside this directory, never inside it. The
2026-09-22 sweeps check the band once: `A-raw` on `one-big-payload` puts one result of
392,601 bytes into an otherwise unchanged prompt, and the prompt grew by about
163,900 tokens on both claude-sonnet-5 and claude-opus-5. That is 2.4 bytes per
token, so the band is generous.

Never average one kind with another.

## Bytes

Two byte counts are recorded for every call, and they differ by about 2x.

`wireBytes` is what the network carried, SSE framing and JSON escaping included.
`textBytes` is the text a model would actually be handed. Anything said about a
context window uses `textBytes`. Using wire bytes for that would double the number
and flatter the argument.

## Known faults in the first sweep

`sweep-2026-09-21T19-48-37-498Z.json` is kept as it was written. A review on
2026-09-22 found faults in the harness that wrote it, and each one is handled in the
reading, not by editing the file:

- The `boundary` figures of `B-cached` include those of `B-uncached`, because one
  counter was reset once per task. The summary flags them as unreliable.
- `toolTax` is all input over the floor arm across every turn. It is not the
  definition tax, whatever its name says.
- The direct arms declared three DeepWiki tools and could call one.
- The grade read the whole transcript, not only the final answer. Graded again on
  the last message of each arm, every grade comes out the same.
- The floor arm was not graded. Graded now, it fails all five tasks, which is the
  result a memory control should give.

## The caveat that belongs next to every number here

On the two large tasks the direct arm did not answer. Read its own words before
drawing the obvious conclusion:

> "All three dumps were fetched successfully but each exceeds the output token
> limit, so they were written to files under /tmp/... I'm blocked and need your
> input."

Nothing crashed and nothing was invented. Claude Code wrote each result over its
25,000 token output limit to a file instead of into the context, the agent had no
tool left that could read the file, and it stopped and said so. That is correct
behaviour.

It is also a consequence of how the first sweep was built. Every arm ran with
`tools: []`, which removes Read, Grep, Bash and every other built-in. A normal Claude
Code session keeps those, so it could open the file and grep it, and it would then
answer the question without code mode at all.

So the honest claim is narrower than "code mode wins". The claim is:

**A payload that does not fit has to be processed somewhere other than the context
window. Code mode is one way to do that. Claude Code's own spill-to-disk plus file
tools is another.** The first sweep removed the second option. The arms `A-files`
and `A-raw` put it back, and their predictions were written down before their first
run.

The 2026-09-22 sweep ran them, five times each, on claude-sonnet-5. Both reach the
data, and both pay for it. On `table-heavy-page`, `A-files` used 1,683,743 prompt
tokens in its median run and answered correctly in 2 runs of 5. Code mode answered
correctly in all 10 of its runs, on about 5,500 prompt tokens each. At list price
the direct arms that reach the data cost 12 to 63 times as much as code mode.

## Known faults in the 2026-09-22 sweep

`sweep-2026-09-22T19-21-18-555Z.json` is kept as it was written, like the first.

- In 35 of 55 runs, an uncached arm read the prompt cache all the same. Each such
  run carries `cacheLeak` with the tokens it read and wrote. The summary compares
  prompt tokens, so the token ratios stand; the uncached price ratios are noisier.
- A run that ran out of turns is counted as wrong in `classes`. Three `A-files` runs
  on `table-heavy-page` did: they used all 40 turns without an answer.
