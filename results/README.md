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
