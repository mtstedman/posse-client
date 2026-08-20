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

/**
 * @param {{ repoRoot: string, purpose: string, targetBranch: string, sourceProof: any, paths?: string[] }} args
 */
export function beginAtlasMainIntake({ repoRoot, purpose, targetBranch, sourceProof, paths = [] }) {
  const previous = readAtlasMainIntakeState(repoRoot);
  const proofOid = String(sourceProof?.git_oid || "").trim().toLowerCase();
  const gitOid = /^[0-9a-f]{40,64}$/u.test(proofOid) ? proofOid : null;
  const canResume = !!(
    gitOid
    && previous
    && RESUMABLE_STATUSES.has(previous.status)
    && previous.target_branch === targetBranch
    && previous.git_oid === gitOid
  );
  const now = new Date().toISOString();
  const normalizedPaths = Array.isArray(paths)
    ? paths.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const previousSkipped = canResume && Array.isArray(previous?.result?.skipped?.items)
    ? previous.result.skipped.items.map((row) => String(row?.repo_rel_path || "").trim()).filter(Boolean)
    : [];
  const repeatScope = canResume && previous.status !== "partial"
    ? (Array.isArray(previous?.scope?.paths) ? previous.scope.paths : [])
    : [];
  const resumePaths = [...new Set([...repeatScope, ...previousSkipped].filter((value) => value !== "."))];
  const resumeRepository = !!(canResume && (
    (previous.status !== "partial" && previous?.scope?.kind === "repository")
    || previous?.scope?.paths_truncated === true
    || previous?.result?.skipped?.truncated === true
    || previous?.result?.truncated === true
    || !!previous?.result?.rebuild_required
    || (previous.status === "partial"
      && previous?.result?.generation_proof_reason !== "clean_exact_oid_before_after")
    || previousSkipped.includes(".")
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
