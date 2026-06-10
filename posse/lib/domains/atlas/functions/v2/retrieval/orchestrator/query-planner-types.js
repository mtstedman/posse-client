// @ts-check
//
// QueryPlan typedef sidecar. Kept separate from query-planner.js so other
// modules can `import("./query-planner-types.js").QueryPlan` without
// pulling the planner runtime into their module graph.

/**
 * One frame extracted from a stack-trace-shaped substring of a task.
 *
 * @typedef {Object} StackFrame
 * @property {string} fn               Function name (or "<anonymous>" / "<module>" / "<go-frame>" sentinel).
 * @property {string} [file]           File path the frame points at.
 * @property {number} [line]           1-based line number when the frame supplied one.
 */

/**
 * Structured retrieval plan derived from a raw task/query string.
 *
 * Producers: query-planner.js / planQuery().
 * Consumers: FTS backend (probe order), vector backend (seed expansion),
 *            task-query-ranking (overlap features).
 *
 * @typedef {Object} QueryPlan
 * @property {string} raw              Original input trimmed; "" when no usable input.
 * @property {string[]} identifiers    Tokens that look like code symbols (camelCase, snake_case, qualified names).
 * @property {string[]} paths          File-system path hints ("src/foo.ts", "lib/bar.py").
 * @property {string[]} fileNames      Terminal filename components of `paths`.
 * @property {StackFrame[]} stackFrames Parsed stack frames (any of JS/Python/Go/Java/Rust shapes).
 * @property {string[]} languageHints  Canonical lowercase language tags inferred from prose or path extensions.
 * @property {string | null} symptom   Coarse symptom label when the prose matches a known pattern (e.g. "null_pointer", "race"). Null otherwise.
 * @property {string[]} keywords       Deduped non-stopword tokens left after identifiers + paths are removed.
 * @property {boolean} identifierLike  True when the whole query is one bare identifier — exact-name match dominates.
 */

export {};
