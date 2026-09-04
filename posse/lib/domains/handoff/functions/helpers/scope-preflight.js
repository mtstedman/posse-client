// lib/domains/handoff/functions/helpers/scope-preflight.js
//
// Deterministic scope preflight checks for handoff packets.

export function hasWritableScope(scope = {}) {
  const filesToModify = Array.isArray(scope?.files_to_modify) ? scope.files_to_modify : [];
  const filesToCreate = Array.isArray(scope?.files_to_create) ? scope.files_to_create : [];
  const filesToDelete = Array.isArray(scope?.files_to_delete) ? scope.files_to_delete : [];
  const createRoots = Array.isArray(scope?.create_roots) ? scope.create_roots : [];
  return filesToModify.length > 0
    || filesToCreate.length > 0
    || filesToDelete.length > 0
    || createRoots.length > 0;
}

function hasExplicitFileScope(scope = {}) {
  const filesToModify = Array.isArray(scope?.files_to_modify) ? scope.files_to_modify : [];
  const filesToCreate = Array.isArray(scope?.files_to_create) ? scope.files_to_create : [];
  const filesToDelete = Array.isArray(scope?.files_to_delete) ? scope.files_to_delete : [];
  return filesToModify.length > 0 || filesToCreate.length > 0 || filesToDelete.length > 0;
}

function hasNonWildcardCreateRoot(scope = {}) {
  const createRoots = Array.isArray(scope?.create_roots) ? scope.create_roots : [];
  return createRoots.some((root) => {
    const normalized = String(root || "").replace(/\\/g, "/").trim().replace(/\/+$/, "");
    return normalized && normalized !== "." && normalized !== "*";
  });
}

export function isZeroEditCodeTask(scope = {}) {
  const taskMode = scope?.task_mode || scope?._raw_payload?.task_mode || "code";
  const jobType = scope?.job_type || "";
  return (jobType === "dev" || jobType === "fix")
    && taskMode === "code"
    && !hasExplicitFileScope(scope)
    && !hasNonWildcardCreateRoot(scope);
}

export function assertHandoffScopePreflight(packet) {
  if (!isZeroEditCodeTask(packet)) return;
  const label = packet.title ? ` "${packet.title}"` : "";
  const error = new Error(
    `handoff preflight failed: ${packet.job_type} code task${label} has no writable scope; reroute this verification-only work to artificer/report`
  );
  error.code = "HANDOFF_ZERO_WRITABLE_SCOPE";
  error.handoffNeedsReplan = true;
  throw error;
}

export function buildScopePlausibilityWarning(packet = {}) {
  const taskMode = packet?.task_mode || packet?._raw_payload?.task_mode || "code";
  if (!["dev", "fix"].includes(packet?.job_type) || taskMode !== "code") return null;
  const filesToModify = Array.isArray(packet.files_to_modify) ? packet.files_to_modify : [];
  const filesToCreate = Array.isArray(packet.files_to_create) ? packet.files_to_create : [];
  const filesToDelete = Array.isArray(packet.files_to_delete) ? packet.files_to_delete : [];
  const createRoots = Array.isArray(packet.create_roots) ? packet.create_roots : [];
  const scopeCount = filesToModify.length + filesToCreate.length + filesToDelete.length + createRoots.length;
  // The planner already recommends splitting above eight exact paths. Keep
  // the warning active throughout that normal task range; the live incident
  // that prompted this guard began with five paths and still discovered four
  // more one at a time.
  if (scopeCount === 0 || scopeCount > 8 || createRoots.includes(".")) return null;

  const payload = packet?._raw_payload || {};
  const text = [
    packet.title || "",
    payload.title || "",
    payload.task_spec || "",
    payload.instructions || "",
    ...(Array.isArray(payload.success_criteria) ? payload.success_criteria : [payload.success_criteria || ""]),
  ].join("\n").toLowerCase();

  const broad = /\b(review|audit|ux|ui|flow|forms?|pages?|sitewide|cross[- ]page|all|every|overall|polish|glow[- ]?up|high value|edge cases?)\b/.test(text);
  if (!broad) return null;

  return [
    "SCOPE PLAUSIBILITY WARNING:",
    `This task sounds broad, but writable scope is narrow (${scopeCount} path${scopeCount === 1 ? "" : "s"}).`,
    "Do not compensate by editing adjacent files outside scope.",
    "Before editing, inspect the relevant dependencies and read-only references to identify every additional writable path you expect to need.",
    "If scope is incomplete, call request_scope once with one requests[] batch containing every exact path and reason; do not trigger one approval per edit.",
  ].join("\n");
}
