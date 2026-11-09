import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    outDir: '.github/actions/dependabot-review/dist',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    fixedExtension: false,
    // Consumer runners install nothing, so every dependency is inlined.
    deps: { alwaysBundle: [/.*/] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
  lint: {
    ignorePatterns: ['.context/**', 'node_modules/**', 'coverage/**', '**/dist/**'],
    options: {
      denyWarnings: true,
    },
  },
  fmt: {
    ignorePatterns: ['.context/**', 'node_modules/**', 'coverage/**', '**/dist/**'],
    proseWrap: 'preserve',
    singleQuote: true,
  },
});
