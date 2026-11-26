import Ajv from "ajv";
import { createHash } from "node:crypto";
import { EXPERIMENT_LIMITS, EXPERIMENT_PLAN_JSON_SCHEMA, EXPERIMENT_PLAN_SCHEMA, EXPERIMENT_PLAN_ISSUES as I, EXPERIMENT_EXECUTION_UNAVAILABLE } from "../../../catalog/experiments.js";

const validate = new Ajv({ allErrors: true, strict: false, ownProperties: true }).compile(EXPERIMENT_PLAN_JSON_SCHEMA);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// Reject ambiguous paths rather than normalizing them into a different grant.
export function validExperimentWorkPath(value) {
  if (typeof value !== "string" || !value.startsWith("work/") || value.length > 240) return false;
  return value.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)
    && !part.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function validateExperimentPlan(plan) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });
  let serialized;
  try { serialized = JSON.stringify(plan); } catch { /* cyclic or non-JSON input */ }
  if (!serialized || Buffer.byteLength(serialized) > EXPERIMENT_LIMITS.planBytes) {
    add("/", I.SIZE, `Plan must be JSON no larger than ${EXPERIMENT_LIMITS.planBytes} bytes.`);
  } else if (!validate(plan)) {
    for (const issue of validate.errors || []) add(issue.instancePath || "/", I.SCHEMA, issue.message);
  } else {
    const paths = new Set();
    for (const [index, file] of plan.files.entries()) {
      const pointer = `/files/${index}`;
      if (!validExperimentWorkPath(file.path)) add(`${pointer}/path`, I.FILE_SCOPE, "Files must be unambiguous relative paths under work/.");
      const folded = file.path.toLowerCase();
      if (paths.has(folded)) add(`${pointer}/path`, I.DUPLICATE_PATH, "File paths must be unique, including case variants.");
      paths.add(folded);
      if (file.mode === "create" ? file.source !== undefined : !file.source) add(pointer, I.SOURCE_BINDING, "Read/modify files require a source reference; new files must not have one.");
    }
    for (const name of paths) {
      if (Array.from(paths).some(other => other !== name && other.startsWith(`${name}/`))) add("/files", I.PATH_OVERLAP, "A declared file cannot also be a parent directory.");
    }
    if (!plan.files.some(file => file.path === plan.entrypoint)) add("/entrypoint", I.ENTRYPOINT_SCOPE, "Entrypoint must be a declared file.");
    if (!plan.files.some(file => file.mode !== "read")) add("/files", I.FILE_SCOPE, "At least one payload file must be editable.");
    const extension = plan.runtime.profile === "python" ? /\.py$/ : /\.(?:js|mjs|cjs|ts)$/;
    if (!extension.test(plan.entrypoint)) add("/entrypoint", I.RUNTIME_MISMATCH, "Entrypoint extension must match the public runtime profile.");
    const ids = new Set();
    for (const [index, metric] of plan.metrics.entries()) {
      if (ids.has(metric.id)) add(`/metrics/${index}/id`, I.DUPLICATE_METRIC, "Metric identities must be unique.");
      ids.add(metric.id);
      if (metric.role === "tracking" ? metric.target !== undefined : !Number.isFinite(metric.target)) add(`/metrics/${index}/target`, I.METRIC_TARGET, "Goals and guardrails require a finite target; tracking metrics have no target.");
    }
    if (!plan.metrics.some(metric => metric.role === "goal")) add("/metrics", I.MISSING_GOAL, "At least one required goal is needed.");
    if (plan.acceptance?.mode === "automatic" && (!plan.metrics.some(metric => metric.id === plan.acceptance.primary_metric && metric.role === "goal") || !Number.isFinite(plan.acceptance.min_improvement))) add("/acceptance", I.METRIC_TARGET, "Automatic acceptance requires a primary goal metric and finite minimum improvement.");
    if (plan.acceptance?.mode === "human" && Object.keys(plan.acceptance).length !== 1) add("/acceptance", I.SCHEMA, "Human acceptance only declares its mode.");
    if ((plan.baseline.mode === "import") !== !!plan.baseline.reference) add("/baseline", I.BASELINE_REFERENCE, "Imported baselines require a reference; capture mode must not supply one.");
    if (plan.progress.stale_after_seconds < plan.progress.interval_seconds * 2) add("/progress", I.STALE_INTERVAL, "Stale threshold must be at least two progress intervals.");
    const dependencies = new Set();
    for (const dependency of plan.runtime.dependencies) {
      const name = dependency.name.toLowerCase();
      if (dependencies.has(name)) add("/runtime/dependencies", I.DUPLICATE_DEPENDENCY, "Dependency names must be unique.");
      dependencies.add(name);
    }
  }
  const ok = issues.length === 0;
  return {
    schema: EXPERIMENT_PLAN_SCHEMA, ok,
    issues: issues.slice(0, EXPERIMENT_LIMITS.issues), issues_omitted: Math.max(0, issues.length - EXPERIMENT_LIMITS.issues),
    plan_digest: ok ? createHash("sha256").update(JSON.stringify(canonical(plan))).digest("hex") : null,
    summary: ok ? { max_iterations: plan.max_iterations, files: plan.files.length, metrics: plan.metrics.length, profile: plan.runtime.profile } : null,
    // Structural acceptance never resolves an artifact, installs a package or
    // grants execution. Keep this explicit in every caller-facing receipt.
    execution: { available: false, reason: EXPERIMENT_EXECUTION_UNAVAILABLE },
  };
}
