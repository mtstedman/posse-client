// Public experiment contracts. Runner implementation and execution authority
// are deliberately absent from these public contracts.
export const EXPERIMENT_PLAN_SCHEMA = "posse.experiment.plan.v1";
export const EXPERIMENT_PROGRESS_SCHEMA = "posse.experiment.progress.v1";
export const EXPERIMENT_REPORT_SCHEMA = "posse.experiment.report.v1";
export const EXPERIMENT_REPORT_STATUSES = Object.freeze(["completed", "failed", "cancelled", "running"]);
export const EXPERIMENT_OPERATIONS = Object.freeze({ SCHEMA: "experiment.schema", VALIDATE: "experiment.validate",
  SETUP_SCHEMA: "experiment.setup_schema", SETUP_VALIDATE: "experiment.setup_validate", LAUNCH: "experiment.launch", INTEGRATE: "experiment.integrate", INTEGRATION_LOG: "experiment.integration_log", CASE_RESULTS: "experiment.case_results", STOP: "experiment.stop",
  CREATE: "experiment.create", GET: "experiment.get", LIST: "experiment.list", STAGE: "experiment.stage",
  RUN: "experiment.run", DECIDE: "experiment.decide", FILES: "experiment.files", REPORT: "experiment.report", PROGRESS: "experiment.progress", CANCEL: "experiment.cancel" });
export const EXPERIMENT_OBJECTS = Object.freeze({ CAMPAIGNS: "experiment_campaigns", SNAPSHOTS: "experiment_snapshots", REQUESTS: "experiment_requests", RUNNERS: "experiment_runners", INTEGRATIONS: "experiment_integrations", CASE_RESULTS: "experiment_case_results" });
export const EXPERIMENT_STATES = Object.freeze({ BASELINE: "baseline_required", READY: "ready", STAGED: "staged", RUNNING: "running", REVIEW: "awaiting_decision", GOAL: "goal_met", EXHAUSTED: "iterations_exhausted", BLOCKED: "blocked", CANCELLED: "cancelled" });
export const EXPERIMENT_ACCEPTANCE_MODES = Object.freeze(["human", "automatic"]);
export const EXPERIMENT_DECISIONS = Object.freeze(["accept", "reject"]);
export const EXPERIMENT_CAMPAIGN_REPORT_SCHEMA = "posse.experiment.report.v2";
export const EXPERIMENT_NUMERIC_SCHEMA = "posse.experiment.numeric.v1";
export const EXPERIMENT_RUNTIME_SCHEMA = "posse.experiment.runtime.v1";
export const EXPERIMENT_SETUP_SCHEMA = "posse.experiment.setup.v1";
export const EXPERIMENT_RUNNER_ROLES = Object.freeze(["coordinator", "writer", "assessor", "proctor"]);
export const EXPERIMENT_RUNNER_STATES = Object.freeze({ RUNNING: "running", REVIEW: "awaiting_decision", COMPLETE: "completed", BUDGET: "budget_exhausted", INTERRUPTED: "interrupted", ERROR: "error", CANCELLED: "cancelled" });
export const EXPERIMENT_NUMERIC_SCORERS = Object.freeze(["absolute_error", "squared_error", "exact_match"]);
export const EXPERIMENT_SANDBOX_LIMITS = Object.freeze({ cpus: 2, memoryMB: 2048, wallSeconds: 600, cases: 1000, payloadBytes: 262144, evaluationBytes: 1048576 });
export const EXPERIMENT_PAYLOAD_API = Object.freeze({
  protocol: "jsonl.numeric.v1", input: { case_id: "opaque case identifier", input: "JSON value" },
  output: { case_id: "same case identifier", prediction: "finite number" },
  rules: "One JSON prediction per case on stdout. Diagnostics go to stderr and count toward the output limit. No scorer, expected labels, owner state or runner code is mounted.",
  templates: {
    node: "import readline from 'node:readline';\nfunction predict(input) { /* insert algorithm here */ return 0; }\nfor await (const line of readline.createInterface({input: process.stdin})) {\n  const item = JSON.parse(line);\n  console.log(JSON.stringify({case_id: item.case_id, prediction: predict(item.input)}));\n}\n",
    python: "import sys, json\ndef predict(value):\n    # insert algorithm here\n    return 0\nfor line in sys.stdin:\n    item = json.loads(line)\n    print(json.dumps({'case_id': item['case_id'], 'prediction': predict(item['input'])}), flush=True)\n",
  },
});
export const EXPERIMENT_LIMITS = Object.freeze({ planBytes: 65536, reportBytes: 1048576, metrics: 32, files: 128, observations: 100000, issues: 40, progressSeconds: 5, staleSeconds: 15 });
export const EXPERIMENT_METRIC_ROLES = Object.freeze(["goal", "guardrail", "tracking"]);
export const EXPERIMENT_AGGREGATIONS = Object.freeze(["mean", "min", "max", "p95"]);
export const EXPERIMENT_DIRECTIONS = Object.freeze(["higher", "lower"]);
export const EXPERIMENT_FILE_MODES = Object.freeze(["read", "modify", "create"]);
export const EXPERIMENT_RUNTIME_PROFILES = Object.freeze(["python", "node"]);
export const EXPERIMENT_EXECUTION_UNAVAILABLE = "execution_backend_unavailable";
export const EXPERIMENT_PLAN_ISSUES = Object.freeze({
  SIZE: "plan_size", SCHEMA: "schema", FILE_SCOPE: "file_scope", DUPLICATE_PATH: "duplicate_path",
  SOURCE_BINDING: "source_binding", PATH_OVERLAP: "path_overlap", ENTRYPOINT_SCOPE: "entrypoint_scope",
  RUNTIME_MISMATCH: "runtime_mismatch", DUPLICATE_METRIC: "duplicate_metric", METRIC_TARGET: "metric_target",
  MISSING_GOAL: "missing_goal", BASELINE_REFERENCE: "baseline_reference", STALE_INTERVAL: "stale_interval",
  DUPLICATE_DEPENDENCY: "duplicate_dependency",
});
export const EXPERIMENT_USAGE = "posse experiment init-schema | init < experiment.json\nposse experiment launch|status|progress|stop <workspace-directory>\nposse experiment corpus schema|choices|create|register|list|inspect|import|update|remove|score|prep < request.json\nposse experiment corpus-options|corpus-contract|corpus-prepare|corpus-status|corpus-bind < request.json\nposse experiment case-results < {id, which: latest|accepted|baseline}\nposse experiment setup-schema | setup-validate < setup.json | launch < approved-setup-request.json\nposse experiment integrate < integration-request.json | integration-log < check-request.json\nposse experiment schema | validate < plan.json | report < measurements.json\nposse experiment list | create|get|stage|run|decide|files|progress|status|cancel|stop < request.json\ninit provisions a private runtime; raw launch requires a provisioned owner. status emits a campaign report; report previews supplied measurements.";

