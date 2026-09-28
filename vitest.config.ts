import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 5000,
    hookTimeout: 5000,
    coverage: {
      provider: 'v8',
      include: ['src/mp3/**/*.ts', 'src/http/**/*.ts', 'src/config.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: { statements: 90, lines: 90, functions: 90, branches: 85 },
    },
  },
});
