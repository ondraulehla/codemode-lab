# harness

Measures what each arm actually costs, in tokens the Anthropic API counted.

Everything else in this repo counts bytes. Bytes are exact and need no credential.
This directory is the only place that reports tokens, and it never estimates them.

## Why it runs on your machine and not in CI

- The Agent SDK ships no CLI binary. It pulls a platform binary of about 218 MB from
  an optional dependency. That is a large download on every CI run, and a locked
  registry or `--no-optional` breaks it at spawn.
- The OAuth token is personal and lasts one year. A scheduled run returns a silent
  401 the day it lapses, and the workflow keeps going green until somebody reads
  the numbers.
- GitHub withholds secrets from pull request runs on forks of a public repo.
- Cache TTL depends on billing state, which CI cannot see.

So the sweep is a local command. Its output is committed, by you, after you read it.

## Setup, once

```bash
npm install
```

<!-- readme-ci skip -->

```bash
claude setup-token
```

`claude setup-token` opens a browser and prints a token exactly once. It saves it
nowhere. Put it outside the repo and lock it down:

<!-- readme-ci skip -->

```bash
umask 077; printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\n' '<paste>' > ~/.codemode-lab-token
```

Add `.codemode-lab-token` to your global gitignore. Set a reminder for eleven
months: the token lasts a year.

This path is the one Anthropic documents for scripts and CI pipelines. Running the
harness on your own subscription is sanctioned. Shipping something that logs other
people in on your subscription is not, so anyone else who runs this uses their own
credential.

## Running a sweep

<!-- readme-ci skip -->

```bash
source ~/.codemode-lab-token && node harness/probe-auth.mjs
```

The probe is the gate. It proves that `settingSources: []` still works with
subscription OAuth, which is the combination the whole benchmark depends on. If it
fails, stop, and switch to `ANTHROPIC_API_KEY`: nothing else in the harness changes,
because every arm is pinned to the five minute cache bucket and is therefore
comparable across credentials.

One cheap task, one repetition, to check the setup:

<!-- readme-ci skip -->

```bash
source ~/.codemode-lab-token && node harness/run.mjs --task outline-leaves --reps 1
```

The full sweep, five repetitions of every task:

<!-- readme-ci skip -->

```bash
source ~/.codemode-lab-token && node harness/run.mjs --reps 5
```

Arms run one at a time. A subscription has one weekly allowance, and the remote MCP
servers are other people's free infrastructure. `--arms` runs a named subset,
`--model` and `--effort` change the model, and `--raw-max-usd` caps the one arm that
can get expensive. The header of `run.mjs` lists every flag.

Then read what happened, and reduce it:

<!-- readme-ci skip -->

```bash
node harness/explain.mjs results/latest.json
node harness/summarize.mjs results/latest.json
```

`explain.mjs` prints what each arm did: its tool calls, its programs and its answer.
`summarize.mjs` writes `results/summary-<run-id>.json` with medians, ranges, pass^k,
list-price equivalents and a verdict per metric. The project page reads the summary.

## The seven arms

| Arm          | Tools the model sees                      | Caching | What it is for                                                          |
| ------------ | ----------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `floor`      | none                                      | off     | The baseline for the definition tax, and the memory control.            |
| `A-uncached` | the task's MCP tools                      | off     | Direct tool calling, the way every published comparison measures it.    |
| `A-cached`   | the same                                  | on      | Direct tool calling, the way a competent production user would ship it. |
| `A-files`    | the task's MCP tools, plus Read and Grep  | off     | The direct arm a real session is: it can open a spilled result.         |
| `A-raw`      | the task's MCP tools, output limit raised | off     | The payload lands in the window, so its cost is counted.                |
| `B-uncached` | one `run_code` tool                       | off     | Code mode.                                                              |
| `B-cached`   | one `run_code` tool                       | on      | Code mode, cached.                                                      |

Every task runs `floor`, the two `A` arms and the two `B` arms. `A-files` and
`A-raw` run only on tasks that name them in `extraArms`, which today are the two
large ones.

