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

<!-- readme-ci skip -->

```bash
source ~/.codemode-lab-token && node harness/run.mjs --task cross-repo-scan --reps 1
```

Arms run one at a time. A subscription has one weekly allowance, and the remote MCP
servers are other people's free infrastructure.

## The five arms

| Arm          | MCP servers             | Caching | What it is for                                                                   |
| ------------ | ----------------------- | ------- | -------------------------------------------------------------------------------- |
| `floor`      | none                    | off     | The overhead baseline. Everything else is measured against it.                   |
| `A-uncached` | the real remote servers | off     | Direct tool calling, the way every published comparison measures it.             |
| `A-cached`   | the same servers        | on      | Direct tool calling, the way a competent production user would actually ship it. |
| `B-uncached` | one `run_code` tool     | off     | Code mode.                                                                       |
| `B-cached`   | one `run_code` tool     | on      | Code mode, cached.                                                               |

Five, not three. Two reasons.

**The floor arm turns an estimate into a measurement.** Both it and `A-uncached`
carry no cache, so the whole prompt lands in `input_tokens`, and the only difference
between them is the tool definitions:

```
tool_tax = A_uncached.input_tokens - floor.input_tokens
```

That is a number the API counted. No tokenizer, no token counting endpoint, no
bytes-per-token guess.

**Cached is run for both modes because comparing across them is the trick.** Every
published code mode comparison measures against an uncached direct baseline.
Anthropic bills cache reads at about a tenth of base input, and tool definitions sit
in the cacheable prefix. So part of the reported saving is a saving that one line of
configuration would also have given you. Compare cached with cached.

Caching and code mode do not solve the same problem:

|                | Cuts the bill                 | Frees the window |
| -------------- | ----------------------------- | ---------------- |
| Prompt caching | yes, about 10x on definitions | no               |
| Code mode      | yes                           | yes              |

A cached prefix still occupies the window. And caching cannot help at all with a
683 kB payload, because payloads are unique and are never the cacheable prefix.
That case is the one only code mode fixes.

## What gets discarded

A crashed run carries zeroed usage. Written to a results file, it looks like a valid
arm that used no tokens, which does not read as an error. It reads as a finding.
That is the worst failure mode in this design, so `assert.mjs` throws rather than
records when any of these fails:

1. `is_error` is false and the subtype is not an execution or max turns error.
2. The loaded tool list matches expectations exactly. This catches a server that hit
   the five second connect timeout and silently made the tax smaller.
3. Uncached arms show zero cache read AND zero cache creation. The outcome is
   asserted. The environment variable is not trusted to have fired.
4. Cached arms show a cache read above zero.
5. No arm used the one hour cache bucket. One hour exists in only one billing state,
   so a one hour number is not reproducible by a reader on another credential.

Version drift is recorded too. Apify moved every one of its tool sizes between two
releases, by up to 5.4 percent on one tool. Without the SDK manifest version and
each server's reported version, week over week numbers mean nothing.

## What this does not measure

- **Dollars.** There is no server-side usage API for an individual account, so any
  cost figure would be a client-side estimate from a bundled price table. Tokens are
  reported. Money is not.
- **Fidelity.** The typed surface arm B reads loses some schema detail: recursive
  `$ref` collapses, and `not` and `if`/`then`/`else` are dropped. Part of any code
  mode saving is lost detail, not free compression. The report says so in its own
  `disclosure` field.
- **Security.** The Node worker arm B runs programs in is an isolation boundary for
  measurement. It is not a security boundary against hostile code. The browser
  sandbox used by the demo page is the strong one.

Grading is deterministic substring matching against `expect.mustMention` in each
`task.json`. It is dumb on purpose. A model grading a model would put the thing
under test inside the measurement. A cheaper arm that fails its task is not cheaper.
