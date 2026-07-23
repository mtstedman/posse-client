const PENDING_FILE_REQUESTS_KEY = "_assess_pending_file_requests";
const FILE_REQUEST_RISKS = new Set(["low", "mid", "high"]);

function normalizeRequest(value, fallbackRisk) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = String(value.path || "").trim().replace(/\\/g, "/");
  if (!path) return null;
  const reason = String(value.reason || "").trim();
  const rawRisk = String(value.risk || "").trim().toLowerCase();
  const risk = FILE_REQUEST_RISKS.has(rawRisk) ? rawRisk : fallbackRisk;
  return {
    path,
    ...(reason ? { reason } : {}),
    risk,
  };
}

function normalizeGroup(values, fallbackRisk) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeRequest(value, fallbackRisk))
    .filter(Boolean);
}

export function normalizePendingAssessmentFileRequests(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const autoApproved = normalizeGroup(value.autoApproved, "mid");
  const needsApproval = normalizeGroup(value.needsApproval, "high");
  if (autoApproved.length === 0 && needsApproval.length === 0) return null;
  return { autoApproved, needsApproval };
}

export function persistPendingAssessmentFileRequests(payload, pendingFileRequests) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const normalized = normalizePendingAssessmentFileRequests(pendingFileRequests);
  if (normalized) payload[PENDING_FILE_REQUESTS_KEY] = normalized;
  else delete payload[PENDING_FILE_REQUESTS_KEY];
  return normalized;
}

export function readPendingAssessmentFileRequests(payload) {
  return normalizePendingAssessmentFileRequests(payload?.[PENDING_FILE_REQUESTS_KEY]);
}

export function clearPendingAssessmentFileRequests(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, PENDING_FILE_REQUESTS_KEY)) return false;
  delete payload[PENDING_FILE_REQUESTS_KEY];
  return true;
}

export function flattenPendingAssessmentFileRequests(pendingFileRequests) {
  const normalized = normalizePendingAssessmentFileRequests(pendingFileRequests);
  if (!normalized) return [];
  return [...normalized.autoApproved, ...normalized.needsApproval];
}

export function shouldDeferAssessmentToFileRequestContinuation({
  pendingFileRequests,
  hasFileChanges,
  autoApprove = false,
} = {}) {
  const normalized = normalizePendingAssessmentFileRequests(pendingFileRequests);
  if (!normalized) return false;
  if (!hasFileChanges) return true;
  return normalized.needsApproval.length === 0 || autoApprove === true;
}
