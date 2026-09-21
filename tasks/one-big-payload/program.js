// One call, 392 kB in, about 80 bytes out.
//
// There is nothing to parallelise and nothing to loop over. If code mode wins here
// it wins on payload size alone, which is why this task is in the set.
const dump = await deepwiki.read_wiki_contents({ repoName: 'modelcontextprotocol/servers' })

const pages = dump.split(/^# Page: /m).slice(1)
let best = null

for (const page of pages) {
  const title = page.split('\n', 1)[0].trim()
  // A mermaid fence opens a diagram, not code, and the question excludes it. Each
  // block has an opening and a closing fence, hence the halving.
  const fences = (page.match(/^```/gm) ?? []).length
  const mermaid = (page.match(/^```mermaid/gm) ?? []).length
  const blocks = (fences - 2 * mermaid) / 2
  if (!best || blocks > best.blocks) {
    const heading = page.split('\n').find((l) => l.startsWith('## ')) ?? null
    best = { title, blocks, heading }
  }
}

console.log(`${pages.length} pages scanned, ${dump.length} chars`)
return best
