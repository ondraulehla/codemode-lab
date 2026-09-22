# Tasks

Each task is one question asked two ways. The directory holds everything needed to
run both arms and to compare them honestly.

```
<task-id>/
  task.json     what is asked, which tools are allowed, and how it is graded
  program.js    the code mode arm's reference program, in a real file
```

## The set

| task               | calls |  payload in | answer out | prediction      |
| ------------------ | ----: | ----------: | ---------: | --------------- |
| `table-heavy-page` |     3 | 1,393,773 B |      371 B | code mode wins  |
| `one-big-payload`  |     1 |   392,601 B |       98 B | code mode wins  |
| `topic-overlap`    |     7 |     9,226 B |    1,101 B | **uncertain**   |
| `structure-rank`   |     4 |     4,457 B |       90 B | code mode loses |
| `outline-leaves`   |     1 |     1,030 B |       66 B | code mode loses |

Measured on 2026-09-21 by running each reference program against the live server.
Every answer was checked against a ground truth computed independently with curl.

`topic-overlap` is recorded as **uncertain** on purpose. Its payloads are small, so
the payload argument does not apply, and what is left is seven round trips against
one program. Pre-registering an honest "I do not know" is worth more than a
confident prediction quietly corrected after the run.

## Why these five

The first task set had one question, and it was broken four ways. Every rule below
is a scar from it.

**A question must not be answerable from memory.** The first one asked whether four
repositories document a WebSocket API. A strong model already knows that undici
ships a `WebSocket` class. It could answer correctly having called no tool at all,
so the benchmark measured recall, not data access. Every task here is graded on a
string that DeepWiki invented, not on repository text, and each one was checked with
GitHub code search to confirm it returns zero hits inside its own repo.

**A grading string must not appear in its own question.** The first set graded on
two repository names that the question itself listed, so restating the question
passed. `packages/cli/test/tasks.test.ts` now fails the build if that ever recurs.

**Two arms must have the same tools.** The direct arm used to load every tool a
server offered while the code mode arm was narrowed to what the task declared. The
comparison was rigged, and not in the direction anyone assumed.

**The set must separate its variables.** In the old set, payload size and fan-out
moved together, so no result could say which one decided the outcome.
`one-big-payload` is one call with a huge payload. `structure-rank` is four calls
with tiny ones. They pull the two terms apart.

## The rule that keeps the ratio honest

A boundary ratio is only meaningful when both arms answer the same question.

A program can post any ratio you like by returning less. An earlier task returned a
300 character excerpt of a document it had been asked for in full and scored 17x.
Returning the whole document scored 1x. The second number is the true one.

So every program here must return enough to answer its task. When you add a task,
ask one question before you trust its ratio: **could a reader answer the question
from what the program returned?** If not, the ratio measures how much the program
threw away.

**And a high ratio does not mean code mode wins.** `structure-rank` posts 57x and is
still predicted to lose. It moves 4,457 bytes, so 57x saves about 1,100 tokens,
while writing the program costs more than that in output. When the absolute numbers
are small the ratio is a red herring. This is the trap in every volume comparison,
including the published ones.

## Arms added later, and their predictions

The two large tasks name two more arms in `extraArms`: `A-files`, a direct arm that
can Read and Grep the file Claude Code writes an oversized result to, and `A-raw`, a
direct arm whose output limit is raised so the result lands in the window. They were
added on 2026-09-22, after the first sweep showed that the direct arm never saw the
data on those tasks.

Adding an arm after a run is where a benchmark starts to bend towards its answer.
So each added arm comes with a prediction in `predictions`, dated, and written
before the arm first ran. A test fails the build if an added arm has no prediction.

## Every program type-checks against the surface

A typegen test compiles every reference program against the typed surface a model
would read for its task. The programs are the ground truth for what the sandbox
hands over. On 2026-09-22 this check caught two things: the surface promised
DeepWiki returns `{ result: string }` when the program gets a string, and
`table-heavy-page` read a field of a value that is null when a dump has no page
markers. Both programs now fail loudly on such a dump instead of returning a null
that would read as an answer.

## Programs live in files

Never paste a program into a template literal. A `\b` inside one is a backspace
character, so a regex written that way silently stops matching and the run still
reports success. This repo found that the expensive way.
