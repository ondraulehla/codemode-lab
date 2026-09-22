// Three dumps, 1,393,773 bytes (1.33 MiB) in, about 300 bytes out.
//
// The three payloads are fetched concurrently and scanned inside the sandbox. None
// of them ever reaches the model.
const repos = ['cloudflare/agents', 'e2b-dev/E2B', 'nodejs/undici']

const results = await Promise.all(
  repos.map(async (repo) => {
    const dump = await deepwiki.read_wiki_contents({ repoName: repo })
    const pages = dump.split(/^# Page: /m).slice(1)
    let best = null

    for (const page of pages) {
      const title = page.split('\n', 1)[0].trim()
      const lines = page.split('\n')
      const rows = lines.filter((l) => l.startsWith('|'))
      if (!best || rows.length > best.rows) {
        best = { title, rows: rows.length, evidence: rows[0] ?? null }
      }
    }

    // A dump with no page markers means the format changed. Fail loudly: a quiet
    // null would read as an answer.
    if (!best) throw new Error(`${repo}: no '# Page:' markers in ${dump.length} chars`)

    console.log(`${repo}: ${dump.length} chars, ${pages.length} pages, top page ${best.rows} rows`)
    return { repo, ...best }
  }),
)

return results
