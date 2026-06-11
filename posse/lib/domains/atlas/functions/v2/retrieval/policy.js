// @ts-check
//
// Native ATLAS v2 policy handlers. Policy lives in the v2 ledger so raw-window,
// slice, memory, and runtime decisions do not depend on the original ATLAS server.

import { okEnvelope, errorEnvelope } from "./envelope.js";

export const DEFAULT_ATLAS_POLICY = Object.freeze({
  maxWindowLines: 500,
  maxWindowTokens: 8000,
  requireIdentifiers: true,
  allowBreakGlass: false,
  defaultMinCallConfidence: 0.5,
  defaultDenyRaw: false,
  memoryEnabled: true,
  // Memories untouched for this many days are flagged stale and stop
  // surfacing proactively (0 disables the sweep). Refreshing via memory.store
  // clears the flag.
  memoryStaleAfterDays: 180,
  // Active memories beyond this cap are soft-deleted on write, least valuable
  // first (0 disables). Matches the 5000-row retrieval candidate scan limit:
  // rows past it were unreachable in recency order anyway.
  memoryMaxPerRepo: 5000,
  runtimeEnabled: false,
  budgetCaps: Object.freeze({
    maxCards: 50,
    maxEstimatedTokens: 50_000,
  }),
});

/**
 * @param {{
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").PolicyGetParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function policyGet({ versionId, params = {}, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("policy.get", versionId);
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  return okEnvelope({
    action: "policy.get",
    versionId,
    data: {
      repoId: effectiveRepoId,
      policy: getEffectivePolicy(ledger, effectiveRepoId),
    },
  });
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").PolicySetParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function policySet({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("policy.set", versionId);
  if (params.policyPatch != null && !isPlainObject(params.policyPatch)) {
    return errorEnvelope({
      action: "policy.set",
      versionId,
      code: "invalid_policy_patch",
      message: "policy.set policyPatch must be an object",
    });
  }
  const patch = isPlainObject(params.policyPatch) ? params.policyPatch : {};
  const normalized = normalizePolicyPatch(patch);
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const merged = normalizePolicy({
    ...getEffectivePolicy(ledger, effectiveRepoId),
    ...normalized,
    budgetCaps: {
      ...DEFAULT_ATLAS_POLICY.budgetCaps,
      ...getEffectivePolicy(ledger, effectiveRepoId).budgetCaps,
      ...(normalized.budgetCaps || {}),
    },
  });
  db.prepare(
    `INSERT INTO atlas_policy(repo_id, policy_json, updated_at)
     VALUES(?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       policy_json = excluded.policy_json,
       updated_at = excluded.updated_at`,
  ).run(effectiveRepoId, JSON.stringify(merged), new Date().toISOString());
  return okEnvelope({
    action: "policy.set",
    versionId,
    data: {
      ok: true,
      repoId: effectiveRepoId,
      policy: merged,
    },
  });
}

/**
 * @param {import("../contracts/api.js").Ledger | undefined} ledger
 * @param {string | null | undefined} repoId
 */
export function getEffectivePolicy(ledger, repoId = "default") {
  const db = ledgerDb(ledger);
  if (!db) return { ...DEFAULT_ATLAS_POLICY, budgetCaps: { ...DEFAULT_ATLAS_POLICY.budgetCaps } };
  const row = db.prepare("SELECT policy_json FROM atlas_policy WHERE repo_id = ?").get(effectiveRepo(repoId, null));
  if (!row?.policy_json) return { ...DEFAULT_ATLAS_POLICY, budgetCaps: { ...DEFAULT_ATLAS_POLICY.budgetCaps } };
  try {
    return normalizePolicy({
      ...DEFAULT_ATLAS_POLICY,
      ...JSON.parse(String(row.policy_json)),
    });
  } catch {
    return { ...DEFAULT_ATLAS_POLICY, budgetCaps: { ...DEFAULT_ATLAS_POLICY.budgetCaps } };
  }
}

function ledgerDb(ledger) {
  return typeof /** @type {any} */ (ledger)?._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
}

function ledgerUnavailable(action, versionId) {
  return errorEnvelope({
    action: /** @type {any} */ (action),
    versionId,
    code: "ledger_unavailable",
    message: `${action} requires a ledger-backed ATLAS context`,
  });
}

