import { definePlugin, defineRule } from 'vite-plus/lint/plugins';

/**
 * oxlint's `no-magic-numbers` skips a literal that initializes a named constant or an object
 * field, which is exactly how a new limit usually appears (`const MAX_BODY = 50_000`). This rule
 * reports those, so every limit lives in src/limits.ts with its reason. The same values
 * `no-magic-numbers` ignores are ignored here: counters start at 0, and 1, -1, and 2 are
 * structural (steps, sentinels, pairs, halves).
 */
const IGNORED = new Set([0, 1, -1, 2]);

function numericValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (
    node?.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument?.type === 'Literal' &&
    typeof node.argument.value === 'number'
  )
    return -node.argument.value;
  return undefined;
}

export default definePlugin({
  meta: { name: 'limits' },
  rules: {
    'no-literal-limit': defineRule({
      meta: {
        type: 'problem',
        messages: {
          literal:
            'Numeric literal {{value}} names a value outside the limit register; add it to src/limits.ts, or name a format fact in src/format.ts.',
        },
      },
      create(context) {
        const check = (node) => {
          const value = numericValue(node);
          if (value === undefined || IGNORED.has(value)) return;
          context.report({ node, messageId: 'literal', data: { value: String(value) } });
        };
        return {
          VariableDeclarator(node) {
            if (node.parent?.kind === 'const') check(node.init);
          },
          Property(node) {
            if (node.parent?.type === 'ObjectExpression') check(node.value);
          },
        };
      },
    }),
  },
});
