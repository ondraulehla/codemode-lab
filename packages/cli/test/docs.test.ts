import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listTasks } from '../src/tasks.js'

/**
 * The documents must describe the repository that exists.
 *
 * On 2026-09-21 the task set was replaced, and five documents went on describing
 * the three retired tasks, a harness "not wired up yet" and billed counts that
 * "do not exist yet", next to a results file full of billed counts. Nothing failed,
 * because nothing checked. For a project whose argument is that its numbers can be
 * trusted, a stale document is the first thing a sceptical reader finds.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TASK_IDS = await listTasks(join(ROOT, 'tasks'))

/** Tasks that no longer exist. A document may name one only to say it was retired. */
const RETIRED = ['cross-repo-scan', 'single-call', 'sequential-pair']

/** Directories this check does not read: generated output, and quoted model output. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.astro', 'results'])

function files(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(path)
  }
  return out
}

const DOCS = files(ROOT, ['.md'])
const SOURCES = files(ROOT, ['.md', '.ts', '.mjs', '.js', '.json', '.yml'])

describe('documents name only tasks that exist', () => {
  it('finds the documents', () => {
    expect(DOCS.map((f) => relative(ROOT, f))).toEqual(
      expect.arrayContaining(['README.md', 'docs/methodology.md', 'tasks/README.md']),
    )
  })

  for (const file of DOCS) {
    it(relative(ROOT, file), () => {
      const text = readFileSync(file, 'utf8')

      // Every task a command or a path names must exist.
      const named = [
        ...text.matchAll(/\b(?:bin\.js run|codemode-lab run|lab run)\s+([a-z0-9-]+)/g),
        ...text.matchAll(/--tasks?\s+([a-z0-9,-]+)/g),
        ...text.matchAll(/\btasks\/([a-z0-9-]+)\//g),
      ].flatMap((m) => m[1].split(','))
      for (const id of named) {
        expect(TASK_IDS, `${relative(ROOT, file)} names task "${id}"`).toContain(id)
      }

      // A retired task may be named only on a line that says it was retired. A task
      // is named in code format; "single-call" in running prose is plain English.
      for (const line of text.split('\n')) {
        for (const id of RETIRED) {
          if (line.includes(`\`${id}\``)) {
            expect(line, `${relative(ROOT, file)} names ${id} as if it existed`).toMatch(/retired/i)
          }
        }
      }
    })
  }
})

// Built from its code point, so this file does not contain the character it bans.
const EM_DASH = String.fromCharCode(0x2014)

describe('the house style holds in every file that ships', () => {
  it('has no em dash anywhere', () => {
    // CONTRIBUTING.md: "No em dash anywhere." Results files are excluded: they
    // quote model output verbatim, and a quotation is not rewritten.
    const offenders = SOURCES.filter((f) => readFileSync(f, 'utf8').includes(EM_DASH)).map((f) =>
      relative(ROOT, f),
    )
    expect(offenders).toEqual([])
  })
})
