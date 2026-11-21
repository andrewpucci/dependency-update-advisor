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
    ignorePatterns: [
      '.context/**',
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '.github/actions/dependabot-review/dist/**',
    ],
    // Every limit lives in src/limits.ts with its reason (docs/specs/SPEC-limit-register.md).
    jsPlugins: ['./scripts/lint/limits-plugin.mjs'],
    rules: {
      'no-magic-numbers': [
        'error',
        {
          // 0 starts counters; 1, -1, and 2 are steps, sentinels, pairs, and halves.
          ignore: [0, 1, -1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: false,
          detectObjects: true,
          enforceConst: false,
        },
      ],
      'limits/no-literal-limit': 'error',
    },
    overrides: [
      {
        files: [
          // The register itself, where every limit is written once.
          'src/limits.ts',
          // Named format facts: protocol codes, character ranges, field layouts.
          'src/format.ts',
          // Tiny parser inputs for the startup self-check, not limits.
          'src/self-check-fixtures.ts',
          // Tests pin values and build fixtures.
          '**/*.test.ts',
          '**/*.test.mjs',
          'tests/**',
        ],
        rules: { 'no-magic-numbers': 'off', 'limits/no-literal-limit': 'off' },
      },
    ],
    options: {
      denyWarnings: true,
    },
  },
  fmt: {
    ignorePatterns: [
      '.context/**',
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '.github/actions/dependabot-review/dist/**',
    ],
    proseWrap: 'preserve',
    singleQuote: true,
  },
});
