import { definePlugin, defineRule } from 'vite-plus/lint/plugins';

/**
 * oxlint's `no-magic-numbers` skips a literal that initializes a variable, which is exactly how a
 * new limit usually appears (`const MAX_BODY = 50_000`). This rule reports those, so every limit
 * lives in src/limits.ts with its reason. Object fields need no handler here: `no-magic-numbers`
 * reports them itself (`detectObjects`). The same values
 * `no-magic-numbers` ignores are ignored here: counters start at 0, and 1, -1, and 2 are
 * structural (steps, sentinels, pairs, halves).
 */
const IGNORED = new Set([0, 1, -1, 2]);

function literalValue(node) {
  if (node?.type !== 'Literal') return undefined;
  if (typeof node.value === 'number') return node.value;
  // A BigInt literal (`50_000n`) holds a limit as surely as a number does.
  if (typeof node.value === 'bigint' || typeof node.bigint === 'string')
    return Number(node.bigint ?? node.value);
  return undefined;
}

function numericValue(node) {
  if (node?.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const value = literalValue(node.argument);
    return value === undefined ? undefined : node.operator === '-' ? -value : value;
  }
  return literalValue(node);
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
          // `const`, `let`, and `var` alike: a limit can start as any of them.
          VariableDeclarator(node) {
            check(node.init);
          },
        };
      },
    }),
  },
});
