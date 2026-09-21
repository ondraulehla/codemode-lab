// The code mode arm for single-call.
//
// This is the honest worst case. There is one call, the result is 1.1 kB, and the
// program adds a round trip plus the tokens to write it. Direct tool calling wins,
// and the page says so.
return await deepwiki.read_wiki_structure({ repoName: 'withastro/astro' })
