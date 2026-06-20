// @ts-check
//
// Advisory sidecar metadata for staged `.scip` files. The ledger tracks what
// was ingested; this file tracks what produced the on-disk staging artifact so
// the stager can make a cheap freshness decision before ingest runs.

import crypto from "crypto";
import fs from "fs";
import path from "path";

export const SCIP_STAGER_META_SCHEMA_VERSION = 1;
const LEGACY_TIMEOUT_HASH_VALUES = Object.freeze([
  0,
  120_000,
  300_000,
  360_000,
  600_000,
  1_800_000,
]);

/**
 * @param {string} outputPath
 * @returns {string}
 */
export function stagerMetaPathForOutput(outputPath) {
  const text = String(outputPath || "");
  if (/\.scip$/iu.test(text)) return text.replace(/\.scip$/iu, ".meta.json");
  return `${text}.meta.json`;
}

/**
 * @param {string} outputPath
 * @returns {Promise<Record<string, any> | null>}
 */
export async function readStagerMeta(outputPath) {
  const metaPath = stagerMetaPathForOutput(outputPath);
  try {
    const raw = await fs.promises.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const RENAME_RETRYABLE_WIN_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Atomic-rename a temp file onto its destination, retrying the Windows-only
 * transient failure where a just-written dest is briefly held open by a scanner/
 * indexer or is delete-pending and the rename returns EPERM/EBUSY/EACCES instead
 * of succeeding. POSIX renames don't hit this, so only win32 retries; everything
 * else (and exhausted retries) throws as before.
 *
 * @param {string} from
 * @param {string} to
 * @param {{ attempts?: number, baseDelayMs?: number, rename?: (from: string, to: string) => Promise<void>, platform?: string }} [opts]
 */
export async function renameWithWindowsRetry(from, to, {
  attempts = 5,
  baseDelayMs = 40,
  rename = fs.promises.rename,
  platform = process.platform,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const retryable = platform === "win32" && RENAME_RETRYABLE_WIN_CODES.has(err?.code);
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((resolve) => { setTimeout(resolve, baseDelayMs * attempt); });
    }
  }
}

/**
 * @param {string} outputPath
 * @param {Record<string, any>} meta
 * @returns {Promise<{ ok: boolean, path: string, error?: string }>}
 */
export async function writeStagerMeta(outputPath, meta) {
  const metaPath = stagerMetaPathForOutput(outputPath);
  const dir = path.dirname(metaPath);
  const tmpPath = path.join(dir, `.${path.basename(metaPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await renameWithWindowsRetry(tmpPath, metaPath);
    return { ok: true, path: metaPath };
  } catch (err) {
    try { await fs.promises.rm(tmpPath, { force: true }); } catch { /* best effort */ }
    return { ok: false, path: metaPath, error: err?.message || String(err) };
  }
}

function commandArgsHashPayload(plan, { includeTimeout = false, timeoutMs = 0 } = {}) {
  const payload = {
    command: String(plan?.command || ""),
    args: Array.isArray(plan?.args) ? plan.args.map((arg) => String(arg)) : [],
    label: String(plan?.label || ""),
    indexer_id: String(plan?.indexerId || ""),
    command_source: String(plan?.commandSource || ""),
  };
  if (includeTimeout) payload.timeout_ms = Number(timeoutMs) || 0;
  return payload;
}

function sha256Json(payload) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

/**
 * @param {{ command?: string, args?: string[], label?: string, indexerId?: string, commandSource?: string }} plan
 * @returns {string}
 */
export function computeCommandArgsHash(plan) {
  return sha256Json(commandArgsHashPayload(plan));
}

function computeLegacyTimeoutCommandArgsHash(plan, timeoutMs) {
  return sha256Json(commandArgsHashPayload(plan, { includeTimeout: true, timeoutMs }));
}

function commandArgsHashMatches(metaHash, plan) {
  const actual = String(metaHash || "");
  if (!actual) return false;
  if (actual === computeCommandArgsHash(plan)) return true;
  const legacyTimeouts = new Set([
    Number(plan?.commandArgsHashTimeoutMs),
    Number(plan?.timeoutMs),
    ...LEGACY_TIMEOUT_HASH_VALUES,
  ].filter((value) => Number.isFinite(value) && value >= 0).map((value) => Math.floor(value)));
  for (const timeoutMs of legacyTimeouts) {
    if (actual === computeLegacyTimeoutCommandArgsHash(plan, timeoutMs)) return true;
  }
  return false;
}

/**
 * @param {{ indexerId?: string, label?: string, command?: string, commandSource?: string }} plan
 * @param {{ head?: string | null, commandArgsHash?: string | null, filesetHash?: string | null, durationMs?: number | null }} input
 * @returns {Record<string, any>}
 */
export function buildStagerMeta(plan, { head = null, commandArgsHash = null, filesetHash = null, durationMs = null } = {}) {
  const language = String(plan?.indexerId || "configured").trim() || "configured";
  const duration = Number(durationMs);
  return {
    schema_version: SCIP_STAGER_META_SCHEMA_VERSION,
    status: "staged",
    language,
    head: head || null,
    staged_at: new Date().toISOString(),
    indexer_command: String(plan?.command || ""),
    indexer_command_label: String(plan?.label || ""),
    command_source: String(plan?.commandSource || ""),
    command_args_hash: commandArgsHash || computeCommandArgsHash(plan),
    fileset_hash: filesetHash || null,
    // How long the indexer actually ran. Restage timeouts size off this so a
    // language whose full index is known to take minutes is never killed by a
    // generic default. null when the meta was refreshed without a run.
    staged_duration_ms: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
  };
}

/**
 * Metadata for an orphaned `.staging` file that was promoted to canonical.
 * It intentionally does not claim freshness; smart policy must re-run the
 * indexer against the current fileset before treating the artifact as current.
 *
 * @param {{ indexerId?: string, label?: string, command?: string, commandSource?: string }} plan
 * @param {{ head?: string | null, commandArgsHash?: string | null }} input
 * @returns {Record<string, any>}
 */
export function buildRecoveredStagerMeta(plan, { head = null, commandArgsHash = null } = {}) {
  const language = String(plan?.indexerId || "configured").trim() || "configured";
  return {
    schema_version: SCIP_STAGER_META_SCHEMA_VERSION,
    status: "recovered",
    language,
    head: head || null,
    recovered_at: new Date().toISOString(),
    indexer_command: String(plan?.command || ""),
    indexer_command_label: String(plan?.label || ""),
    command_source: String(plan?.commandSource || ""),
    command_args_hash: commandArgsHash || computeCommandArgsHash(plan),
    fileset_hash: null,
    recovery_reason: "orphan_staging",
  };
}

/**
 * @param {{ indexerId?: string, label?: string, command?: string, commandSource?: string }} plan
 * @param {{ head?: string | null, commandArgsHash?: string | null, filesetHash?: string | null, error?: string | null, reason?: string | null, previousMeta?: Record<string, any> | null, durationMs?: number | null }} input
 * @returns {Record<string, any>}
 */
export function buildFailedStagerMeta(plan, {
  head = null,
  commandArgsHash = null,
  filesetHash = null,
  error = null,
  reason = null,
  previousMeta = null,
  durationMs = null,
} = {}) {
  const language = String(plan?.indexerId || "configured").trim() || "configured";
  const previousAttempts = Number(previousMeta?.attempt_count || 0);
  const previousStaged = stagedSnapshotFromMeta(previousMeta);
  const duration = Number(durationMs);
  return {
    schema_version: SCIP_STAGER_META_SCHEMA_VERSION,
    status: "failed",
    language,
    head: head || null,
    failed_at: new Date().toISOString(),
    attempt_count: Number.isFinite(previousAttempts) && previousAttempts > 0 ? Math.floor(previousAttempts) + 1 : 1,
    indexer_command: String(plan?.command || ""),
    indexer_command_label: String(plan?.label || ""),
    command_source: String(plan?.commandSource || ""),
    command_args_hash: commandArgsHash || computeCommandArgsHash(plan),
    fileset_hash: filesetHash || null,
    failure_reason: reason || null,
    error: error || null,
    failed_after_ms: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    previous_staged: previousStaged,
  };
}

/**
 * @param {any} meta
 * @param {{ head?: string | null, filesetHash?: string | null, previousFilesetHash?: string | null, plan?: any, maxAgeHours?: number | null, nowMs?: number }} input
 * @returns {{ current: boolean, reason: string }}
 */
export function metaIsCurrent(meta, { head = null, filesetHash = null, previousFilesetHash = null, plan, maxAgeHours = null, nowMs = Date.now() } = {}) {
  if (!meta || typeof meta !== "object") return { current: false, reason: "missing_meta" };
  if (Number(meta.schema_version) !== SCIP_STAGER_META_SCHEMA_VERSION) {
    return { current: false, reason: "schema_version" };
  }
  const status = String(meta.status || "staged").trim().toLowerCase();
  if (status === "failed") {
    const previous = meta.previous_staged && typeof meta.previous_staged === "object" ? meta.previous_staged : null;
    if (previous) {
      const previousFresh = metaIsCurrent(previous, { head, filesetHash, previousFilesetHash, plan, maxAgeHours, nowMs });
      if (previousFresh.current) return { current: true, reason: "fresh_after_failed_restage" };
    }
    return { current: false, reason: "previous_failure" };
  }
  if (status && status !== "staged") return { current: false, reason: `status_${status}` };
  if (!commandArgsHashMatches(meta.command_args_hash, plan)) {
    return { current: false, reason: "command_changed" };
  }
  const currentFilesetHash = String(filesetHash || "");
  if (currentFilesetHash) {
    const metaFilesetHash = String(meta.fileset_hash || previousFilesetHash || "");
    if (!metaFilesetHash) return { current: false, reason: "missing_fileset_hash" };
    if (metaFilesetHash !== currentFilesetHash) return { current: false, reason: "fileset_changed" };
  } else if (head && String(meta.head || "") !== String(head)) {
    return { current: false, reason: "head_changed" };
  }
  const maxAge = Number(maxAgeHours);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    const stagedAt = Date.parse(String(meta.staged_at || ""));
    if (!Number.isFinite(stagedAt)) return { current: false, reason: "missing_staged_at" };
    if (stagedAt + maxAge * 60 * 60 * 1000 < nowMs) {
      return { current: false, reason: "max_age" };
    }
  }
  return { current: true, reason: "fresh" };
}

function stagedSnapshotFromMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const status = String(meta.status || "staged").trim().toLowerCase();
  if (status === "failed") {
    return meta.previous_staged && typeof meta.previous_staged === "object"
      ? stagedSnapshotFromMeta(meta.previous_staged)
      : null;
  }
  if (status && status !== "staged") return null;
  return {
    schema_version: Number(meta.schema_version) || SCIP_STAGER_META_SCHEMA_VERSION,
    status: "staged",
    language: String(meta.language || ""),
    head: meta.head || null,
    staged_at: meta.staged_at || null,
    indexer_command: String(meta.indexer_command || ""),
    indexer_command_label: String(meta.indexer_command_label || ""),
    command_source: String(meta.command_source || ""),
    command_args_hash: meta.command_args_hash || null,
    fileset_hash: meta.fileset_hash || null,
    staged_duration_ms: Number(meta.staged_duration_ms) > 0 ? Math.round(Number(meta.staged_duration_ms)) : null,
  };
}
