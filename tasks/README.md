# Tasks

Each task is one question asked two ways. The directory holds everything needed to
run both arms and to compare them honestly.

```
<task-id>/
  task.json     what is being asked, which servers and tools are allowed
  program.js    the code mode arm: a real program, in a real file
  expect.md     what a correct answer looks like, so a run can be graded
```

Programs live in their own files, never inside a template literal in a test. That
is not style. A `\b` inside a JavaScript template literal is a backspace character,
so a regex embedded that way silently stops matching and the run still reports
success. This repo found that bug the expensive way.

Three of these tasks exist to show code mode **losing**. That is deliberate. See
`single-call` and `sequential-pair`.

## The rule that keeps the ratio honest

A boundary ratio is only meaningful when both arms answer the same question.

A program can post any ratio you like by returning less. `sequential-pair` first
returned a 300 character excerpt of a document the task asked for in full. That
scored 17x. Returning the whole document, which is what the question wanted,
scores 1x. The second number is the true one.

So every program in this directory must return enough to answer its task. When you
add a task, ask one question before you trust its ratio: **could a reader answer
the question from what the program returned?** If not, the ratio is measuring how
much the program threw away, not what code mode saved.

This is the sharpest failure mode of volume-based comparison, including the
comparisons published by vendors. Volume is easy to measure and easy to game.
