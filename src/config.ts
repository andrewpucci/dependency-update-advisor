const CONFIG_FILE = '.github/dependabot-review.json';
const MAX_CONFIG_BYTES = 16_384;
const VERDICTS = ['merge', 'merge_with_followups', 'do_not_merge'] as const;

export type Verdict = (typeof VERDICTS)[number];

const DEFAULT_VERDICTS = {
  incompleteEvidence: 'merge_with_followups',
  highOrCriticalVulnerability: 'do_not_merge',
  moderateOrLowVulnerability: 'merge_with_followups',
  incompatibleMigration: 'do_not_merge',
  applicableCodemod: 'merge_with_followups',
} as const satisfies Record<string, Verdict>;

export type PolicyRule = keyof typeof DEFAULT_VERDICTS;
export type PolicyOverrides = Partial<Record<PolicyRule, Verdict>>;

export type ReviewConfig = {
  version: 1;
  analysis?: { provider: 'mistral'; model: string };
  context: {
    sourceRoots: string[];
    sendSourceExcerptsToModel: boolean;
    excerptFiles: string[];
  };
  policy: { verdicts: Record<PolicyRule, Verdict> };
};

type ErrorCategory = 'read' | 'path' | 'size' | 'encoding' | 'json' | 'version' | 'validation';
export type ConfigResult =
  | { ok: true; config: ReviewConfig; origin: 'file' | 'missing'; overrides: PolicyOverrides }
  | { ok: false; error: { file: string; category: ErrorCategory; field: string } };

function failure(category: ErrorCategory, field = '$'): ConfigResult {
  return { ok: false, error: { file: CONFIG_FILE, category, field } };
}

function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validPath(value: unknown, exactFile: boolean): value is string {
  if (
    typeof value !== 'string' ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    (exactFile && /[*?[\]{}]/u.test(value))
  )
    return false;
  return value.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.'));
}

function validPaths(value: unknown, limit: number, exactFile: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((path) => validPath(path, exactFile)) &&
    (!exactFile || new Set(value).size === value.length)
  );
}

function invalidField(document: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(document, 'analysis')) {
    const analysis = document.analysis;
    if (!objectWithKeys(analysis, ['provider', 'model'])) return 'analysis';
    if (analysis.provider !== 'mistral') return 'analysis.provider';
    if (
      typeof analysis.model !== 'string' ||
      analysis.model.length < 1 ||
      analysis.model.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/u.test(analysis.model)
    )
      return 'analysis.model';
  }
  if (Object.hasOwn(document, 'context')) {
    const context = document.context;
    if (!objectWithKeys(context, ['sourceRoots', 'sendSourceExcerptsToModel', 'excerptFiles']))
      return 'context';
    if (Object.hasOwn(context, 'sourceRoots') && !validPaths(context.sourceRoots, 16, false))
      return 'context.sourceRoots';
    if (
      Object.hasOwn(context, 'sendSourceExcerptsToModel') &&
      typeof context.sendSourceExcerptsToModel !== 'boolean'
    )
      return 'context.sendSourceExcerptsToModel';
    if (Object.hasOwn(context, 'excerptFiles') && !validPaths(context.excerptFiles, 128, true))
      return 'context.excerptFiles';
  }
  if (Object.hasOwn(document, 'policy')) {
    const policy = document.policy;
    if (!objectWithKeys(policy, ['verdicts'])) return 'policy';
    if (Object.hasOwn(policy, 'verdicts')) {
      if (!objectWithKeys(policy.verdicts, Object.keys(DEFAULT_VERDICTS))) return 'policy.verdicts';
      for (const [rule, value] of Object.entries(policy.verdicts)) {
        if (!VERDICTS.some((verdict) => verdict === value)) return `policy.verdicts.${rule}`;
      }
    }
  }
  return undefined;
}

function defaultConfig(): ReviewConfig {
  return {
    version: 1,
    context: { sourceRoots: ['src'], sendSourceExcerptsToModel: false, excerptFiles: [] },
    policy: { verdicts: { ...DEFAULT_VERDICTS } },
  };
}

/** Validates present JSON; failure never substitutes missing-file defaults. */
export function parseReviewConfig(text: string): ConfigResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) return failure('size');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return failure('json');
  }
  if (!objectWithKeys(document, ['version', 'analysis', 'context', 'policy']))
    return failure('validation');
  if (document.version !== 1) return failure('version', 'version');
  const field = invalidField(document);
  if (field) return failure('validation', field);

  // These sections have all passed the runtime boundary above.
  const analysis = document.analysis as ReviewConfig['analysis'];
  const context = document.context as Partial<ReviewConfig['context']> | undefined;
  const policy = document.policy as { verdicts?: PolicyOverrides } | undefined;
  const overrides = { ...policy?.verdicts };
  const config = defaultConfig();
  if (analysis) config.analysis = { ...analysis };
  if (context?.sourceRoots) config.context.sourceRoots = [...context.sourceRoots];
  if (context?.sendSourceExcerptsToModel !== undefined)
    config.context.sendSourceExcerptsToModel = context.sendSourceExcerptsToModel;
  if (context?.excerptFiles) config.context.excerptFiles = [...context.excerptFiles];
  config.policy.verdicts = { ...config.policy.verdicts, ...overrides };
  return { ok: true, config, origin: 'file', overrides };
}
