/**
 * Read a sweep result and say what each arm ACTUALLY did.
 *
 *   node harness/explain.mjs [results/latest.json] [task-id]
 *
 * A row of token counts does not tell you whether an arm answered the question or
 * just restated it. This prints the tool calls it made, the programs it ran and the
 * answer it gave, so a human can judge. It exists because an automatic grade was
 * once worthless: both grading strings of an early task appeared in the question
 * itself, so an arm that called nothing at all still passed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.argv[2] ?? 'results/latest.json')
const only = process.argv[3]
const report = JSON.parse(readFileSync(file, 'utf8'))

const n = (x) => (x == null ? '-' : x.toLocaleString())

console.log(`\n${file}`)
console.log(
  `model ${report.model}, effort ${report.effort ?? '?'}, ${report.credential}, ` +
    `claude code ${report.versions?.claudeCode}, schema ${report.schemaVersion ?? 1}\n`,
)

for (const sweep of report.sweeps) {
  if (only && sweep.task !== only) continue
  if (sweep.error) {
    console.log(`${sweep.task}: FAILED ${sweep.error}\n`)
    continue
  }

  console.log('='.repeat(78))
  console.log(
    `TASK ${sweep.task}   rep ${sweep.rep}   expectCodeModeWins=${sweep.expectCodeModeWins}` +
      `${sweep.predictionUncertain ? ' (uncertain)' : ''}`,
  )
  console.log(`Q: ${sweep.question}`)
  if (sweep.definitionTax) {
    console.log(
      `definition tax (turn 1 over floor): direct ${n(sweep.definitionTax.direct)}, ` +
        `code mode ${n(sweep.definitionTax.codemode)} tokens`,
    )
    console.log(
      `all input over floor (NOT the definition tax): direct ${n(sweep.extraInputOverFloor?.direct)}, ` +
        `code mode ${n(sweep.extraInputOverFloor?.codemode)} tokens`,
    )
  } else if (sweep.toolTax) {
    // Schema 1 called this number the tool tax. It is all input over the floor.
    console.log(
      `all input over floor (schema 1 called it "tool tax"): direct ${n(sweep.toolTax.direct)}, ` +
        `code mode ${n(sweep.toolTax.codemode)} tokens`,
    )
  }
  if (sweep.memoryControl?.pass) {
    console.log('WARNING: the floor arm, which has no tools, answered correctly.')
  }
  console.log('='.repeat(78))

  for (const arm of sweep.arms) {
    if (!arm.ok) {
      console.log(`\n--- ${arm.arm}: DISCARDED, ${arm.discarded}`)
      continue
    }

    const u = arm.usage
    console.log(
      `\n--- ${arm.arm}   in=${n(u.input)} out=${n(u.output)} cacheR=${n(u.cacheRead)} ` +
        `cacheW=${n(u.cacheCreation)} ${Math.round(arm.ms / 1000)}s   outcome=${u.outcome ?? 'completed'}` +
        `${arm.answerClass ? `   answer=${arm.answerClass}` : ''}`,
    )
    console.log(`    tools loaded: ${(arm.tools ?? []).length ? arm.tools.join(', ') : '(none)'}`)
    if (arm.turns) {
      const calls = Object.entries(arm.turns.toolCalls ?? {})
        .map(([k, v]) => `${k} x${v}`)
        .join(', ')
      console.log(
        `    turns ${arm.turns.turns}, first request ${n(arm.turns.turn1Prompt)}, ` +
          `peak ${n(arm.turns.peakPrompt)} tokens, spilled results ${arm.turns.spilledResults}` +
          `${calls ? `, calls: ${calls}` : ''}`,
      )
    }
    if (arm.permissionDenials?.length) {
      console.log(`    denied: ${arm.permissionDenials.join(', ')}`)
    }

    if (arm.boundary) {
      const b = arm.boundary
      console.log(
        `    sandbox: ${n(b.in)} B in, ${n(b.toModel ?? b.returned)} B to the model, ` +
          `${b.calls} tool calls${b.uniqueCalls != null ? ` (${b.uniqueCalls} distinct)` : ''}, ` +
          `${b.programs} program(s)${b.failedPrograms ? `, ${b.failedPrograms} failed` : ''}`,
      )
      for (const [i, p] of (b.programLog ?? []).entries()) {
        console.log(
          `    program ${i + 1}: ${p.ok ? 'ok' : `FAILED (${p.failure})`}, ${p.calls} call(s), ${p.ms} ms` +
            `${p.error ? `: ${p.error.split('\n')[0]}` : ''}`,
        )
      }
    }

    if (arm.grade?.graded) {
      console.log(
        `    auto grade: ${arm.grade.pass ? 'PASS' : 'FAIL'}${arm.grade.missing?.length ? ` missing ${arm.grade.missing.join(', ')}` : ''}`,
      )
    }

    // The answer itself. This is the part a human has to read, because no
    // substring check can tell a real answer from a restated question.
    const text = (arm.answer ?? (arm.transcript ?? []).map((t) => t.text).join('\n\n')).trim()
    if (!text) {
      console.log('    ANSWER: (the arm produced no assistant text)')
      continue
    }
    console.log('    ANSWER:')
    for (const line of text.split('\n')) console.log(`      ${line}`)
  }
  console.log()
}

/**
 * The question every reader should ask of the rows above.
 *
 * An arm whose input tokens are small did not read a large payload into its
 * window. On the large tasks that is expected for code mode, and for a direct arm
 * it means the result went to a file instead.
 */
console.log(
  'Reminder: one read_wiki_contents result is 274 KiB to 728 KiB of text, about 74,000 to\n' +
    '226,000 tokens. A direct arm with a few thousand input tokens did not read one into\n' +
    'its window, whatever its grade says. Check "spilled results" above.\n',
)
