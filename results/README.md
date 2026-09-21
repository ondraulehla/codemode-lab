# Results

Every number this project publishes comes from a file in this directory. Nothing in
`site/` computes a figure. It renders what a run measured, and it links back here.

## What lands here

| File                    | Written by                             | Contents                                            |
| ----------------------- | -------------------------------------- | --------------------------------------------------- |
| `liveness-latest.json`  | `scripts/liveness.mjs`, daily in CI    | Every published claim, re-measured, with the drift. |
| `harness-<run-id>.json` | the token harness, when it is wired up | Billed input and output tokens for both arms.       |

`liveness-latest.json` holds the last run only. The full history lives on the
workflow run pages, where each run keeps its report for 90 days as an artifact.

## Every published number carries its provenance

A figure that cannot be traced back to a run is not a measurement, it is a claim.
Every record written here carries four fields, and the page that shows the number
shows them too:

- `runId` – the CI run that produced it, which links to the log,
- `model` – the exact model id, for anything a model produced,
- `timestamp` – ISO 8601, UTC, when the measurement was taken,
- the path to the raw file, so a reader can check the number for themselves.

## Estimates against billed counts

Two kinds of token number appear in this project, and they must never be confused.

An **estimate** is derived from a byte count at 3.3 to 3.8 bytes per token. It is
always printed as a band, never as a single figure, and always with the word
estimate beside it. Everything published today is an estimate. This repo ships no
tokenizer.

A **billed count** comes from the Anthropic API's usage field on a real call. None
exist yet. The harness that will produce them is blocked on one open question, which
`.github/workflows/harness.yml` documents. When billed counts land, they land here
as their own files and the pages that show them say which kind of number they are.

## Bytes

Two byte counts are recorded for every call, and they differ by about 2x.

`wireBytes` is what the network carried, SSE framing and JSON escaping included.
`textBytes` is the text a model would actually be handed. Anything said about a
context window uses `textBytes`. Using wire bytes for that would double the number
and flatter the argument.

## The caveat that belongs next to every number here

The direct arm fails the three large tasks. Read its own words before drawing the
obvious conclusion:

> "All three dumps were fetched successfully but each exceeds the output token
> limit, so they were written to files under /tmp/... I'm blocked and need your
> input."

Nothing crashed and nothing was invented. Claude Code spilled the oversized tool
results to disk instead of into the context, the agent had no tool left that could
read them, and it stopped and said so. That is correct behaviour.

It is also a consequence of how this harness is built. Every arm runs with
`tools: []`, which removes Bash, Read and every other built-in. A normal Claude Code
session keeps those, so it could open the spilled file and grep it, and it would
then answer the question without code mode at all.

So the honest claim is narrower than "code mode wins". The claim is:

**A payload that does not fit has to be processed somewhere other than the context
window. Code mode is one way to do that. Claude Code's own spill-to-disk plus file
tools is another.** This harness removes the second option on purpose, to isolate
the first. A reader who has file tools available should weigh that.

What the numbers do show, and this part is not an artifact: on the same question,
with the same model, the code mode arm answered correctly on 8,788 input tokens
where the direct arm needed 53,416 and still could not finish.
