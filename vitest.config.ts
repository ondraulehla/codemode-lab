import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url))

/**
 * The suite runs against `src`, not `dist`.
 *
 * A stale `dist` would let a broken change pass, and this repo sells its numbers.
 * The aliases are ordered: the `/node` and `/browser` subpaths must match before
 * the bare package name, because Vite compares the prefixes in order.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@codemode-lab/runtime/node', replacement: src('runtime/src/node.ts') },
      { find: '@codemode-lab/runtime/browser', replacement: src('runtime/src/browser.ts') },
      { find: '@codemode-lab/runtime', replacement: src('runtime/src/index.ts') },
      { find: '@codemode-lab/mcp-client', replacement: src('mcp-client/src/index.ts') },
      { find: '@codemode-lab/meter', replacement: src('meter/src/index.ts') },
      { find: '@codemode-lab/typegen', replacement: src('typegen/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'harness/test/**/*.test.mjs'],
    environment: 'node',
    // A worker sandbox and a tsc child process are both slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
