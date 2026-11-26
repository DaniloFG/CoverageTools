import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 300_000 } },
      {
        test: {
          name: 'perf',
          include: ['test/perf/**/*.test.ts'],
          // One fork, one file at a time: timings are not shared with other test files, and
          // --expose-gc lets the memory tests collect garbage before measuring.
          pool: 'forks',
          execArgv: ['--expose-gc'],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'ui',
          include: ['test/ui/**/*.ui.test.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
