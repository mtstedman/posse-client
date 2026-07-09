export const CONTEXT_CHARS_PER_TOKEN_ESTIMATE = 4;

export const CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS = 8000;
export const CONTEXT_FETCH_REF_MAX_LIMIT_CHARS = 60000;

export const CONTEXT_CHAIN_READ_DEFAULT_LIMIT_LINES = 2000;

export const CONTEXT_HASH_REF_MATERIALIZE_CHAR_CAP = 1024 * 1024;

export const CONTEXT_PRESSURE_THRESHOLDS = Object.freeze({
  softTokens: 100000,
  hardTokens: 140000,
  resetTokens: 150000,
  cumulativeBillableTokens: 2000000,
  avgOutputTokensPerTurn: 800,
});

export const CONTEXT_BOUNDING_POLICIES = Object.freeze({
  search_files: Object.freeze({
    capChars: 8000,
    headChars: 5200,
    tailChars: 1000,
    digest: "search_files",
  }),
  list_files: Object.freeze({
    capChars: 6000,
    headChars: 4200,
    tailChars: 800,
    digest: "list_files",
  }),
});

export const CONTEXT_TRIM_CLASSES = Object.freeze([
  "never",
  "free",
  "superseded",
  "aged_relevant",
]);

export const CONTEXT_TRIM_CLASS_SET = new Set(CONTEXT_TRIM_CLASSES);
export const CONTEXT_TRIM_CLASS_LIST_SQL = CONTEXT_TRIM_CLASSES.map((value) => `'${value}'`).join(",");
