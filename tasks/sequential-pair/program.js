// The code mode arm for sequential-pair.
//
// The dependency is real, so nothing runs in parallel. Both results are small, so
// there is nothing worth filtering. All the program does is move two calls one hop
// further from the model, which costs tokens to write and saves none.
//
// Read the last line carefully. It returns the WHOLE document, because the task
// asks for the documentation, and a program that returned a 300 character excerpt
// would post a flattering ratio by discarding the answer. That is the easiest way
// to fake a win in this kind of measurement, and this file exists to refuse it.
// A boundary ratio only means something when both arms answer the same question.
const resolved = await context7['resolve-library-id']({
  query: 'next.js app router',
  libraryName: 'next.js',
})

const match = resolved.match(/\/[a-z0-9._-]+\/[a-z0-9._-]+/i)
const libraryId = match ? match[0] : '/vercel/next.js'

return await context7['query-docs']({ libraryId, query: 'app router server actions' })
