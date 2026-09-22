# Contributing

Thanks for looking. This project lives or dies on whether a sceptical reader
trusts its numbers, so the rules below are about measurement first and code
second.

## The one rule

**Do not add a number you did not measure.**

If you cannot paste the command and its output, the number does not go in. That
applies to the README, to the docs, to code comments and to commit messages.

## Build and run

<!-- readme-ci skip -->

```bash
npm install
npx tsc --build
node packages/cli/dist/bin.js scan deepwiki
```

`npx tsc --build` must stay green. It builds every package.

Format before you commit:

<!-- readme-ci skip -->

```bash
npm run fmt
```

## Measurement rules

These are not style preferences. Breaking one of them makes the project
worthless.

1. **Wire bytes are not context bytes.** SSE framing and JSON escaping roughly
   double the wire size. Use `textBytes` for anything about a context window.
   Label a wire figure as `wire`.
2. **Token figures are estimates.** Show a band of 2.4 to 3.8 bytes per token, from `BYTES_PER_TOKEN_BAND` in `packages/meter`.
   Never print one confident token number. Mark it as an estimate where it is
   displayed, not only in a footnote.
3. **Billed tokens stay in their own column.** They come from the harness. Never
   average a billed number with an estimate.
4. **Dollars are list-price equivalents, and say so.** `harness/prices.mjs` turns
   billed tokens into dollars at published prices. No figure is a cost somebody
   paid, and no page may present one as that.
5. **One module counts bytes.** `packages/meter`. If you need a size somewhere
   else, import it. Name units correctly: 1 KiB is 1,024 bytes. One label for two
   quantities is how a published ratio went wrong here.
6. **Print the probe arguments next to the result.** A generic query flatters a
   server by three orders of magnitude. The reader has to be able to judge the
   call.
7. **Never call a tool that spends someone's money.** `planProbes` skips tools
   whose name starts with a verb like `ask`, `generate` or `create`, and tools
   with `readOnlyHint: false`. Keep it that way.
8. **Date every table.** Live servers drift. A table without a measurement date
   is a claim without evidence.

## Adding a task

A task is one question asked two ways. It lives in `tasks/<id>/`:

```
task.json     the question, the allowed servers and tools, the prediction
program.js    the code mode arm, in a real file
```

Two things matter.

**Write the prediction first.** `expectCodeModeWins` is recorded in `task.json`
before the run. Two of the five current tasks predict a loss, and one is recorded
as uncertain. If a losing task unexpectedly wins, correct the prediction and say
why. Do not delete the task.

**An arm added later needs its own prediction.** Name it in `extraArms`, say why in
`extraArmsWhy`, and write a dated prediction for it in `predictions` before it
first runs. A test fails the build otherwise.

**Losing tasks are welcome.** A set of tasks that code mode always wins is a
demo, not a measurement. If you find a shape where code mode loses on a public
server, that is the most valuable contribution you can make here.

**Programs live in `.js` files, never in a template literal.** A `\b` inside a
JavaScript template literal is a backspace character, so a regex embedded that
way silently stops matching while the run still reports success. This repo found
that bug the expensive way.

## Adding a server

Add it to `packages/mcp-client/src/servers.ts` with every field measured, not
read off a README:

- `session`: does a bare `tools/list` POST work, or does it need `initialize`?
- `corsOpen`: does an OPTIONS preflight from a real origin return
  `access-control-allow-origin`? A session server also needs
  `access-control-expose-headers: mcp-session-id` or no page can use it.
- `toolsListBytes` and `toolCount`: from a `curl` POST.
- `probeHints`: realistic arguments per tool, written by hand.

Put the commands you ran in the pull request.

A server that needs a credential never appears in a public page. A token in a
public page is a token you have given away.

## Code style

- TypeScript strict. No new runtime dependencies without a strong reason.
- Comments explain **why**, not what. Match the density and voice of the file
  you are editing. No banner comments, no decorative separators.
- Write in Simplified Technical English: one word per idea, short sentences,
  active voice, short paragraphs.
- No em dash anywhere. Use an en dash with spaces around it, a comma, a colon,
  parentheses, or two sentences.
- No attribution to any AI tool in any file, commit message or document.

## Documentation

Fenced `bash` blocks in this repository's markdown are executed in CI by
[readme-ci](https://github.com/ondraulehla/readme-ci). A block that needs the
network, or takes more than a few seconds, must carry a skip directive on the
line above it:

```markdown
<!-- readme-ci skip -->
```

Blocks marked `text` are output samples and are never executed.

Two tests hold the documents to the repository. One fails when a markdown file names
a task that does not exist, in a command or in a `tasks/<id>/` path. The other fails
when any file that ships contains an em dash.

## Pull requests

Include:

- the command you ran and its real output
- the measurement date
- for a new claim, what it does not prove

A pull request that changes a number without a command to reproduce it will be
sent back, however right the number is.
