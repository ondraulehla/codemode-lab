# Scripts

Small Node programs that measure things directly, without the CLI. Each one imports
the built packages, so run the build first:

```sh
npx tsc --build
```

Then run any script from anywhere. The import paths are relative to the script file,
not to your shell.

| Script                 | What it is for                                                                                                                      | Calls live servers |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `liveness.mjs`         | Re-measures every published claim and fails when one went stale. CI runs it daily.                                                  | yes                |
| `smoke.mjs`            | Connects to all five keyless servers, prints transport mode and tool names, then streams one 1.48 MiB payload with live progress.   | yes                |
| `measure-payloads.mjs` | Reads seven DeepWiki wikis and prints the wire, text and estimated token cost of each. This is where the headline table comes from. | yes                |
| `show-surface.mjs`     | Prints the TypeScript surface a code mode model reads, next to the raw `tools/list` JSON it replaces.                               | yes                |
| `e2e.mjs`              | One end to end run: a real program in a real sandbox, four wikis in, one small summary out.                                         | yes                |
| `record-run.mjs`       | Records one task, both arms, with timings, so the project page can replay the run instead of calling the server from every visit.   | yes                |

## What liveness.mjs checks

It is the guard against claim rot. The README and the project page publish numbers that were
true on the day they were measured, and other people own every server behind them.
For each keyless server the probe confirms:

- the transport mode still matches the recorded one,
- the tool count and the tool names still match,
- the `tools/list` byte size and the typed surface are within 10 percent of the
  recorded values,
- the CORS preflight from `https://ulehla.dev` still returns what was recorded,
- the text of the recorded largest call is within 35 percent of its recorded size.

It then runs every task's code mode arm. A task published as a win must still read
one result over Claude Code's 25,000 token MCP output limit, and still return at
least 50 times less than it reads. A task published as a loss must still read less
than a quarter of a 200K window. A task recorded as uncertain is only checked to
run. The report lands in `results/liveness-latest.json`. The script exits non-zero
and names the exact claim that changed.

The tool names check is new on 2026-09-22. That day DeepWiki renamed `ask_question`
to `ask_wiki_question`, the count stayed at three, and nothing noticed.

The workflow step must run with `shell: bash`. Without it the step runs `bash -e`
with no pipefail, the exit code of `node ... | tee` is the exit code of `tee`, and
the run went green on 2026-09-22 while the probe reported two stale claims.

Each tolerance is explained where it is defined, at the top of `liveness.mjs`. When a
number drifts, fix the number or fix the claim. Do not widen the tolerance.

## Courtesy

Every server here is free and somebody else pays for it. These scripts run serially,
never in a burst. `liveness.mjs` runs once a day in CI and nowhere else.

No script calls DeepWiki's question tool, `ask_wiki_question`. It runs a model on
the provider's account, so it spends their money. `planProbes` in the CLI skips any
tool whose name starts with `ask`, and nothing here calls it by hand.

## A note on token numbers

This repo ships no tokenizer. Every token figure these scripts print is an estimate
from a byte count, at 2.4 to 3.8 bytes per token, and is printed as a band with the
word estimate next to it. Billed token counts come from the harness, which runs
locally. See [harness/README.md](../harness/README.md).

Wire bytes and text bytes are different numbers and differ by about 2x. Text bytes are
what would enter a context window. Anything said about a context window uses text
bytes.
