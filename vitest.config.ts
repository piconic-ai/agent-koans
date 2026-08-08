// Vitest configuration: test discovery boundaries only.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Stated positively instead of excluding directories: the default
    // globs also discover test suites inside nested checkouts (tool
    // worktrees, vendored copies), which are not this repository's tests.
    include: ['test/**/*.test.ts'],
  },
});
