# Test fixtures

Real bytes from a real server. Nothing here is hand written.

The suite parses these files instead of calling a network, so the default test run
is offline and deterministic. Tests that do call a live server are marked
`describe.skipIf(!process.env.LIVE)`.

## How the captures were made

Captured on 2026-09-21 with curl:

```sh
curl -s -D deepwiki-tools-list.headers.txt -X POST https://mcp.deepwiki.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  -o deepwiki-tools-list.sse

curl -s -X POST https://mcp.deepwiki.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_wiki_structure","arguments":{"repoName":"nodejs/undici"}}}' \
  -o deepwiki-read-wiki-structure.sse
```

## What each file shows

| File                               | Bytes | Why it is here                                                                                       |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `deepwiki-tools-list.sse`          | 1,586 | The definition tax for three tools, and the `anyOf` on `repoName` that typegen must not collapse.    |
| `deepwiki-tools-list.headers.txt`  | 164   | Proof that a single JSON-RPC result arrives as `text/event-stream`. A JSON-only client sees nothing. |
| `deepwiki-read-wiki-structure.sse` | 1,251 | A small tool result, so the wire bytes and the text bytes can be compared.                           |

Both stream files use CRLF line endings, which is what the server sends. Keep them
that way. The parser tests split these bytes at every boundary, and a rewritten
line ending would remove the case that matters.
