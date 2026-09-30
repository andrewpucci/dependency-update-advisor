import { defineConfig } from 'vite-plus';

export default defineConfig({
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