function effectiveRepo(ctxRepoId, paramRepoId) {
  const text = String(paramRepoId || ctxRepoId || "default").trim();
  return text || "default";
}

function normalizePolicyPatch(patch) {
  const out = {};
  if ("maxWindowLines" in patch) out.maxWindowLines = clampInt(patch.maxWindowLines, 1, 20_000, DEFAULT_ATLAS_POLICY.maxWindowLines);
  if ("maxWindowTokens" in patch) out.maxWindowTokens = clampInt(patch.maxWindowTokens, 1, 200_000, DEFAULT_ATLAS_POLICY.maxWindowTokens);
  if ("requireIdentifiers" in patch) out.requireIdentifiers = !!patch.requireIdentifiers;
  if ("allowBreakGlass" in patch) out.allowBreakGlass = !!patch.allowBreakGlass;
  if ("defaultMinCallConfidence" in patch) out.defaultMinCallConfidence = clampNumber(patch.defaultMinCallConfidence, 0, 1, DEFAULT_ATLAS_POLICY.defaultMinCallConfidence);
  if ("defaultDenyRaw" in patch) out.defaultDenyRaw = !!patch.defaultDenyRaw;
  if ("memoryEnabled" in patch) out.memoryEnabled = !!patch.memoryEnabled;
  if ("memoryStaleAfterDays" in patch) out.memoryStaleAfterDays = clampInt(patch.memoryStaleAfterDays, 0, 3650, DEFAULT_ATLAS_POLICY.memoryStaleAfterDays);
  if ("memoryMaxPerRepo" in patch) out.memoryMaxPerRepo = clampInt(patch.memoryMaxPerRepo, 0, 100_000, DEFAULT_ATLAS_POLICY.memoryMaxPerRepo);
  if ("runtimeEnabled" in patch) out.runtimeEnabled = !!patch.runtimeEnabled;
  if (isPlainObject(patch.budgetCaps)) {
    out.budgetCaps = {};
    if ("maxCards" in patch.budgetCaps) out.budgetCaps.maxCards = clampInt(patch.budgetCaps.maxCards, 1, 500, DEFAULT_ATLAS_POLICY.budgetCaps.maxCards);
    if ("maxEstimatedTokens" in patch.budgetCaps) out.budgetCaps.maxEstimatedTokens = clampInt(patch.budgetCaps.maxEstimatedTokens, 100, 500_000, DEFAULT_ATLAS_POLICY.budgetCaps.maxEstimatedTokens);
  }
  return out;
}

function normalizePolicy(policy) {
  return {
    maxWindowLines: clampInt(policy.maxWindowLines, 1, 20_000, DEFAULT_ATLAS_POLICY.maxWindowLines),
    maxWindowTokens: clampInt(policy.maxWindowTokens, 1, 200_000, DEFAULT_ATLAS_POLICY.maxWindowTokens),
    requireIdentifiers: policy.requireIdentifiers !== false,
    allowBreakGlass: !!policy.allowBreakGlass,
    defaultMinCallConfidence: clampNumber(policy.defaultMinCallConfidence, 0, 1, DEFAULT_ATLAS_POLICY.defaultMinCallConfidence),
    defaultDenyRaw: !!policy.defaultDenyRaw,
    memoryEnabled: policy.memoryEnabled !== false,
    memoryStaleAfterDays: clampInt(policy.memoryStaleAfterDays, 0, 3650, DEFAULT_ATLAS_POLICY.memoryStaleAfterDays),
    memoryMaxPerRepo: clampInt(policy.memoryMaxPerRepo, 0, 100_000, DEFAULT_ATLAS_POLICY.memoryMaxPerRepo),
    runtimeEnabled: !!policy.runtimeEnabled,
    budgetCaps: {
      maxCards: clampInt(policy.budgetCaps?.maxCards, 1, 500, DEFAULT_ATLAS_POLICY.budgetCaps.maxCards),
      maxEstimatedTokens: clampInt(policy.budgetCaps?.maxEstimatedTokens, 100, 500_000, DEFAULT_ATLAS_POLICY.budgetCaps.maxEstimatedTokens),
    },
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
