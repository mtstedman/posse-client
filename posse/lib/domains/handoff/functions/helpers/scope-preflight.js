// lib/handoff/helpers/scope-preflight.js
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
  throw new Error(
    `handoff preflight failed: ${packet.job_type} code task${label} has no writable scope; reroute this verification-only work to artificer/report`
  );
}

export function buildScopePlausibilityWarning(packet = {}) {
  const taskMode = packet?.task_mode || packet?._raw_payload?.task_mode || "code";
  if (!["dev", "fix"].includes(packet?.job_type) || taskMode !== "code") return null;
  const filesToModify = Array.isArray(packet.files_to_modify) ? packet.files_to_modify : [];
  const filesToCreate = Array.isArray(packet.files_to_create) ? packet.files_to_create : [];
  const createRoots = Array.isArray(packet.create_roots) ? packet.create_roots : [];
  const scopeCount = filesToModify.length + filesToCreate.length + createRoots.length;
  if (scopeCount === 0 || scopeCount > 2 || createRoots.includes(".")) return null;

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
    "If a required fix lives outside the listed writable paths, use FILE_REQUEST/MISSING_CONTEXT with exact files and why they are necessary.",
  ].join("\n");
}
