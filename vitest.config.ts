import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The provider contract test loads the built CJS artifact (dist/index.js),
    // so the full suite must run after a build. `npm test` ensures this.
    pool: 'threads',
  },
});
