// @ts-check
//
// Durable lifecycle record for the repository main-index intake. The semantic
// ledger/view remains the indexed data; this small atomic record explains
// whether an exact source pin is running, complete, partial, failed, or was
// interrupted so a later warm can resume/recheck deliberately.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { atlasDir } from "./runtime-paths.js";
import { ATLAS_MAIN_GENERATION_PUBLISHED_PROOF_REASONS } from "./contracts/jobs.js";

const SCHEMA_VERSION = 1;
const TERMINAL_STATUSES = new Set(["complete", "partial", "failed", "interrupted"]);
const RESUMABLE_STATUSES = new Set(["running", "partial", "failed", "interrupted"]);
const MAX_PATHS = 200;
const MAX_SKIPS = 200;

export function mainIntakeStatePath(repoRoot) {
  return path.join(atlasDir(repoRoot), "intake", "main.json");
}

function capText(value, max = 700) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (exclusive) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* rename consumed it or the write failed */ }
  }
}

export function readAtlasMainIntakeState(repoRoot) {
  const value = readJson(mainIntakeStatePath(repoRoot));
  if (!value || value.schema_version !== SCHEMA_VERSION || typeof value.attempt_id !== "string") return null;
  return value;
}

export function mainIntakeRecheckRequestPath(repoRoot) {
  return path.join(atlasDir(repoRoot), "intake", "main.recheck.json");
}

/**
 * A pending request that the next main intake recheck the whole repository.
 * It lives beside the intake record, so attempts rewriting that record cannot
 * drop it, and it exists even before the first intake.
 */
export function readAtlasMainRecheckRequest(repoRoot) {
  const value = readJson(mainIntakeRecheckRequestPath(repoRoot));
  if (!value || value.schema_version !== SCHEMA_VERSION || typeof value.request_id !== "string") return null;
  return value;
}

/** @param {any} request @param {string} targetBranch */
export function atlasMainRecheckRequestApplies(request, targetBranch) {
  return !!request && (!request.target_branch || request.target_branch === targetBranch);
}

/**
 * Record that source changed without hinting a main warm (for example while a
 * session host lease suppressed ATLAS emission). The next main intake for the
 * target branch takes it over as `resume.repository_recheck`.
 *
 * @param {string} repoRoot
 * @param {{ targetBranch?: string | null, reason: string }} args
 */
export function requestAtlasMainRepositoryRecheck(repoRoot, { targetBranch = null, reason }) {
  const existing = readAtlasMainRecheckRequest(repoRoot);
  const branch = targetBranch ? String(targetBranch) : null;
  const request = {
    schema_version: SCHEMA_VERSION,
    request_id: randomUUID(),
    // Two requests for different branches widen to any branch.
    target_branch: existing && existing.target_branch !== branch ? null : branch,
    requested_at: new Date().toISOString(),
    reasons: [...new Set([
      ...(Array.isArray(existing?.reasons) ? existing.reasons : []),
      capText(reason || "unspecified", 120),
    ])].slice(-8),
  };
  writeJsonAtomic(mainIntakeRecheckRequestPath(repoRoot), request);
  return request;
}

function consumeAtlasMainRecheckRequest(repoRoot, request) {
  // A request written after this attempt read the old one stays pending.
  if (readAtlasMainRecheckRequest(repoRoot)?.request_id !== request.request_id) return;
  try { fs.unlinkSync(mainIntakeRecheckRequestPath(repoRoot)); } catch { /* already consumed */ }
}

