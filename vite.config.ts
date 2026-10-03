import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
  lint: {
    ignorePatterns: ['.context/**', 'node_modules/**', 'coverage/**', 'dist/**'],
    options: {
      denyWarnings: true,
    },
  },
  fmt: {
    ignorePatterns: ['.context/**', 'node_modules/**', 'coverage/**', 'dist/**'],
    proseWrap: 'preserve',
    singleQuote: true,
  },
});
