# site

The demo page. A visitor presses Run, and two arms race against live public MCP
servers from the visitor's own browser. No model runs. No API key. No backend.

- **Arm A, direct tool calling.** Each result lands in a context window meter.
  One DeepWiki payload fills a 200K window, so the arm stops and says so.
- **Arm B, code mode.** The real program from `tasks/<id>/program.js` runs in an
  iframe sandbox. The payloads land inside it. One small value comes out.

Both arms use the workspace packages directly: `@codemode-lab/mcp-client` for the
transport, `@codemode-lab/meter` for the byte counts, `@codemode-lab/runtime` for
the bridge and the sandbox guest, and `@codemode-lab/typegen` for the typed
surface panel.

## Run it

```sh
npm install          # from the repo root, once
cd site
npx astro dev        # http://localhost:4321
npx astro build      # static output in site/dist
```

The page calls `mcp.deepwiki.com` and `mcp.context7.com` from the browser. Both
send permissive CORS headers, so no proxy is needed. A warm run of the headline
task takes about 10 seconds. A repository DeepWiki has not built yet can take two
minutes or more, and the page shows a running clock the whole time.

## Deploy

Cloudflare Pages, static.

| setting        | value                            |
| -------------- | -------------------------------- |
| build command  | `npm run build --workspace=site` |
| build output   | `site/dist`                      |
| root directory | repo root                        |
| node version   | 20 or later                      |

`public/_headers` ships with the build and Cloudflare Pages applies it. Note that
`vercel.json` is not read by Pages, so `_headers` is the only place these belong.

## Why the page CSP allows `unsafe-eval`

The sandbox is an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`, under a frame policy of `default-src 'none'`. It has an
opaque origin and no network at all. The guest builds the visitor's program with
the AsyncFunction constructor, which CSP blocks unless `'unsafe-eval'` is present.

A `srcdoc` frame inherits the parent document's policy, so **both** policies have
to allow it: the frame's own `<meta>` policy and the `script-src` in
`public/_headers`. Without that the run fails with a `syntax` failure class and
this message:

```
EvalError: Evaluating a string as JavaScript violates the following Content
Security Policy directive because 'unsafe-eval' is not an allowed source of
script: script-src 'unsafe-inline'
```

`'unsafe-eval'` lets the frame compile a string it was handed. It does not let it
fetch one. `default-src 'none'` still stands.

## What lives where

```
src/client/     browser code: the run engine, the views, the iframe transport
src/components/ Arm, WindowMeter, Estimate
src/data/       measured byte counts, plus captured tools/list for three servers
src/lib/        token band arithmetic, task loading from ../tasks
src/pages/      the page itself
public/_headers Cloudflare Pages headers, including the CSP above
```

`src/lib/tasks.ts` reads `tasks/<id>/task.json` and `tasks/<id>/program.js` from
the repo at build time. The page shows the same files the CLI runs, so the two
cannot drift. The direct arm for `cross-repo-scan` reads its repository list out
of the program for the same reason.

## The honesty rules this page follows

1. Byte counts are measured. Token counts are estimated from bytes at 3.3 to 3.8
   bytes per token, always shown as a band, always next to an `est` marker.
2. Context figures use **text** bytes, never wire bytes. A wire count includes SSE
   framing and JSON escaping and runs about twice the text count.
3. While a payload is still arriving only the wire count exists. The bar divides
   it by two and draws that part hatched until the exact text count replaces it.
4. The page measures volume. It does not measure answer quality or money, and it
   says so in its own panel.