function cleanPaths(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

/**
 * `sourceDelta` lists the paths that changed between the last published
 * generation and this source pin (`repository_recheck` when they could not be
 * listed); the warm indexes them beside its hint paths.
 *
 * @param {{
 *   repoRoot: string,
 *   purpose: string,
 *   targetBranch: string,
 *   sourceProof: any,
 *   paths?: string[],
 *   sourceDelta?: { paths?: string[], repository_recheck?: boolean } | null,
 * }} args
 */
export function beginAtlasMainIntake({ repoRoot, purpose, targetBranch, sourceProof, paths = [], sourceDelta = null }) {
  const previous = readAtlasMainIntakeState(repoRoot);
  const proofOid = String(sourceProof?.git_oid || "").trim().toLowerCase();
  const gitOid = /^[0-9a-f]{40,64}$/u.test(proofOid) ? proofOid : null;
  const unfinished = !!(
    previous
    && RESUMABLE_STATUSES.has(previous.status)
    && previous.target_branch === targetBranch
  );
  const canResume = !!(unfinished && gitOid && previous.git_oid === gitOid);
  // An unfinished attempt's work is not discharged by a later source pin: it
  // carries forward, and the whole repository is rechecked because the pin
  // moved under that work. An attempt without a proven pin cannot publish, so
  // it keeps the paths but leaves the recheck to the next proven attempt,
  // which inherits it from this one (itself unfinished).
  const carriesToNewPin = unfinished && !canResume && !!gitOid;
  const now = new Date().toISOString();
  const normalizedPaths = cleanPaths(paths);
  const previousSkipped = unfinished && Array.isArray(previous?.result?.skipped?.items)
    ? cleanPaths(previous.result.skipped.items.map((row) => row?.repo_rel_path))
    : [];
  const repeatScope = unfinished && previous.status !== "partial"
    ? cleanPaths(previous?.scope?.paths)
    : [];
  // Work this unfinished attempt itself inherited and never closed.
  const pendingResume = unfinished ? cleanPaths(previous?.resume?.paths) : [];
  const resumePaths = [...new Set([
    ...repeatScope,
    ...previousSkipped,
    ...pendingResume,
    ...cleanPaths(sourceDelta?.paths),
  ].filter((value) => value !== "."))];
  const recheckRequest = readAtlasMainRecheckRequest(repoRoot);
  const recheckRequested = atlasMainRecheckRequestApplies(recheckRequest, targetBranch);
  const resumeRepository = carriesToNewPin
    || recheckRequested
    || sourceDelta?.repository_recheck === true
    || !!(canResume && (
      (previous.status !== "partial" && previous?.scope?.kind === "repository")
      || previous?.scope?.paths_truncated === true
      || previous?.result?.skipped?.truncated === true
      || previous?.result?.truncated === true
      || !!previous?.result?.rebuild_required
      || (previous.status === "partial"
        && !ATLAS_MAIN_GENERATION_PUBLISHED_PROOF_REASONS.includes(previous?.result?.generation_proof_reason))
      || previousSkipped.includes(".")
      || previous?.resume?.repository_recheck === true
      || previous?.resume?.paths_truncated === true
    ));
  const state = {
    schema_version: SCHEMA_VERSION,
    attempt_id: canResume ? previous.attempt_id : randomUUID(),
    status: "running",
    purpose: String(purpose || "main-incremental"),
    target_branch: String(targetBranch || ""),
    git_oid: gitOid,
    source_proof: sourceProof?.ok
      ? { ok: true, reason: null }
      : { ok: false, reason: String(sourceProof?.reason || "source_proof_unavailable") },
    started_at: canResume ? previous.started_at : now,
    last_started_at: now,
    finished_at: null,
    resume_count: canResume ? Number(previous.resume_count || 0) + 1 : 0,
    resumed_from_status: canResume ? previous.status : null,
    scope: {
      kind: normalizedPaths.length > 0 ? "paths" : "repository",
      path_count: normalizedPaths.length,
      paths: normalizedPaths.slice(0, MAX_PATHS),
      paths_truncated: normalizedPaths.length > MAX_PATHS,
    },
    resume: {
      repository_recheck: resumeRepository,
      paths: resumePaths.slice(0, MAX_PATHS),
      paths_truncated: resumePaths.length > MAX_PATHS,
    },
    generation: null,
    result: null,
    error: null,
    supersedes_attempt_id: !canResume && previous ? previous.attempt_id : null,
  };
  writeJsonAtomic(mainIntakeStatePath(repoRoot), state);
  // This attempt now owns the recheck; if it does not complete, its resume
  // state carries the recheck to the next attempt.
  if (recheckRequested) consumeAtlasMainRecheckRequest(repoRoot, recheckRequest);
  return state;
}

function summarizedSkips(result) {
  const rows = Array.isArray(result?.skipped) ? result.skipped : [];
  return {
    count: rows.length,
    truncated: rows.length > MAX_SKIPS,
    items: rows.slice(0, MAX_SKIPS).map((row) => ({
      repo_rel_path: capText(row?.repo_rel_path, 500),
      reason: capText(row?.reason, 120),
      message: capText(row?.message, 700),
    })),
  };
}

/**
 * @param {{ repoRoot: string, intake: any, status: "complete" | "partial" | "failed" | "interrupted", result?: any, error?: any }} args
 */
export function finishAtlasMainIntake({ repoRoot, intake, status, result = null, error = null }) {
  if (!TERMINAL_STATUSES.has(status)) throw new TypeError(`invalid ATLAS main intake status '${status}'`);
  const current = readAtlasMainIntakeState(repoRoot);
  if (!current || current.attempt_id !== intake?.attempt_id) {
    throw new Error("ATLAS main intake closeout does not own the current durable attempt");
  }
  const finished = {
    ...current,
    status,
    finished_at: new Date().toISOString(),
    generation: result?.generation || null,
    result: result ? {
      paths_considered: Number(result.paths_considered) || 0,
      paths_indexed: Number(result.paths_indexed) || 0,
      blobs_ingested: Number(result.blobs_ingested) || 0,
      blobs_reused: Number(result.blobs_reused) || 0,
      ledger_entries_appended: Number(result.ledger_entries_appended) || 0,
      view_written: !!result.view_written,
      truncated: result.truncated === true,
      rebuild_required: result.rebuild_required || null,
      generation_proof_reason: result.generation_proof_reason || null,
      skipped: summarizedSkips(result),
    } : null,
    error: error ? {
      name: error?.name || null,
      code: error?.code || error?.errno || null,
      message: capText(error?.message || String(error), 700),
    } : null,
  };
  writeJsonAtomic(mainIntakeStatePath(repoRoot), finished);
  return finished;
}

export function writeAtlasMainIntakeSnapshot(repoRoot, state) {
  if (!state || state.schema_version !== SCHEMA_VERSION || typeof state.attempt_id !== "string") {
    throw new TypeError("invalid ATLAS main intake snapshot state");
  }
  const file = mainIntakeStatePath(repoRoot);
  writeJsonAtomic(file, state, { exclusive: true });
  return file;
}
