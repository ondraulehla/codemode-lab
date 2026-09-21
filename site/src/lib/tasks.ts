import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Load the real task definitions and the real programs from `tasks/`.
 *
 * The page renders the same files the CLI runs. Nothing here is a copy, because a
 * copy drifts, and a demo that shows code the runner does not execute is a lie
 * that takes one commit to become true.
 *
 * Server side only. This module must never be imported from a browser script.
 */

export interface TaskDefinition {
  id: string
  title: string
  question: string
  servers: Record<string, string[]>
  why: string
  expectCodeModeWins: boolean
  timeoutMs: number
}

export interface LoadedTask extends TaskDefinition {
  /** The program body, exactly as it sits on disk. */
  program: string
  programBytes: number
}

/**
 * Find the repo root.
 *
 * `import.meta.url` is right when Vite keeps this module in place, and the walk up
 * from the working directory covers the case where a bundler moved it. One of the
 * two always holds, and failing loudly at build time beats shipping an empty page.
 */
function repoRoot(): string {
  const fromHere = fileURLToPath(new URL('../../..', import.meta.url))
  if (existsSync(join(fromHere, 'tasks'))) return fromHere

  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'tasks', 'cross-repo-scan', 'task.json'))) return dir
    dir = dirname(dir)
  }
  throw new Error('cannot find the tasks directory from ' + fromHere + ' or ' + process.cwd())
}

export function loadTask(id: string): LoadedTask {
  const dir = join(repoRoot(), 'tasks', id)
  const definition = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as TaskDefinition
  const program = readFileSync(join(dir, 'program.js'), 'utf8')
  return {
    ...definition,
    program,
    programBytes: Buffer.byteLength(program, 'utf8'),
  }
}
