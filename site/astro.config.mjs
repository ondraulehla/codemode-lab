// @ts-check
import { defineConfig } from 'astro/config'

// Static output. The page makes every measurement in the visitor's own browser,
// so there is nothing for a server to do and nothing to pay for.
export default defineConfig({
  output: 'static',
  devToolbar: { enabled: false },
  build: { inlineStylesheets: 'auto' },
  vite: {
    // The task programs and the workspace packages live above this directory.
    server: { fs: { allow: ['..'] } },
  },
})
