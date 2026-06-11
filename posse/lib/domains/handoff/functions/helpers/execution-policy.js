// Deterministic scope/risk policy used to route downstream agent budget.

const TIER_RANK = Object.freeze({ cheap: 0, standard: 1, strong: 2 });
const EFFORT_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
const BUDGET_RANK = Object.freeze({ low: 0, normal: 1, high: 2, xhigh: 3 });

const RISK_TAG_ALIASES = Object.freeze({
  authn: "auth",
  authz: "auth",
  authentication: "auth",
  authorization: "auth",
  credential: "security",
  credentials: "security",
  secret: "security",
  secrets: "security",
  token: "security",
  tokens: "security",
  database: "persistence",
  db: "persistence",
  sql: "persistence",
  storage: "persistence",
  billing: "payment",
  invoice: "payment",
  invoices: "payment",
  money: "payment",
  remove: "delete",
  removal: "delete",
  purge: "delete",
  race: "concurrency",
  locking: "concurrency",
});

const RISK_PATTERNS = Object.freeze([
  ["auth", /\b(auth|oauth|login|session|permission|policy|role|acl)\b/i],
  ["security", /\b(secret|credential|token|password|encrypt|decrypt|key|csrf|xss|security)\b/i],
  ["schema", /\b(schema|ddl|column|table|index|constraint)\b/i],
  ["migration", /\b(migration|migrate|backfill|rollout)\b/i],
  ["persistence", /\b(database|sqlite|postgres|mysql|sql|persist|storage|transaction)\b/i],
  ["delete", /\b(delete|remove|purge|destroy|drop)\b/i],
  ["payment", /\b(payment|billing|invoice|checkout|subscription|refund)\b/i],
  ["concurrency", /\b(concurrency|parallel|race|lock|lease|thread|worker|deadlock)\b/i],
  ["git", /\b(git|merge|branch|commit|rebase|worktree)\b/i],
]);

const CRITICAL_RISK_TAGS = new Set(["auth", "security", "payment", "migration"]);

function normalizeRanked(value, allowed, fallback) {
  const raw = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(allowed, raw) ? raw : fallback;
}

function maxRanked(values, ranks, fallback) {
  let best = fallback;
  for (const value of values) {
    const normalized = normalizeRanked(value, ranks, null);
    if (!normalized) continue;
    if (ranks[normalized] > ranks[best]) best = normalized;
  }
  return best;
}

export function normalizePolicyScore(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(5, parsed));
}

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function normalizeScopeConfidence(value, fallback = "medium") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "hi") return "high";
  if (raw === "med") return "medium";
  if (["high", "medium", "low"].includes(raw)) return raw;
  return fallback;
}

export function normalizeRiskTags(values = []) {
  const source = Array.isArray(values)
    ? values
    : String(values || "").split(/[,;|]/);
  const out = [];
  const seen = new Set();
  for (const value of source) {
    const raw = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    if (!raw) continue;
    const normalized = RISK_TAG_ALIASES[raw] || raw;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collectText(task = {}) {
  return [
    task.title,
    task.task_spec,
    task.instructions,
    task.test_command,
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria]),
    ...(Array.isArray(task.files_to_modify) ? task.files_to_modify : []),
    ...(Array.isArray(task.files_to_create) ? task.files_to_create : []),
    ...(Array.isArray(task.files_to_delete) ? task.files_to_delete : []),
    ...(Array.isArray(task.create_roots) ? task.create_roots : []),
  ].filter(Boolean).join("\n");
}

export function inferRiskTagsFromTask(task = {}) {
  const text = collectText(task);
  const tags = [];
  for (const [tag, pattern] of RISK_PATTERNS) {
    if (pattern.test(text)) tags.push(tag);
  }
  return normalizeRiskTags(tags);
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || "").replace(/\\/g, "/").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function buildTaskStructuralFacts(task = {}, { jobType = "dev", taskMode = "code" } = {}) {
  const filesToModify = uniqueStrings(task.files_to_modify);
  const filesToCreate = uniqueStrings(task.files_to_create);
  const filesToDelete = uniqueStrings(task.files_to_delete);
  const createRoots = uniqueStrings(task.create_roots);
  const uniqueScopeFiles = uniqueStrings([...filesToModify, ...filesToCreate, ...filesToDelete]);
  const isCodeTask = (jobType === "dev" || jobType === "fix") && (taskMode || "code") === "code";
  const broadCreateRoots = createRoots.filter((root) => {
    const normalized = root.replace(/\/+$/, "");
    return !normalized || normalized === "." || normalized === "/" || normalized === "src" || normalized === "lib";
  });

  return {
    job_type: jobType,
    task_mode: taskMode || "code",
    is_code_task: isCodeTask,
    files_to_modify_count: filesToModify.length,
    files_to_create_count: filesToCreate.length,
    files_to_delete_count: filesToDelete.length,
    create_roots_count: createRoots.length,
    broad_create_roots_count: broadCreateRoots.length,
    scope_file_count: uniqueScopeFiles.length,
    has_writable_scope: uniqueScopeFiles.length > 0 || createRoots.length > 0,
    has_test_command: !!String(task.test_command || "").trim(),
  };
}