**Both sides declare the same tools.** The direct arms have every tool the task does
not allow removed from their context with `disallowedTools`, and denied by name on
the server entry as well. The code mode surface lists only the allowed tools. Until
2026-09-22 the direct arm declared all three DeepWiki tools and could call one, and
the two extra definitions were resent on every turn.

**Why A-files and A-raw exist.** Claude Code writes any MCP result over 25,000 tokens
to a file and gives the model the path. The first sweep's direct arms had no tool to
open that file, so on the two large tasks they never saw the data. That measured
access, not cost. `A-files` gives the arm Read and Grep, and only those: Bash would
let it fetch the payload again with curl. `A-raw` sets `MAX_MCP_OUTPUT_TOKENS` to
1,000,000, so the result enters the window and is billed there.

**The floor arm turns an estimate into a measurement.** Its first request and the
first request of `A-uncached` are both uncached, and the only difference between
them is what the arm declares:

```text
definition_tax = A_uncached.turn1_prompt - floor.turn1_prompt
```

That is a number the API counted. No tokenizer, no token counting endpoint, no
bytes-per-token guess. The first sweep published `A_uncached.input - floor.input`
under this name, summed over every turn. That includes every tool result and every
resent turn, and it is still recorded, as `extraInputOverFloor`.

**The floor is also the memory control.** It has no tools, so it is graded like
every other arm and must fail. A floor that passes answered from memory, and the
sweep prints a warning: the task does not measure data access.

**Cached is run for both modes because comparing across them is the trick.** Every
published code mode comparison measures against an uncached direct baseline.
Anthropic bills cache reads at about a tenth of base input, and tool definitions sit
in the cacheable prefix. So part of the reported saving is a saving that one line of
configuration would also have given you. Compare cached with cached.

Caching and code mode do not solve the same problem:

|                | Cuts the bill                                    | Frees the window |
| -------------- | ------------------------------------------------ | ---------------- |
| Prompt caching | yes, about 10x on anything read again            | no               |
| Code mode      | yes, when the program returns less than it reads | yes              |

A cached prefix still occupies the window. A large result is written to the cache
at 1.25x when it first arrives, and every later turn reads it back at 0.1x. So cache
makes the second and later reads cheap. It does nothing for the first read and
nothing for the room the result takes.

## What each arm records

- **Billed usage** from `modelUsage` on the last result message, per model.
- **Per-turn usage**, once per API response: `turns`, `turn1Prompt` and
  `peakPrompt`, the fullest the window got. The SDK streams one message per content
  block, all with the same usage, so usage is read once per message id.
- **Spilled results**: tool results Claude Code replaced with a file path.
- **The answer**, from the final result message, and its class: `correct`, `wrong`,
  or `no-data` when the only copy of the data went to a file the arm could not open.
- **For code mode**, every program with its failure class, its calls and its
  distinct calls, and the bytes that went to the model: value, logs or error text.
- **Permission denials**, and Claude Code's own cost estimate, kept only as a cross
  check on `prices.mjs`.

Each arm runs in an empty working directory with a fresh config directory, and both
are deleted afterwards. The working directory used to be the repository, where an
arm that can Grep would find the grading strings in `tasks/<id>/task.json`.

## What gets discarded

A crashed run carries zeroed usage. Written to a results file, it looks like a valid
arm that used no tokens, which does not read as an error. It reads as a finding.
That is the worst failure mode in this design, so `assert.mjs` throws rather than
records when any of these fails:

1. The run ended in an error, and the task did not declare in `mayNotComplete` that
   this arm may end that way.
2. The tools the SDK reported at init are not exactly the expected list. This
   catches a server that hit the connect timeout, and a removal that did not take
   effect. The check existed from the start but the sweep never passed it a list,
   so it did not run until 2026-09-22.
3. An uncached arm shows any cache read or cache write. The outcome is asserted. The
   environment variable is not trusted to have fired.
4. A cached arm shows no cache read.
5. Any arm used the one hour cache bucket. One hour exists in only one billing
   state, so a one hour number is not reproducible by a reader on another credential.

Version drift is recorded too. Apify moved every one of its tool sizes between two
releases, by up to 5.4 percent on one tool. Without the SDK manifest version and
each server's reported version, week over week numbers mean nothing.

