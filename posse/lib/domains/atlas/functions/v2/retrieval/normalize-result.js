// @ts-check
//
// Canonical "strip volatile fields" pass shared by:
//   - test/test-atlas-v2-corpus.test.js (snapshot comparison)
//   - ATLAS v2 retrieval tests and snapshot comparisons
//
// Whenever a tool result includes a field that changes run-to-run for
// reasons unrelated to correctness (a slice handle, an etag computed
// from a content hash, a duration in ms, a timestamp), it lives in
// VOLATILE_FIELDS so every consumer that needs structural comparison
// gets the same treatment.
//
// Add a field here, and all comparison paths stay in sync. Forget to
// add it and snapshot tests + shadow diffs both flag it — the failure
// is loud but consistent, never silent drift.

/**
 * Field names dropped from envelopes before structural comparison.
 * Members are matched at any nesting depth.
 */
export const VOLATILE_FIELDS = Object.freeze(
  new Set([
    // Tool-result handles minted from a hash of the request + state.
    "sliceHandle",
    "spilloverHandle",
    // Etags derived from content; the underlying content drives equality.
    "etag",
    // Timings.
    "durationMs",
    "duration_ms",
    "totalDurationMs",
    "avgDurationMs",
    "p50DurationMs",
    "p95DurationMs",
    // Build-time stamps stored in ViewMeta.
    "built_at",
    "lastIndexedAt",
    "updatedAt",
    "createdAt",
    "timestamp",
    "lastTs",
    "lastRunAt",
    // ML seed-label staleness stamps (labeled_at/stale_since tracking).
    "lastLabeledAt",
    "labeledAt",
    "labeled_at",
    "staleSince",
    "stale_since",
    "memoryId",
    "memory_id",
    "snapshotId",
    "operationId",
    "startedAt",
    "completedAt",
    "at",
    // Runtime-local filesystem paths.
    "repoRoot",
    "ledgerPath",
    "viewPath",
    "mainViewPath",
    "worktreeViewPath",
    "indexPath",
    "cacheDir",
    "modelCacheDir",
    "view_written",
    "view_etag",
    "builtAt",
    "node",
    "platform",
    "arch",
  ]),
);

const VOLATILE_OPTIONAL_DEPENDENCIES = new Set([
  "@huggingface/transformers",
  "onnxruntime-node",
]);

/**
 * Drop volatile fields from a JSON-serializable tree, returning a fresh
 * structure with the same shape minus the masked keys. Leaves arrays
 * and primitives alone; recurses into objects.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function stripVolatileFields(value) {
  if (Array.isArray(value)) {
    return /** @type {any} */ (value.map((v) => stripVolatileFields(v)));
  }
  if (value && typeof value === "object") {
    if (isVolatileOptionalDependency(value)) {
      const { available: _available, path: _path, ...rest } = /** @type {Record<string, unknown>} */ (value);
      return /** @type {any} */ (stripVolatileFields(rest));
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (VOLATILE_FIELDS.has(k)) continue;
      out[k] = stripVolatileFields(v);
    }
    return /** @type {any} */ (out);
  }
  return value;
}

/**
 * Alternate form that replaces volatile fields with a sentinel instead
 * of dropping them. Used by snapshot files where we want the *presence*
 * of the field to be locked down but not the exact value.
 *
 * @template T
 * @param {T} value
 * @param {string} [sentinel]
 * @returns {T}
 */
export function maskVolatileFields(value, sentinel = "<stripped>") {
  if (Array.isArray(value)) {
    return /** @type {any} */ (value.map((v) => maskVolatileFields(v, sentinel)));
  }
  if (value && typeof value === "object") {
    if (isVolatileOptionalDependency(value)) {
      const out = { .../** @type {Record<string, unknown>} */ (value), available: sentinel, path: sentinel };
      return /** @type {any} */ (out);
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (VOLATILE_FIELDS.has(k)) {
        out[k] = sentinel;
        continue;
      }
      out[k] = maskVolatileFields(v, sentinel);
    }
    return /** @type {any} */ (out);
  }
  return value;
}

function isVolatileOptionalDependency(value) {
  if (!value || typeof value !== "object") return false;
  const obj = /** @type {Record<string, unknown>} */ (value);
  return typeof obj.name === "string"
    && VOLATILE_OPTIONAL_DEPENDENCIES.has(obj.name)
    && Object.hasOwn(obj, "available")
    && Object.hasOwn(obj, "path");
}
