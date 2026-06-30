import { configDefaults, defineConfig } from 'vitest/config';

// tests/bun/** run under `bun test` (they use bun:ffi / bun:test, which vitest's
// Node-based runner can't resolve). Keep them out of the vitest run.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/bun/**'],
  },
});
