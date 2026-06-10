// @ts-check
//
// Small benchmark regression helpers for Atlas. The CLI wrapper lives in
// scripts/atlas-v2-benchmark.mjs; these pure helpers are intentionally easy to
// test and reuse from CI.

/**
 * @typedef {Object} BenchmarkMetric
 * @property {string} name
 * @property {number} value
 * @property {"ms" | "count" | "ratio"} unit
 * @property {"lower" | "higher"} better
 * @property {number[]} [samples]
 * @property {number} [medianMs]
 * @property {number} [p95Ms]
 */

/**
 * @typedef {Object} BenchmarkFinding
 * @property {string} name
 * @property {number} current
 * @property {number | null} baseline
 * @property {number | null} deltaPercent
 * @property {"pass" | "warn" | "fail" | "new"} status
 * @property {string} message
 */

/**
 * @param {{
 *   current: BenchmarkMetric[],
 *   baseline?: Record<string, number> | null,
 *   warnPercent?: number,
 *   failPercent?: number,
 * }} args
 */
export function evaluateBenchmarkRegression({ current, baseline = null, warnPercent = 10, failPercent = 25 }) {
  /** @type {BenchmarkFinding[]} */
  const findings = [];
  for (const metric of current) {
    const base = Number(baseline?.[metric.name]);
    if (!Number.isFinite(base) || (base === 0 && metric.unit === "ms")) {
      findings.push({
        name: metric.name,
        current: metric.value,
        baseline: null,
        deltaPercent: null,
        status: "new",
        message: `${metric.name}: new metric ${formatMetric(metric.value, metric.unit)}`,
      });
      continue;
    }
    if (base === 0) {
      const regression = metric.better === "lower" ? metric.value > 0 : metric.value < 0;
      findings.push({
        name: metric.name,
        current: metric.value,
        baseline: base,
        deltaPercent: null,
        status: regression ? "fail" : "pass",
        message: `${metric.name}: ${formatMetric(metric.value, metric.unit)} vs zero baseline ${formatMetric(base, metric.unit)}`,
      });
      continue;
    }
    const rawDelta = ((metric.value - base) / base) * 100;
    const regressionDelta = metric.better === "lower" ? rawDelta : -rawDelta;
    const status = regressionDelta >= failPercent ? "fail" : regressionDelta >= warnPercent ? "warn" : "pass";
    findings.push({
      name: metric.name,
      current: metric.value,
      baseline: base,
      deltaPercent: round(rawDelta),
      status,
      message: `${metric.name}: ${formatMetric(metric.value, metric.unit)} vs baseline ${formatMetric(base, metric.unit)} (${round(rawDelta)}%)`,
    });
  }
  return {
    ok: findings.every((finding) => finding.status !== "fail"),
    findings,
    summary: {
      total: findings.length,
      failed: findings.filter((finding) => finding.status === "fail").length,
      warned: findings.filter((finding) => finding.status === "warn").length,
      newMetrics: findings.filter((finding) => finding.status === "new").length,
    },
  };
}

/**
 * @param {number} previous
 * @param {number} current
 * @param {number} [alpha]
 */
export function exponentialSmooth(previous, current, alpha = 0.3) {
  const a = Math.max(0, Math.min(1, Number(alpha)));
  if (!Number.isFinite(previous)) return current;
  if (!Number.isFinite(current)) return previous;
  return previous * (1 - a) + current * a;
}

/**
 * @param {Record<string, number>} previous
 * @param {BenchmarkMetric[]} current
 * @param {number} [alpha]
 */
export function smoothBenchmarkBaseline(previous, current, alpha = 0.3) {
  const out = { ...(previous || {}) };
  for (const metric of current) {
    out[metric.name] = exponentialSmooth(Number(out[metric.name]), metric.value, alpha);
  }
  return out;
}

function formatMetric(value, unit) {
  const rounded = round(value);
  return unit === "ratio" ? `${rounded}` : `${rounded}${unit}`;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
