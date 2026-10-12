import { writeFileSync } from 'node:fs';
import { definePlugin, defineRule } from 'vite-plus/lint/plugins';
// Load only the pinned cognitive rule; unrelated type-aware rules require TypeScript's JS API.
import { rule as cognitive } from 'eslint-plugin-sonarjs/cjs/S3776/index.js';

export default definePlugin({
  meta: { name: 'complexity-report' },
  rules: {
    measure: defineRule({
      meta: cognitive.meta,
      create(context) {
        const functions = [];
        const findings = [];
        // Capture SonarJS findings before lint suppressions, without changing its scoring.
        const measurementContext = Object.create(context, {
          report: { value: (finding) => findings.push(finding) },
        });
        const visitor = cognitive.create(measurementContext);
        return {
          ...visitor,
          ':function'(node) {
            const parent = node.parent;
            const owner = ['Property', 'MethodDefinition'].includes(parent.type) ? parent : node;
            const key = parent.computed ? undefined : parent.key;
            const name =
              node.id?.name ??
              parent.id?.name ??
              (key?.type === 'PrivateIdentifier' ? `#${key.name}` : (key?.name ?? key?.value)) ??
              '(anonymous)';
            functions.push({
              name: String(name),
              line: node.loc.start.line,
              score: 0,
              range: owner.range,
            });
            visitor[':function']?.(node);
          },
          'Program:exit'(node) {
            visitor['Program:exit']?.(node);
            for (const finding of findings) {
              const index = context.sourceCode.getIndexFromLoc(finding.loc.start);
              const fn = functions
                .filter(({ range }) => range[0] <= index && index < range[1])
                .sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]))[0];
              if (!fn || !Number.isInteger(finding.data?.complexityAmount)) {
                throw new Error('Unrecognized SonarJS finding');
              }
              fn.score = finding.data.complexityAmount;
            }
            writeFileSync(
              process.env.COMPLEXITY_OUTPUT,
              JSON.stringify(functions.map(({ range: _range, ...fn }) => fn)),
            );
          },
        };
      },
    }),
  },
});