## What the check runs of 2026-09-22 showed

Two runs of the cheapest task checked the harness after the review. Both are kept,
as `results/check-outline-leaves-*.json`:

<!-- readme-ci skip -->

```bash
source ~/.codemode-lab-token && node harness/run.mjs --task outline-leaves --reps 1 --no-latest
```

```text
first check, before server instructions reached the code mode arm
  definition tax    direct 1,287 tokens   code mode   869 tokens
  input tokens      direct 5,115          code mode 4,289

second check, with the instructions passed to both arms
  definition tax    direct 1,289 tokens   code mode 1,282 tokens
  input tokens      direct 5,117          code mode 5,109
```

The gap on the first request, 418 tokens, is DeepWiki's 3,129 bytes of server
instructions. Claude Code gives them to a direct arm and nothing gave them to code
mode, so code mode looked cheaper for a reason that had nothing to do with code
mode. With the instructions in both arms, the definition taxes agree to 7 tokens,
the input tokens are a tie, and at list price code mode costs 3% more, because it
writes more output. In both runs every arm loaded exactly the tools it should, and
the floor answered wrongly, which is what a memory control should do.

## The crossover: where does code mode start to pay?

The live tasks say whether code mode wins on five questions. They cannot say at
what payload size it starts to win, because a live server does not return a payload
of a chosen size. The crossover does, on a synthetic orders server:

<!-- readme-ci skip -->

```bash
node harness/crossover.mjs --plan
source ~/.codemode-lab-token && node harness/crossover.mjs --yes
node harness/crossover.mjs --summary results/crossover-<run-id>.json
```

- **The data.** `synthetic/orders.mjs` makes an order export of any size, in any
  number of shards, from a seed. The question filters on two columns and takes a
  maximum, so every row matters. The order ids are random, so no model knows the
  answer, and the answer is computed from the rows, not looked up.
- **The arms.** The same seven as the live sweep, plus `A-tool`: a direct arm whose
  tool filters on the server, so only matching rows travel. That is the third way to
  keep a large result out of the window, after a sandbox and a file.
- **The output.** For each shard count, the list-price ratio of code mode against
  each direct arm at each size, and where it crosses 1x, interpolated in log2 of the
  size between the two measured points around it.
- **The predictions.** `synthetic/predictions.json` holds them, dated. The script
  refuses to run without the file. Edit the predictions before the first run, and
  never after it.
- **The cost.** `--plan` prints the number of runs and a ceiling: every arm hitting
  its budget cap. The default plan is 144 runs with a ceiling of about $520 at list
  price. Small sizes cost cents; the raw arm at 1 MiB is the expensive part. Start
  with `--sizes 1,4,16,64 --reps 1` to check the setup.

`--model` changes the model for both sweeps. Claude Haiku 4.5 has a 200K window, so
on it the raw arm meets the window before it meets anything else, which is the case
the first sweep assumed and never measured.

## Not built yet

- **A sub-agent arm.** A sub-agent reads the payload in its own context and hands
  the main agent a summary. The harness keeps sub-agent turns apart from the main
  loop already, but no arm defines one yet.
- **Context editing.** Clearing old tool results from the history is another way to
  stop a payload from being resent every turn. Claude Code manages its own context,
  so this needs a harness on the raw Messages API, not the Agent SDK.
- **A second live server with large results.** A task on the GitHub MCP server or on
  Apify datasets needs a token, and a grading string checked the way the DeepWiki
  tasks were.

## What this does not measure

- **Dollars paid.** The summary turns billed tokens into a list-price equivalent,
  and says so. A subscription run is not billed per token.
- **Fidelity.** The typed surface arm B reads loses some schema detail: recursive
  `$ref` collapses, and `not` and `if`/`then`/`else` are dropped. Part of any code
  mode saving is lost detail, not free compression.
- **Security.** The Node worker arm B runs programs in is an isolation boundary for
  measurement. It is not a security boundary against hostile code.

Grading is deterministic substring matching against `expect.mustMention` in each
`task.json`, on the final answer. It is dumb on purpose. A model grading a model
would put the thing under test inside the measurement. A cheaper arm that fails its
task is not cheaper.
