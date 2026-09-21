import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** One question, asked two ways. See tasks/README.md. */
export interface TaskDef {
  id: string
  title: string
  question: string
  /** server id -> tool names the arms may use. Nothing else is reachable. */
  servers: Record<string, string[]>
  /** Why this task is in the set. Losing tasks say so here. */
  why: string
  /**
   * The honest prediction, recorded before the run.
   *
   * Writing the expectation down first is what separates a measurement from a
   * demo. Three tasks in this repo predict a code mode LOSS, and if one of them
   * unexpectedly wins, that is a finding, not a bug to hide.
   */
  expectCodeModeWins: boolean
  timeoutMs?: number
}

export interface LoadedTask extends TaskDef {
  /** Contents of program.js, the code mode arm. */
  program: string
  dir: string
}

export async function loadTask(tasksDir: string, id: string): Promise<LoadedTask> {
  const dir = join(tasksDir, id)
  const def = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as TaskDef
  const program = await readFile(join(dir, 'program.js'), 'utf8')
  return { ...def, program, dir }
}

export async function listTasks(tasksDir: string): Promise<string[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}
