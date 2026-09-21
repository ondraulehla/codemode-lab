// One call, 1,030 bytes in, four short strings out.
//
// The cheapest task in the set, and the clearest loser. The payload is smaller than
// the program that filters it.
//
// Read the depth test carefully. An earlier version called any entry with no deeper
// neighbour a leaf, which also matched sub-entries and returned 17 titles instead of
// 4. The question now says TOP LEVEL, and this program tests for it.
const outline = await deepwiki.read_wiki_structure({ repoName: 'withastro/astro' })

const entries = outline
  .split('\n')
  .filter((l) => l.trimStart().startsWith('-'))
  .map((l) => {
    const raw = l.trimStart().slice(2).trim()
    const number = (raw.match(/^[0-9]+(\.[0-9]+)*/) ?? [''])[0]
    return {
      // Depth comes from the numbering, not from indentation. Indentation is easy
      // for a regenerated outline to change; the numbering carries the meaning.
      depth: number ? number.split('.').length : 0,
      title: raw.replace(/^[0-9]+(\.[0-9]+)*\s+/, '').trim(),
    }
  })

const leaves = entries
  .filter((e, i) => e.depth === 1 && (entries[i + 1]?.depth ?? 1) === 1)
  .map((e) => e.title)

console.log(
  `${entries.length} entries, ${entries.filter((e) => e.depth === 1).length} top level, ${leaves.length} leaves`,
)
return leaves
