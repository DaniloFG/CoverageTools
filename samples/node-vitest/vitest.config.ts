import { defineConfig } from 'vitest/config';

// Without its own config, Vitest would pick up the repository's root vitest.config.ts.
export default defineConfig({
  test: {},
});
