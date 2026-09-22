import { Bridge, type BridgeOptions } from './host.js'
import { GUEST_SOURCE, BROWSER_DENIED, egressDenial } from './guest.js'
import { READY } from './protocol.js'
import type { RunResult } from './protocol.js'

/**
 * Run a program in an opaque-origin iframe.
 *
 * This is the sandbox for a page, and it is the strong one. The project page used
 * it until 2026-09-21, and now replays a recording instead. Two independent
 * controls hold it:
 *
 *  1. `sandbox="allow-scripts"` WITHOUT `allow-same-origin`. The frame gets an
 *     opaque origin, so it cannot touch the page's DOM, storage or cookies, and
 *     `postMessage` from it arrives with origin "null".
 *  2. A CSP of `default-src 'none'` in the frame document. No network, at all.
 *     The program cannot fetch, cannot load a script, cannot open a socket.
 *
 * Everything the program is allowed to do arrives as a function over the bridge.
 * That is the whole security story, and it is short enough to check by reading it.
 */
export async function runInIframeSandbox(
  code: string,
  opts: BridgeOptions & { mount?: HTMLElement },
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000

  // 'unsafe-eval' is required, not sloppy. The guest compiles the program with the
  // AsyncFunction constructor, which CSP treats as evaluating a string, so without
  // it EVERY run fails instantly with an EvalError. It does not weaken the sandbox:
  // `default-src 'none'` still blocks all network and the opaque origin still holds.
  // All it permits is compiling a string the host itself just handed in.
  //
  // One more thing the caller must know: a srcdoc frame INHERITS the embedding
  // document's policy. If the page that embeds this sets a `script-src` without
  // 'unsafe-eval', the frame's own permissive policy cannot rescue it and the run
  // still fails. See the package README.
  const html = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">
<script>
${GUEST_SOURCE}
${egressDenial(BROWSER_DENIED)}
globalThis.__cml.setSend(function (m) { parent.postMessage(m, '*') })
addEventListener('message', function (e) { globalThis.__cml.onHostMessage(e.data) })
parent.postMessage({ kind: 'log', level: 'log', text: '${READY}' }, '*')
<\/script>`

  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.style.display = 'none'
  frame.srcdoc = html

  let bridge!: Bridge
  let ready = false

  const done = new Promise<RunResult>((resolve) => {
    bridge = new Bridge({ ...opts, timeoutMs, internalLogs: [READY] }, (msg) =>
      frame.contentWindow?.postMessage(msg, '*'),
    )
    void bridge.begin().then(resolve)
  })

  const onMessage = (e: MessageEvent) => {
    // The frame has an opaque origin, so `e.origin` is the string "null".
    // Identity comes from the source window, which cannot be forged by another frame.
    if (e.source !== frame.contentWindow) return
    const data = e.data as { kind?: string; text?: string }
    if (!data || typeof data.kind !== 'string') return

    if (!ready && data.kind === 'log' && data.text === READY) {
      ready = true
      frame.contentWindow?.postMessage(
        { kind: 'start', code, tools: bridge.toolIds, timeoutMs },
        '*',
      )
      return
    }
    bridge.handle(data as never)
  }

  addEventListener('message', onMessage)
  ;(opts.mount ?? document.body).appendChild(frame)

  const hardKill = setTimeout(() => {
    bridge.fail(`hard timeout after ${timeoutMs + 5_000}ms`, 'timeout')
  }, timeoutMs + 5_000)

  try {
    return await done
  } finally {
    clearTimeout(hardKill)
    removeEventListener('message', onMessage)
    frame.remove()
  }
}
