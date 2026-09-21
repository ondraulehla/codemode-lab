// Seven outlines, 9.2 kB in total. Small payloads, so this one is not about size.
//
// What it tests is whether one program beats seven round trips when the work is a
// set intersection. The prediction for this task is recorded as uncertain.
const repos = [
  'apify/apify-mcp-server',
  'cloudflare/agents',
  'e2b-dev/E2B',
  'modelcontextprotocol/servers',
  'nodejs/undici',
  'vercel/ai',
  'withastro/astro',
]

const seen = new Map()

await Promise.all(
  repos.map(async (repo) => {
    const outline = await deepwiki.read_wiki_structure({ repoName: repo })
    // Entries look like "- 3.1 Build System and Pipeline Architecture". Drop the
    // dash and the number, keep the title.
    const titles = outline
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) =>
        l
          .slice(2)
          .replace(/^[0-9]+(\.[0-9]+)*\s+/, '')
          .trim(),
      )
      .filter(Boolean)

    console.log(`${repo}: ${titles.length} titles`)
    for (const t of new Set(titles)) {
      if (!seen.has(t)) seen.set(t, [])
      seen.get(t).push(repo)
    }
  }),
)

return [...seen.entries()]
  .filter(([, owners]) => owners.length >= 2)
  .map(([title, owners]) => ({ title, count: owners.length, repos: owners.sort() }))
  .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
