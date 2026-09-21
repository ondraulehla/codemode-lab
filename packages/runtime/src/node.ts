import { Worker } from 'node:worker_threads'
import { Bridge, type BridgeOptions } from './host.js'
import { GUEST_SOURCE, NODE_DENIED, egressDenial } from './guest.js'
import { READY } from './protocol.js'
import type { RunResult } from './protocol.js'

/**
 * Run a program in a Node worker thread.
 *
 * This is the sandbox the CLI and the CI harness use. Be honest about what it is:
 * a worker is an isolation boundary for globals and for crashes, not a security
 * boundary against hostile code. It is the right tool for measuring what a program
 * costs. It is the wrong tool for running a program you do not trust.
 *
 * The browser sandbox in this package is the stronger one, because an
 * opaque-origin iframe under `default-src 'none'` genuinely cannot reach the network.
 */
export async function runInNodeSandbox(code: string, opts: BridgeOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000

  // An ESM data URL, not `{ eval: true }`. Node evaluates an eval'd worker as
  // CommonJS, where `require` is not reliably present in every release, and the
  // failure ("require(...) is not a function") points at the wrong thing.
  const shim = `
import { parentPort } from 'node:worker_threads'
${GUEST_SOURCE}
${egressDenial(NODE_DENIED)}
globalThis.__cml.setSend(function (m) { parentPort.postMessage(m) })
parentPort.on('message', function (m) { globalThis.__cml.onHostMessage(m) })
parentPort.postMessage({ kind: 'log', level: 'log', text: '${READY}' })
`

  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(shim)}`), {
    stdout: true,
    stderr: true,
  })
  let bridge!: Bridge

  const done = new Promise<RunResult>((resolve) => {
    bridge = new Bridge({ ...opts, timeoutMs, internalLogs: [READY] }, (msg) =>
      worker.postMessage(msg),
    )
    void bridge.begin().then(resolve)
  })

  worker.on('message', (m) => bridge.handle(m))
  worker.on('error', (e) => bridge.fail(`worker error: ${e.message}`, 'bridge'))
  worker.on('exit', (codeNum) => {
    if (codeNum !== 0) bridge.fail(`worker exited with code ${codeNum}`, 'bridge')
  })

  // A worker that hangs past the guest's own timer is killed here. Two timers
  // because the inner one reports a clean 'timeout' and the outer one is the
  // backstop for a program that blocks the event loop and never sees its timer.
  const hardKill = setTimeout(() => {
    bridge.fail(`hard timeout after ${timeoutMs + 5_000}ms`, 'timeout')
    void worker.terminate()
  }, timeoutMs + 5_000)

  worker.postMessage({ kind: 'start', code, tools: bridge.toolIds, timeoutMs })

  try {
    return await done
  } finally {
    clearTimeout(hardKill)
    await worker.terminate()
  }
}
