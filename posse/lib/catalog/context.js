export const CONTEXT_CHARS_PER_TOKEN_ESTIMATE = 4;

export const CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS = 8000;
export const CONTEXT_FETCH_REF_MAX_LIMIT_CHARS = 60000;

export const CONTEXT_CHAIN_READ_DEFAULT_LIMIT_LINES = 2000;

export const CONTEXT_HASH_REF_MATERIALIZE_CHAR_CAP = 1024 * 1024;
export const CONTEXT_BOUNDED_RETENTION_CHAR_CAP = 16 * 1024 * 1024;

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
  // symbol.search returns the largest per-call payloads in the research lane
  // (~29KB observed in run28/29). Enrollment is gated by the
  // atlas_search_result_paging setting in boundingPolicyFor so in-flight
  // experiments keep a stable baseline; the full result stays one fetch_ref
  // page away.
  "symbol.search": Object.freeze({
    capChars: 10000,
    headChars: 7600,
    tailChars: 900,
    digest: "generic",
  }),
  "atlas.symbol.search": Object.freeze({
    capChars: 10000,
    headChars: 7600,
    tailChars: 900,
    digest: "generic",
  }),
  // A batch symbol.card response can easily exceed the Claude terminal's
  // tool-result ceiling because every card carries hydrated callers/callees.
  // Keep a useful inline window and retain the complete JSON behind fetch_ref.
  // Unlike the search experiment this is an unconditional transport-safety
  // bound: an oversized MCP success must not be rewritten into a client error.
  "symbol.card": Object.freeze({
    capChars: 20000,
    headChars: 14000,
    tailChars: 1200,
    digest: "symbol_card",
  }),
  "atlas.symbol.card": Object.freeze({
    capChars: 20000,
    headChars: 14000,
    tailChars: 1200,
    digest: "symbol_card",
  }),
  // Structural Atlas payloads are compact JSON but can still reach 75-130KB
  // on large repositories. Claude spills results above its inline ceiling to
  // a temporary file, which adds a redundant native read (and can prompt a
  // Windows-only Get-Content command on Linux). Keep the full result behind
  // fetch_ref and deliver a transport-safe preview.
  "code.structure": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "atlas.code.structure": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "code.skeleton": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "atlas.code.skeleton": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "tree.branch": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "atlas.tree.branch": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "tree.expand": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
  }),
  "atlas.tree.expand": Object.freeze({
    capChars: 18000,
    headChars: 13000,
    tailChars: 1000,
    digest: "generic",
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
