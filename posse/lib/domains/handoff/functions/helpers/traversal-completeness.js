// Traversal completion directive helpers for research/dev handoffs.

export const DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS = 1600;

export const TRAVERSAL_COMPLETION_LANES = Object.freeze([
  Object.freeze({
    id: "default_precedence",
    terms: Object.freeze(["default", "precedence", "ordering", "override", "winning", "first", "last"]),
    minimum: 1,
  }),
  Object.freeze({
    id: "ordered_control_flow",
    terms: Object.freeze(["trace", "flow", "through", "dispatch", "validation", "invoke", "error", "return"]),
    minimum: 2,
    requiredAny: Object.freeze(["trace", "through", "dispatch", "validation", "invoke"]),
  }),
  Object.freeze({
    id: "registry_dispatch",
    terms: Object.freeze(["registry", "registration", "descriptor", "route", "alias", "dispatch"]),
    minimum: 2,
    requiredAny: Object.freeze(["registry", "registration", "descriptor", "route"]),
  }),
  Object.freeze({
    id: "lifecycle_resource",
    terms: Object.freeze(["lifecycle", "generation", "completion", "save", "reconcile", "fallback", "resource", "cleanup"]),
    minimum: 2,
    requiredAny: Object.freeze(["lifecycle", "generation", "completion", "save", "reconcile", "resource", "cleanup"]),
  }),
]);

export const TRAVERSAL_COMPLETION_TRIGGER_TERMS = Object.freeze([
  ...new Set(TRAVERSAL_COMPLETION_LANES.flatMap((lane) => lane.terms)),
]);

const TRAVERSAL_COMPLETION_MODE_VALUES = new Set(["off", "shadow", "on"]);
const TRAVERSAL_COMPLETION_RECIPIENTS = new Set(["researcher", "dev"]);
const TRAVERSAL_COMPLETION_JOB_TYPES = new Set(["research", "dev", "fix"]);

const TRAVERSAL_COMPLETION_DIRECTIVE = [
  "Traversal completion check:",
  "Before finalizing, revisit each function, file window, descriptor block, or wrapper you opened or cite. Do not broaden to unrelated files unless an opened item exposes a named gap.",
  "",
  "- Branches and guards: if you describe one branch, check alternate branches, failures, defaults, and return shapes in the same function.",
  "- Ordered pipelines: if you describe a step sequence, check whether any intermediate validation, deprecation, source-recording, or arbitration step occurs between the steps you named.",
  "- Registries and arrays: if you name one descriptor/route/tool entry, check adjacent entries in the same opened block when the task asks about registration, listing, dispatch, or aliases.",
  "- Wrappers and facades: if you saw a shim/helper, state whether it changes defaults, guards, cache keys/files, aliases, errors, deprecations, or result shape relative to the delegated call.",
  "- Generated/dispatch results: cover consumed inputs and extra/unmatched inputs, plus success and failure/insufficient-parameter paths.",
].join("\n");

export function normalizeTraversalCompletionMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TRAVERSAL_COMPLETION_MODE_VALUES.has(normalized) ? normalized : "off";
}

export function normalizeTraversalCompletionMaxChars(value, fallback = DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function collectTraversalCompletionTaskText(packet = {}) {
  const payload = packet?._raw_payload && typeof packet._raw_payload === "object" ? packet._raw_payload : {};
  const parts = [];
  const push = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return;
    }
    if (typeof value === "object") return;
    const text = String(value).trim();
    if (text) parts.push(text);
  };

  push(packet.title);
  push(packet.job_type);
  push(packet.recipient);
  push(payload.title);
  push(payload.task_spec);
  push(payload.instructions);
  push(payload.fix_instructions);
  push(payload.description);
  push(payload.request);
  push(payload.question);
  push(payload.prompt);
  push(packet.project_context);
  push(packet.instructions);
  push(packet.success_criteria);
  push(payload.success_criteria);

  return parts.join("\n");
}

export function classifyTraversalCompletionTask(packet = {}) {
  const recipient = String(packet?.recipient || "").trim().toLowerCase();
  const jobType = String(packet?.job_type || "").trim().toLowerCase();
  const roleEligible = TRAVERSAL_COMPLETION_RECIPIENTS.has(recipient)
    || TRAVERSAL_COMPLETION_JOB_TYPES.has(jobType);

  if (!roleEligible) {
    return { triggered: false, matchedTerms: [], matchedLanes: [], taskTextChars: 0 };
  }

  const text = collectTraversalCompletionTaskText(packet);
  const lower = text.toLowerCase();
  const termPresent = (term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
  };
  const matchedLanes = [];
  const matchedTerms = new Set();
  for (const lane of TRAVERSAL_COMPLETION_LANES) {
    const terms = lane.terms.filter(termPresent);
    if (terms.length < lane.minimum) continue;
    if (lane.requiredAny && !lane.requiredAny.some((term) => terms.includes(term))) continue;
    matchedLanes.push(lane.id);
    for (const term of terms) matchedTerms.add(term);
  }

  return {
    triggered: matchedLanes.length > 0,
    matchedTerms: [...matchedTerms],
    matchedLanes,
    taskTextChars: text.length,
  };
}

export function renderTraversalCompletionDirective({ maxChars = DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS } = {}) {
  const cap = normalizeTraversalCompletionMaxChars(maxChars);
  if (TRAVERSAL_COMPLETION_DIRECTIVE.length <= cap) return TRAVERSAL_COMPLETION_DIRECTIVE;
  if (cap <= 3) return TRAVERSAL_COMPLETION_DIRECTIVE.slice(0, cap);
  return `${TRAVERSAL_COMPLETION_DIRECTIVE.slice(0, cap - 3)}...`;
}

export function buildTraversalCompletionCheck(packet = {}, opts = {}) {
  const mode = normalizeTraversalCompletionMode(opts.mode);
  const maxChars = normalizeTraversalCompletionMaxChars(opts.maxChars);
  const classification = classifyTraversalCompletionTask(packet);
  const text = classification.triggered && mode !== "off"
    ? renderTraversalCompletionDirective({ maxChars })
    : "";

  return {
    mode,
    triggered: classification.triggered,
    matched_terms: classification.matchedTerms,
    matched_lanes: classification.matchedLanes,
    task_text_chars: classification.taskTextChars,
    max_chars: maxChars,
    rendered_chars: text.length,
    text,
    attach: mode === "on" && classification.triggered,
    shadow: mode === "shadow" && classification.triggered,
  };
}
