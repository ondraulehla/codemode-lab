/**
 * Read a sweep result and say what each arm ACTUALLY did.
 *
 *   node harness/explain.mjs [results/latest.json] [task-id]
 *
 * A row of token counts does not tell you whether an arm answered the question or
 * just restated it. This prints the tool calls it made and the answer it gave, so
 * a human can judge. It exists because the automatic grade on cross-repo-scan was
 * worthless: both of its `mustMention` strings appear in the question itself, so an
 * arm that called nothing at all still passed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.argv[2] ?? 'results/latest.json')
const only = process.argv[3]
const report = JSON.parse(readFileSync(file, 'utf8'))

const n = (x) => (x ?? 0).toLocaleString()

console.log(`\n${file}`)
console.log(
  `model ${report.model}, ${report.credential}, claude code ${report.versions?.claudeCode}\n`,
)

for (const sweep of report.sweeps) {
  if (only && sweep.task !== only) continue
  if (sweep.error) {
    console.log(`${sweep.task}: FAILED ${sweep.error}\n`)
    continue
  }

  console.log('='.repeat(78))
  console.log(`TASK ${sweep.task}   expectCodeModeWins=${sweep.expectCodeModeWins}`)
  console.log(`Q: ${sweep.question}`)
  console.log(
    `tool tax: direct ${n(sweep.toolTax?.direct)} tokens, code mode ${n(sweep.toolTax?.codemode)} tokens`,
  )
  console.log('='.repeat(78))

  for (const arm of sweep.arms) {
    if (!arm.ok) {
      console.log(`\n--- ${arm.arm}: DISCARDED, ${arm.discarded}`)
      continue
    }

    const u = arm.usage
    console.log(
      `\n--- ${arm.arm}   in=${n(u.input)} out=${n(u.output)} cacheR=${n(u.cacheRead)} ` +
        `${Math.round(arm.ms / 1000)}s   outcome=${u.outcome ?? 'completed'}`,
    )
    console.log(`    tools loaded: ${(arm.tools ?? []).length ? arm.tools.join(', ') : '(none)'}`)

    if (arm.boundary) {
      console.log(
        `    sandbox: ${n(arm.boundary.in)} B in, ${n(arm.boundary.returned)} B returned, ` +
          `${arm.boundary.calls} tool calls, ${arm.boundary.programs} program(s)`,
      )
    }

    if (arm.grade?.graded) {
      console.log(
        `    auto grade: ${arm.grade.pass ? 'PASS' : 'FAIL'}${arm.grade.missing?.length ? ` missing ${arm.grade.missing.join(', ')}` : ''}`,
      )
    }

    // The answer itself. This is the part a human has to read, because no
    // substring check can tell a real answer from a restated question.
    const text = (arm.transcript ?? [])
      .map((t) => t.text)
      .join('\n\n')
      .trim()
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
 * An arm whose input tokens are small did not read a large payload. On
 * cross-repo-scan one read_wiki_contents call is about 184,000 tokens, so any arm
 * under about 10,000 tokens never fetched a wiki, whatever its grade says.
 */
console.log(
  'Reminder: on cross-repo-scan one read_wiki_contents result is about 184,000 tokens.\n' +
    'An arm with a few thousand input tokens did not read one, whatever its grade says.\n',
)
