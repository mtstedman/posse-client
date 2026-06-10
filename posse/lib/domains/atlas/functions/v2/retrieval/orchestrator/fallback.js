// @ts-check
//
// Health summary + degradation reporting. The orchestrator runs each
// backend independently and feeds the per-backend results here; the
// fallback module decides what the response "degraded" flags look like
// from the outside.
//
// The orchestrator NEVER throws when a single backend fails — it
// downgrades. A degraded result with one healthy backend is always
// preferred to an error envelope, because callers can still make
// forward progress on the survivor's ranking.

/**
 * @typedef {Object} BackendHealth
 * @property {boolean} ok
 * @property {string} [reason]      Set when ok === false.
 */

/**
 * @typedef {Object} DegradationReport
 * @property {Record<string, BackendHealth>} backends
 * @property {string[]} active                  Names of backends that contributed to the ranking.
 * @property {string[]} unavailable             Names of backends explicitly skipped.
 * @property {boolean} fullyDegraded            True iff no backend ran successfully.
 */

/**
 * Build a degradation report from a map of per-backend results. The
 * heavy lifting was already done in the backend modules; this just
 * normalizes the report shape.
 *
 * @param {Record<string, { ok: boolean, total: number, reason?: string }>} results
 * @returns {DegradationReport}
 */
export function summarizeBackends(results) {
  /** @type {Record<string, BackendHealth>} */
  const backends = {};
  /** @type {string[]} */
  const active = [];
  /** @type {string[]} */
  const unavailable = [];
  for (const [name, r] of Object.entries(results)) {
    const ok = !!r.ok;
    backends[name] = ok ? { ok: true } : { ok: false, reason: r.reason || "unknown" };
    if (ok && r.total > 0) active.push(name);
    if (!ok) unavailable.push(name);
  }
  return {
    backends,
    active,
    unavailable,
    fullyDegraded: Object.values(backends).every((backend) => !backend.ok),
  };
}
