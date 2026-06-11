// @ts-check
//
// Query planner. Turns a natural-language task string into a structured
// retrieval plan: identifiers, path/file hints, stack frames, language
// hints, a coarse symptom label, and a deduped keyword list.
//
// The plan is the v2 substitute for "throw the whole task at FTS and pray".
// Backends consume specific facets:
//   - FTS probes identifiers first (exact-name match), then file/path
//     terms, then keyword token combinations.
//   - Vector search can still use the raw text, but the plan gives it
//     better seed terms when the encoder degrades.
//   - Task-query ranking favors symbols whose names overlap identifiers
//     more than they overlap stop-word soup.
//
// Plan construction (facet extraction, symptom classification, stop-word
// handling) is owned by the native posse-atlas binary — the only
// implementation path.

import { runAtlasNativeOperation } from "../../native/invoke.js";

/** @typedef {import("./query-planner-types.js").StackFrame} StackFrame */
/** @typedef {import("./query-planner-types.js").QueryPlan} QueryPlan */

/**
 * Produce a QueryPlan for a raw task/query string.
 *
 * Always returns a plan, even for empty/garbage input — callers can treat
 * `plan.raw === ""` as the "nothing to plan" signal without null checks.
 *
 * @param {string | undefined | null} input
 * @returns {QueryPlan}
 */
export function planQuery(input) {
  const plan = /** @type {any} */ (runAtlasNativeOperation({ op: "plan_query", input }));
  // Boundary normalization, not a fallback: the binary's wire shape names the
  // frame function `fnName` and leaves `file` OS-separated, while the QueryPlan
  // contract (and consumers like the FTS backend) read `fn` and repo-style
  // forward slashes. Map here until the binary emits the contract shape.
  if (Array.isArray(plan?.stackFrames)) {
    plan.stackFrames = plan.stackFrames.map((frame) => ({
      fn: String(frame?.fn ?? frame?.fnName ?? ""),
      ...(frame?.file != null ? { file: String(frame.file).replace(/\\/g, "/") } : {}),
      ...(frame?.line != null ? { line: frame.line } : {}),
    }));
  }
  return /** @type {QueryPlan} */ (plan);
}
