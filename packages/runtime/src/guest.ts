/**
 * The code that runs INSIDE the sandbox.
 *
 * It is shipped as a string because it must be evaluated in a context that shares
 * nothing with the host: an opaque-origin iframe in the browser, a worker with the
 * network globals removed in Node. Importing it as a module would defeat that.
 *
 * Read it as the contract the model's program is held to. The program gets exactly
 * these globals and nothing else it can reach.
 */
export const GUEST_SOURCE = String.raw`
(function () {
  'use strict'

  var pending = new Map()
  var nextId = 1
  var send = null // set by the transport shim appended below

  function callTool(tool, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++
      pending.set(id, {
        resolve: resolve,
        reject: function (message) {
          // Marked here, where the truth is known. The host cannot tell a failed
          // tool from a failed program by reading the message, because the message
          // is whatever the server said.
          var e = new Error(message || 'tool call failed')
          e.__cmlToolError = true
          reject(e)
        },
      })
      send({ kind: 'call', id: id, tool: tool, args: args })
    })
  }

  function onHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.kind === 'result') {
      var p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(msg.error)
      return
    }
    if (msg.kind === 'start') run(msg)
  }

  // Console inside the sandbox is a channel to the host, not the real console.
  // The demo shows these lines next to the program, so a reader can watch it think.
  var sandboxConsole = {
    log: function () { send({ kind: 'log', level: 'log', text: fmt(arguments) }) },
    warn: function () { send({ kind: 'log', level: 'warn', text: fmt(arguments) }) },
    error: function () { send({ kind: 'log', level: 'error', text: fmt(arguments) }) },
  }

  /**
   * Strip the sandbox's own source out of a stack trace.
   *
   * In Node the program runs from a data: URL, so every frame names the entire
   * percent-encoded guest. That text contains the literal word SyntaxError, from
   * this file's own error path, and any host that classified failures by searching
   * the stack called every failure a syntax error. It did. That is why the class
   * is decided here and the stack is cleaned before it travels.
   */
  function cleanStack(e) {
    var stack = (e && e.stack) || ''
    return String(stack)
      .split('\n')
      .map(function (line) {
        var at = line.indexOf('data:text/javascript,')
        return at === -1 ? line : line.slice(0, at) + '<sandbox>'
      })
      .join('\n')
  }

  function fmt(args) {
    var out = []
    for (var i = 0; i < args.length; i++) {
      var a = args[i]
      if (typeof a === 'string') out.push(a)
      else {
        try { out.push(JSON.stringify(a)) } catch (e) { out.push(String(a)) }
      }
    }
    return out.join(' ')
  }

  /**
   * Build the typed namespaces the program calls.
   * 'deepwiki.read_wiki_contents' becomes deepwiki.read_wiki_contents(args).
   */
  function buildNamespaces(toolIds) {
    var ns = {}
    for (var i = 0; i < toolIds.length; i++) {
      var id = toolIds[i]
      var dot = id.indexOf('.')
      var server = dot === -1 ? 'tools' : id.slice(0, dot)
      var tool = dot === -1 ? id : id.slice(dot + 1)
      if (!ns[server]) ns[server] = {}
      ns[server][tool] = (function (fullId) {
        return function (args) { return callTool(fullId, args === undefined ? {} : args) }
      })(id)
    }
    return ns
  }

  function run(msg) {
    var ns = buildNamespaces(msg.tools || [])
    var names = Object.keys(ns)
    var values = names.map(function (n) { return ns[n] })

    var timer = setTimeout(function () {
      send({
        kind: 'done',
        ok: false,
        error: 'timeout after ' + msg.timeoutMs + 'ms',
        failure: 'timeout',
      })
    }, msg.timeoutMs)

    var fn
    try {
      // The program body is wrapped in an async function so top-level await works.
      // AsyncFunction is used rather than eval so the parameter list is explicit:
      // the program can see the tool namespaces and console, and nothing else by name.
      var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      // Reflect.construct, not 'new AsyncFunction.apply(...)': the latter parses as
      // new (AsyncFunction.apply)(...) and throws. The parameter list is explicit so
      // the program sees the tool namespaces and console by name, and nothing else.
      fn = Reflect.construct(AsyncFunction, names.concat(['console'], ['\n' + msg.code + '\n']))
    } catch (e) {
      clearTimeout(timer)
      send({ kind: 'done', ok: false, error: 'SyntaxError: ' + (e && e.message), failure: 'syntax' })
      return
    }

    Promise.resolve()
      .then(function () { return fn.apply(null, values.concat([sandboxConsole])) })
      .then(function (value) {
        clearTimeout(timer)
        send({ kind: 'done', ok: true, value: value })
      })
      .catch(function (e) {
        clearTimeout(timer)
        var message = (e && e.message) || String(e)
        var failure = 'program-threw'
        if (e && e.__cmlToolError) failure = 'tool-error'
        else if (message.indexOf('egress-denied') !== -1) failure = 'egress-denied'
        send({ kind: 'done', ok: false, error: message, stack: cleanStack(e), failure: failure })
      })
  }

  // Exposed for the transport shim that follows.
  globalThis.__cml = { onHostMessage: onHostMessage, setSend: function (f) { send = f } }
})()
`

/**
 * Globals the sandbox must not have.
 *
 * In the browser, CSP `default-src 'none'` already blocks every one of these at
 * the network layer, so this is defence in depth. In Node there is no CSP, so this
 * shim is the actual control, and its limit is documented rather than oversold:
 * a determined program in a Node worker is contained by the worker, not by this.
 *
 * The list differs per host. Overriding `navigator` in Node breaks runtime
 * internals, so each transport passes the names that make sense for it.
 */
export function egressDenial(names: string[]): string {
  return `
;(function () {
  var denied = ${JSON.stringify(names)}
  for (var i = 0; i < denied.length; i++) {
    try {
      Object.defineProperty(globalThis, denied[i], {
        configurable: false,
        get: function () {
          throw new Error('egress-denied: the sandbox has no network. Call a tool instead.')
        },
      })
    } catch (e) { /* already non-configurable, fine */ }
  }
})()
`
}

/** Network globals a browser sandbox must not reach. */
export const BROWSER_DENIED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
]

/** Network globals a Node worker must not reach. `navigator` is left alone on purpose. */
export const NODE_DENIED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']