function scopeBucket(facts) {
  const breadth = facts.scope_file_count + (facts.create_roots_count * 2) + (facts.broad_create_roots_count * 3);
  if (breadth <= 1) return "small";
  if (breadth <= 4) return "medium";
  if (breadth <= 8) return "large";
  return "wide";
}

function riskFloorFromTags(tags) {
  if (tags.some((tag) => CRITICAL_RISK_TAGS.has(tag))) return 5;
  if (tags.includes("schema") || tags.includes("delete") || tags.includes("persistence")) return 4;
  if (tags.includes("concurrency") || tags.includes("git")) return 3;
  return 1;
}

function maxTier(...tiers) {
  return maxRanked(tiers, TIER_RANK, "cheap");
}

function maxEffort(...efforts) {
  return maxRanked(efforts, EFFORT_RANK, "low");
}

function maxBudget(...budgets) {
  return maxRanked(budgets, BUDGET_RANK, "normal");
}

function resolveDevPolicy({
  currentModelTier,
  currentReasoningEffort,
  facts,
  riskScore,
  scopeConfidence,
  riskTags,
}) {
  const bucket = scopeBucket(facts);
  let modelTier = normalizeRanked(currentModelTier, TIER_RANK, "standard");
  let reasoningEffort = normalizeRanked(currentReasoningEffort, EFFORT_RANK, "medium");
  const reasons = [];

  if (riskScore <= 2 && bucket === "small" && facts.has_test_command && scopeConfidence !== "low") {
    modelTier = "cheap";
    reasoningEffort = "low";
    reasons.push("small low-risk tested scope");
  }
  // The tag-derived floor is already folded into riskScore by the caller
  // (including the small/tested softening), so the score is the single
  // authority here — a critical tag must not bypass that softening.
  if (riskScore >= 4) {
    modelTier = maxTier(modelTier, "standard");
    reasoningEffort = maxEffort(reasoningEffort, "high");
    reasons.push("risk floor raised dev reasoning");
  } else if (riskScore >= 3) {
    modelTier = maxTier(modelTier, "standard");
    reasoningEffort = maxEffort(reasoningEffort, "medium");
    reasons.push("medium risk requires standard dev policy");
  }
  if (bucket === "large" || bucket === "wide") {
    reasoningEffort = maxEffort(reasoningEffort, bucket === "wide" ? "high" : "medium");
    reasons.push(`${bucket} scope raises dev tool budget`);
  }
  if (scopeConfidence === "low") {
    modelTier = maxTier(modelTier, "standard");
    reasoningEffort = maxEffort(reasoningEffort, "high");
    reasons.push("low scope confidence");
  }
  if (currentModelTier === "strong") modelTier = "strong";
  if (currentReasoningEffort === "high") reasoningEffort = "high";

  let maxTurnsOverride = null;
  if (facts.scope_file_count >= 10 || facts.create_roots_count >= 3 || bucket === "wide") {
    maxTurnsOverride = 36;
  } else if (facts.scope_file_count >= 6 || facts.create_roots_count >= 2) {
    maxTurnsOverride = 26;
  }

  return {
    model_tier: modelTier,
    reasoning_effort: reasoningEffort,
    max_turns_override: maxTurnsOverride,
    reasons,
  };
}

function resolveAssessorPolicy({
  facts,
  riskScore,
  riskTags,
}) {
  let modelTier = "cheap";
  let reasoningEffort = "low";
  let passConfidenceFloor = null;
  const reasons = [];

  if (riskScore >= 5 || riskTags.some((tag) => CRITICAL_RISK_TAGS.has(tag))) {
    modelTier = "strong";
    reasoningEffort = "high";
    passConfidenceFloor = "high";
    reasons.push("critical risk requires strong assessment and high-confidence pass");
  } else if (riskScore >= 4) {
    modelTier = "standard";
    reasoningEffort = "high";
    passConfidenceFloor = "high";
    reasons.push("high risk requires high-confidence pass");
  } else if (riskScore >= 3) {
    modelTier = "standard";
    reasoningEffort = "medium";
    passConfidenceFloor = "medium";
    reasons.push("medium risk requires standard assessment");
  }

  if (!facts.has_test_command && facts.is_code_task) {
    modelTier = maxTier(modelTier, "standard");
    reasoningEffort = maxEffort(reasoningEffort, "medium");
    if (!passConfidenceFloor) passConfidenceFloor = "medium";
    reasons.push("code task has no registered test command");
  }

  if (facts.scope_file_count >= 6 || facts.create_roots_count >= 2) {
    modelTier = maxTier(modelTier, "standard");
    reasoningEffort = maxEffort(reasoningEffort, "medium");
    reasons.push("broad scope requires standard assessment");
  }

  return {
    model_tier: modelTier,
    reasoning_effort: reasoningEffort,
    pass_confidence_floor: passConfidenceFloor,
    reasons,
  };
}

