export default {
  lint: {
    categories: { correctness: 'off' },
    jsPlugins: ['./plugin.mjs'],
    rules: { 'complexity-report/measure': ['warn', 0] },
    options: { denyWarnings: false },
  },
};
