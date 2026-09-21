# The measured server table

Six public MCP servers, measured on 2026-09-21 with `curl` and with
`packages/mcp-client`. Nothing here was read off a README.

`packages/mcp-client/src/servers.ts` holds the same facts in code, and
`node packages/cli/dist/bin.js servers` prints them.

## Transport and access

| server          | URL                                   | mode       | CORS from `https://ulehla.dev` | auth   |
| --------------- | ------------------------------------- | ---------- | ------------------------------ | ------ |
| DeepWiki        | `https://mcp.deepwiki.com/mcp`        | stateless  | open (`*`)                     | none   |
| Context7        | `https://mcp.context7.com/mcp`        | stateless  | open (`*`)                     | none   |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | stateless  | open (`*`)                     | none   |
| GitMCP          | `https://gitmcp.io/docs`              | session    | open (`*`)                     | none   |
| Hugging Face    | `https://huggingface.co/mcp`          | session    | open (echoes the origin)       | none   |
| Apify           | `https://mcp.apify.com`               | stateless  | not usable from a page         | bearer |
| grep.app        | `https://mcp.grep.app`                | not tested | **no CORS headers at all**     | none   |

**Stateless** means a bare `tools/list` POST works with no handshake.
**Session** means the server needs `initialize` first, then an `Mcp-Session-Id`
header on every later request.

`McpClient.connect()` probes stateless first and falls back to `initialize`, so
a caller does not have to know which kind it is talking to.

## Three facts that break naive clients

**1. Everything answers as `text/event-stream`.**

Not only the servers that stream. DeepWiki, Context7 and Microsoft Learn all
reply with SSE framing for a single result. A client that reads
`Content-Type: application/json` and gives up on anything else sees nothing at
all, with no error.

<!-- readme-ci skip -->

```bash
curl -s -D - -o /dev/null -X POST https://mcp.deepwiki.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Measured 2026-09-21: `content-type: text/event-stream` on DeepWiki, Context7 and
Microsoft Learn. Hugging Face answers `initialize` with
`content-type: application/json`, so a client must handle both.

`packages/mcp-client/src/sse.ts` parses SSE incrementally and
`parseSseBody(body)` parses a whole body, so either shape works.

**2. A session server is only browser-usable if it exposes the session header.**

`Mcp-Session-Id` is a response header. A page cannot read a response header
unless the server lists it in `access-control-expose-headers`. GitMCP does:

```text
access-control-expose-headers: mcp-session-id
mcp-session-id: e5a72b21278e2ee04dc80cef084dc0d4e0b796ad503fce25af8cc09d05eb5f0d
```

A session server that omits that header works from Node and silently fails from
a browser. This is the single most common reason an MCP server "does not work in
the browser".

**3. No CORS headers means no browser client, whatever the server does.**

`https://mcp.grep.app` answers a preflight with `204` and no
`access-control-allow-origin`. A page cannot call it. This repo does not use it,
and lists it here so nobody spends an afternoon finding out.

## Definition sizes

The `tools/list` response body, measured with `curl` and `wc -c`.

| server          | tools | `tools/list` body | tools array JSON | typed surface |
| --------------- | ----: | ----------------: | ---------------: | ------------: |
| DeepWiki        |     3 |           1,583 B |          1,526 B |       1,157 B |
| Context7        |     2 |           4,927 B |          4,874 B |       3,016 B |
| Microsoft Learn |     3 |           4,950 B |          4,868 B |       2,806 B |

The three columns are different things. The first includes the JSON-RPC envelope
and the SSE frame. The second is what a client puts in a request. The third is
the generated TypeScript a code mode model reads. See
[methodology.md](methodology.md).

Total definition surface across the three keyless servers: 11,268 B of tools JSON,
roughly 3,000 to 3,500 estimated tokens, about 1.5% of a 200K window.

## Payload sizes

This is the column no other tool publishes.

| server          | tool                           | probe arguments                                              | text returned |        est. tokens |
| --------------- | ------------------------------ | ------------------------------------------------------------ | ------------: | -----------------: |
| DeepWiki        | `read_wiki_contents`           | `{ repoName: 'cloudflare/agents' }`                          |      683.7 kB | 184,250 to 212,167 |
| DeepWiki        | `read_wiki_structure`          | `{ repoName: 'cloudflare/agents' }`                          |        1.7 kB |         470 to 541 |
| Microsoft Learn | `microsoft_docs_search`        | `{ query: 'durable functions orchestration patterns' }`      |       23.6 kB |     6,365 to 7,329 |
| Microsoft Learn | `microsoft_code_sample_search` | `{ query: 'azure blob storage upload', language: 'python' }` |       10.3 kB |     2,777 to 3,198 |
| Microsoft Learn | `microsoft_docs_fetch`         | a Durable Functions overview URL                             |        2.2 kB |         601 to 692 |

`ask_question` on DeepWiki is never probed automatically. It spends the
provider's money, and `planProbes` refuses any tool whose name starts with a
verb like `ask`, `generate` or `create`.

DeepWiki `read_wiki_contents` across seven repositories ranges from 274.4 kB to
728.2 kB of text. The full table is in the README and in
[methodology.md](methodology.md).

## Why the arguments matter

A scanner that calls every tool with a generic string reports a flattering
number. Microsoft Learn returns 14 bytes for "getting started" and 23.6 kB for a
real question. Same tool, same server, three orders of magnitude apart.

So `servers.ts` carries hand-written `probeHints` per tool. A probe is only as
honest as its arguments, and this repo prints the arguments next to every
result so you can judge them.

## Apify

Apify needs a bearer token. It never appears in the browser demo, because a
token in a public page is a token you have given away. It runs in the CI arm
only, with the token from the environment.

Its own wiki, `apify/apify-mcp-server`, is the largest payload measured anywhere
in this project: 728.2 kB of text from one DeepWiki call, 98% to 113% of a 200K
window.

An unauthenticated `tools/list` POST to `https://mcp.apify.com` returns `401`.
