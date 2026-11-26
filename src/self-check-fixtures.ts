/**
 * Option sets for the startup self-check fixtures. These are tiny inputs that exercise the parsers
 * at startup, not limits: each set only has to let its fixture parse.
 */
export const SELF_CHECK_TOML_LIMITS = {
  maxFileBytes: 64,
  maxTomlDepth: 4,
  maxTomlEntries: 8,
  maxPackages: 1,
  maxDeclarations: 1,
  maxEdges: 1,
  maxStringBytes: 16,
  maxRequirementTokens: 4,
  maxMarkerDepth: 2,
};

export const SELF_CHECK_WORKFLOW_LIMITS = {
  maxFileBytes: 256,
  maxYamlNodes: 64,
  maxYamlDepth: 8,
  maxAliasExpansions: 0,
  maxOccurrences: 4,
};

export const SELF_CHECK_LICENSE_LIMITS = { maxBytes: 32, maxTokens: 4, maxDepth: 2 };