export function resolveTaskExecutionPolicy({
  task = {},
  jobType = "dev",
  taskMode = "code",
  currentModelTier = "standard",
  currentReasoningEffort = "medium",
} = {}) {
  const facts = buildTaskStructuralFacts(task, { jobType, taskMode });
  const plannerRiskScore = normalizePolicyScore(task.planner_risk_score ?? task.risk, null);
  const plannerVerificationScore = normalizePolicyScore(task.verification_difficulty, null);
  const scopeConfidence = normalizeScopeConfidence(task.scope_confidence, "medium");
  const riskTags = normalizeRiskTags([
    ...normalizeRiskTags(task.risk_tags),
    ...inferRiskTagsFromTask(task),
  ]);
  const structuralRiskFloor = riskFloorFromTags(riskTags);
  // A risk tag alone must not out-rank the planner's own judgment on a
  // small, tested, well-understood scope: a one-file doc-comment fix tagged
  // "security" is not an IDOR fix. Soften the tag floor when the planner
  // scored the task low and the structure agrees it is contained; a real
  // planner score of 3+ always keeps the full floor via the max() below.
  const bucket = scopeBucket(facts);
  const tagFloorSoftened = structuralRiskFloor >= 4
    && (plannerRiskScore ?? 1) <= 2
    && (bucket === "small" || bucket === "medium")
    && facts.has_test_command
    && scopeConfidence !== "low";
  const effectiveRiskFloor = tagFloorSoftened ? 3 : structuralRiskFloor;
  const riskScore = Math.max(plannerRiskScore ?? 1, effectiveRiskFloor);

  const dev = resolveDevPolicy({
    currentModelTier,
    currentReasoningEffort,
    facts,
    riskScore,
    scopeConfidence,
    riskTags,
  });
  const assessor = resolveAssessorPolicy({
    facts,
    riskScore,
    riskTags,
  });

  return {
    version: 1,
    risk_score: riskScore,
    ...(tagFloorSoftened ? { risk_floor_softened: true } : {}),
    planner_risk_score: plannerRiskScore,
    verification_difficulty: plannerVerificationScore,
    scope_confidence: scopeConfidence,
    risk_tags: riskTags,
    structural_facts: facts,
    dev,
    assessor,
  };
}

export function resolvePlannerBudgetFromResearchScope({
  keyFiles = [],
  relatedFiles = [],
  plannerFilePriorities = [],
  scopeEstimate = null,
  currentBudget = "normal",
} = {}) {
  const estimate = scopeEstimate && typeof scopeEstimate === "object" ? scopeEstimate : {};
  const confidence = normalizeScopeConfidence(estimate.confidence ?? estimate.scope_confidence, "medium");
  const likelyTouchCount = parsePositiveInteger(estimate.likely_touch_count, null);
  const keyCount = uniqueStrings(keyFiles).length;
  const relatedCount = uniqueStrings(relatedFiles).length;
  const priorityCount = uniqueStrings(plannerFilePriorities.map((entry) => entry?.path || entry)).length;
  let budget = "normal";
  const reasons = [];

  if (confidence === "low") {
    budget = maxBudget(budget, "xhigh");
    reasons.push("low researcher scope confidence");
  } else if (confidence === "medium") {
    budget = maxBudget(budget, "high");
    reasons.push("medium researcher scope confidence");
  }
  if (likelyTouchCount != null && likelyTouchCount >= 8) {
    budget = maxBudget(budget, "xhigh");
    reasons.push("researcher likely touch count >= 8");
  } else if (likelyTouchCount != null && likelyTouchCount >= 4) {
    budget = maxBudget(budget, "high");
    reasons.push("researcher likely touch count >= 4");
  }
  if (Math.max(keyCount, priorityCount) >= 9 || relatedCount >= 20) {
    budget = maxBudget(budget, "xhigh");
    reasons.push("research scope breadth is wide");
  } else if (Math.max(keyCount, priorityCount) >= 4 || relatedCount >= 10) {
    budget = maxBudget(budget, "high");
    reasons.push("research scope breadth is medium");
  }

  return {
    budget: maxBudget(currentBudget, budget),
    confidence,
    key_file_count: keyCount,
    related_file_count: relatedCount,
    priority_file_count: priorityCount,
    likely_touch_count: likelyTouchCount,
    reasons,
  };
}