const text = maxLength => ({ type: "string", minLength: 1, maxLength });
const count = maximum => ({ type: "integer", minimum: 1, maximum });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const reference = object({ ref: text(160), digest });

export const EXPERIMENT_PLAN_JSON_SCHEMA = object({
  schema: { const: EXPERIMENT_PLAN_SCHEMA },
  objective: text(2000),
  hypothesis: text(2000),
  max_iterations: count(1000),
  evaluation: reference,
  baseline: object({ mode: { enum: ["capture", "import"] }, reference }, ["mode"]),
  runtime: object({
    profile: { enum: EXPERIMENT_RUNTIME_PROFILES },
    dependencies: { type: "array", maxItems: 64, items: object({
      name: { type: "string", maxLength: 128, pattern: "^(?:@[a-z0-9._-]+/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
      version: { type: "string", maxLength: 80, pattern: "^[0-9][a-zA-Z0-9.+_-]*$" },
      digest,
    }) },
  }),
  files: { type: "array", minItems: 1, maxItems: EXPERIMENT_LIMITS.files, items: object({
    path: text(240), mode: { enum: EXPERIMENT_FILE_MODES }, instructions: text(2000), source: reference,
  }, ["path", "mode", "instructions"]) },
  entrypoint: text(240),
  metrics: { type: "array", minItems: 1, maxItems: EXPERIMENT_LIMITS.metrics, items: object({
    id: { type: "string", maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" },
    unit: text(32), role: { enum: EXPERIMENT_METRIC_ROLES }, direction: { enum: EXPERIMENT_DIRECTIONS },
    aggregation: { enum: EXPERIMENT_AGGREGATIONS }, target: { type: "number" },
  }, ["id", "unit", "role", "direction", "aggregation"]) },
  resources: object({ wall_seconds: count(86400), memory_mb: count(65536), cpu_count: count(32), max_output_bytes: count(10485760) }),
  progress: object({ interval_seconds: count(60), stale_after_seconds: count(300) }),
  acceptance: object({ mode: { enum: EXPERIMENT_ACCEPTANCE_MODES }, primary_metric: text(64), min_improvement: { type: "number", minimum: 0 } }, ["mode"]),
}, ["schema", "objective", "hypothesis", "max_iterations", "evaluation", "baseline", "runtime", "files", "entrypoint", "metrics", "resources", "progress"]);

export function experimentPlanExample() {
  return {
    schema: EXPERIMENT_PLAN_SCHEMA,
    objective: "Improve quality while keeping latency within the declared limit",
    hypothesis: "Evaluate a general algorithm change against the frozen evaluation package",
    max_iterations: 10,
    evaluation: { ref: "evaluation-v1", digest: "0".repeat(64) },
    baseline: { mode: "capture" },
    runtime: { profile: "python", dependencies: [] },
    files: [{ path: "work/candidate.py", mode: "create", instructions: "Implement the algorithm using the public JSONL payload API." }],
    entrypoint: "work/candidate.py",
    metrics: [
      { id: "quality", unit: "score", role: "goal", direction: "higher", aggregation: "mean", target: 0.95 },
      { id: "latency", unit: "ms", role: "guardrail", direction: "lower", aggregation: "p95", target: 180 },
    ],
    resources: { wall_seconds: 600, memory_mb: 1024, cpu_count: 1, max_output_bytes: 1048576 },
    progress: { interval_seconds: EXPERIMENT_LIMITS.progressSeconds, stale_after_seconds: EXPERIMENT_LIMITS.staleSeconds },
    acceptance: { mode: "human" },
  };
}
