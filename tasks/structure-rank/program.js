// Four calls, 4.5 kB in, about 90 bytes out.
//
// This task is here to LOSE. Every payload fits any context window, so there is
// nothing worth filtering, and the program only adds a round trip and JSON quoting.
const repos = ['apify/apify-mcp-server', 'cloudflare/agents', 'nodejs/undici', 'withastro/astro']

const counts = await Promise.all(
  repos.map(async (repo) => {
    const outline = await deepwiki.read_wiki_structure({ repoName: repo })
    const entries = outline.split('\n').filter((l) => l.trimStart().startsWith('-'))
    console.log(`${repo}: ${entries.length} entries`)
    return { repo, entries: entries.length }
  }),
)

return counts
  .sort((a, b) => b.entries - a.entries)
  .map((c) => c.repo)
  .join(' > ')
