// The code mode arm for cross-repo-scan.
//
// Note what this does that a sequence of tool calls cannot: it fetches four
// payloads concurrently, scans each one, and returns four short rows. The four
// wiki dumps total about 1.7 MB and never leave the sandbox.
const repos = ['cloudflare/agents', 'e2b-dev/E2B', 'modelcontextprotocol/servers', 'nodejs/undici']

const needle = /\bWebSockets?\b/

const results = await Promise.all(
  repos.map(async (repo) => {
    const wiki = await deepwiki.read_wiki_contents({ repoName: repo })
    const lines = wiki.split('\n')
    const hits = lines.filter((l) => needle.test(l))
    console.log(`${repo}: ${wiki.length} chars scanned, ${hits.length} hits`)
    return {
      repo,
      charsScanned: wiki.length,
      mentions: hits.length,
      evidence: hits.length ? hits[0].trim().slice(0, 140) : null,
    }
  }),
)

return results
