/**
 * The bridge protocol between the host and the sandbox.
 *
 * Both sandboxes in this package (an iframe in the browser, a worker in Node)
 * speak exactly this. Keeping it in one file means the byte accounting is
 * identical in a page and in the CLI, so a number measured in one can be
 * compared against a number measured in the other.
 *
 * Direction is always named from the host's point of view.
 */

/** Host to sandbox: here is your program, run it. */
export interface StartMessage {
  kind: 'start'
  code: string
  /** Fully qualified tool ids the program may call, as `server.tool`. */
  tools: string[]
  timeoutMs: number
}

/** Sandbox to host: the program wants a tool call. */
export interface CallMessage {
  kind: 'call'
  id: number
  tool: string
  args: unknown
}

/** Host to sandbox: the answer to one call. */
export interface ResultMessage {
  kind: 'result'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

/** Sandbox to host: the program printed something. */
export interface LogMessage {
  kind: 'log'
  level: 'log' | 'warn' | 'error'
  text: string
}

/** Sandbox to host: the program finished, one way or the other. */
export interface DoneMessage {
  kind: 'done'
  ok: boolean
  value?: unknown
  error?: string
  /**
   * Stack trace with the sandbox's own source removed.
   *
   * The raw stack names the whole guest on every frame, because the program is
   * loaded from a data URL. It is unreadable, and it is what made string-matching
   * classification wrong.
   */
  stack?: string
  /**
   * The failure class, decided inside the sandbox where the cause is known.
   *
   * The host must not infer this from the message text. A tool that fails with
   * "server said 503" is a tool error, and nothing in that string says so.
   */
  failure?: FailureClass
}

export type HostToSandbox = StartMessage | ResultMessage
export type SandboxToHost = CallMessage | LogMessage | DoneMessage

/** What a completed program run looks like to the caller. */
export interface RunResult {
  ok: boolean
  /** Whatever the program returned. This is the ONLY thing that leaves the sandbox. */
  value?: unknown
  error?: string
  /** Stack trace with the sandbox's own source removed, when there was one. */
  stack?: string
  logs: { level: string; text: string }[]
  ms: number
  /**
   * Why the run ended, when it did not end well.
   *
   * Naming the class beats printing a stack trace: a page that fails visibly and
   * says which kind of failure it was is more credible than one that never fails.
   */
  failure?: FailureClass
}

export type FailureClass =
  'timeout' | 'syntax' | 'tool-error' | 'program-threw' | 'egress-denied' | 'bridge'

/**
 * The transport handshake line.
 *
 * Both sandboxes announce readiness with a log message, because a log is the one
 * channel that exists before the bridge is wired. It is filtered out of both the
 * log callback and `RunResult.logs`, so it never reads as program output.
 */
export const READY = '__cml_ready__'

/** A function the sandbox may call, plus the metering the host does around it. */
export type ToolImpl = (args: unknown) => Promise<unknown>
export type ToolTable = Record<string, ToolImpl>
