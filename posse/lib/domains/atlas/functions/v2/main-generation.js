// @ts-check
//
// Exact main-generation publication. Every owner that materializes the main
// view must use this boundary so the source proof, warm, and publication are
// fenced by the same canonical root-worktree lock.

import path from "path";

import { View } from "../../classes/v2/View.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import {
  acquireWorktreeLockAsync,
  worktreeLockPath,
} from "../../../git/functions/worktree-locks.js";
import {
  beginAtlasMainIntake,
  finishAtlasMainIntake,
  readAtlasMainIntakeState,
} from "./main-intake-state.js";
import { ATLAS_MAIN_GENERATION_ACCOUNTED_SKIP_REASONS } from "./contracts/jobs.js";
import { normalizeTreeCompressionMode } from "./tree-compression-policy.js";
import { inspectViewMaterialization } from "./view-health.js";

const MAIN_GENERATION_PURPOSES = new Set(["main-incremental", "main-full", "main-merge"]);
const ACCOUNTED_SKIP_REASONS = new Set(ATLAS_MAIN_GENERATION_ACCOUNTED_SKIP_REASONS);

function capString(value, max = 700) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function proofError(err) {
  return {
    name: err?.name || null,
    code: err?.code || err?.errno || null,
    message: capString(err?.message || String(err)),
  };
}

function isAbortError(err) {
  return !!(err?._killReason
    || err?.name === "AbortError"
    || err?.code === "ABORT_ERR"
    || err?.code === "THREAD_ABORTED"
    || err?.code === "DAEMON_ABORTED"
    || err?.code === "DAEMON_TRANSPORT_GONE");
}

function intakeTerminalStatus(result) {
  if (result?.generation) return "complete";
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const whollyFailed = !result?.view_written
    && Number(result?.paths_indexed || 0) === 0
    && skipped.length > 0
    && skipped.every((row) => row?.reason === "parse_error");
  return whollyFailed ? "failed" : "partial";
}

export function isAtlasMainGenerationPurpose(purpose) {
  return MAIN_GENERATION_PURPOSES.has(String(purpose || ""));
}

/**
 * Inspect one side of the source-read proof. The caller must hold the
 * canonical root worktree lock across both the before and after calls.
 *
 * @param {{ repoRoot: string, targetBranch: string, expectedGitOid?: string | null, signal?: AbortSignal | null }} args
 */
export async function inspectAtlasMainSourceProof({ repoRoot, targetBranch, expectedGitOid = null, signal = null }) {
  const branch = String(targetBranch || "").trim();
  if (!branch) return { ok: false, reason: "target_branch_missing" };
  try {
    const targetOid = String(await gitExecAsync(
      ["rev-parse", "--verify", `${branch}^{commit}`],
      repoRoot,
      { signal, timeoutMs: 30_000 },
    )).trim().toLowerCase();
    const headOid = String(await gitExecAsync(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      repoRoot,
      { signal, timeoutMs: 30_000 },
    )).trim().toLowerCase();
    const status = String(await gitExecAsync(
      ["status", "--porcelain", "--untracked-files=all"],
      repoRoot,
      { signal, timeoutMs: 30_000 },
    )).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(targetOid)) return { ok: false, reason: "target_oid_invalid" };
    if (expectedGitOid && targetOid !== String(expectedGitOid).trim().toLowerCase()) {
      return { ok: false, reason: "target_oid_changed", target_branch: branch, git_oid: targetOid };
    }
    if (headOid !== targetOid) {
      return { ok: false, reason: "source_head_not_target", target_branch: branch, git_oid: targetOid };
    }
    if (status) {
      return { ok: false, reason: "source_root_dirty", target_branch: branch, git_oid: targetOid };
    }
    return { ok: true, reason: null, target_branch: branch, git_oid: targetOid };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { ok: false, reason: "source_proof_unavailable", error: proofError(err) };
  }
}

/**
 * Hold the canonical root mutation lock while a main warm owner observes and
 * consumes source. The warm still runs when proof is unavailable, but receives
 * a failed proof and therefore cannot publish an exact generation.
 *
 * @template T
 * @param {{
 *   repoRoot: string,
 *   targetBranch: string,
 *   expectedGitOid?: string | null,
 *   signal?: AbortSignal | null,
 *   lockWaitMs?: number,
 *   run: (sourceProof: any, lock: { held: boolean }) => Promise<T>,
 * }} args
 * @returns {Promise<T>}
 */
export async function withAtlasMainSourceProofLock({
  repoRoot,
  targetBranch,
  expectedGitOid = null,
  signal = null,
  lockWaitMs = 30_000,
  run,
}) {
  if (typeof run !== "function") throw new TypeError("withAtlasMainSourceProofLock: run is required");
  let held = null;
  try {
    held = await acquireWorktreeLockAsync(
      worktreeLockPath(repoRoot, repoRoot, { disabled: true }),
      { signal, waitMs: Math.max(0, Number(lockWaitMs) || 0) },
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
  }
  if (!held?.acquired || !("releaseAsync" in held)) {
    return run({ ok: false, reason: "repository_mutation_lock_unavailable" }, { held: false });
  }
  try {
    const proof = await inspectAtlasMainSourceProof({
      repoRoot,
      targetBranch,
      expectedGitOid,
      signal,
    });
    return await run(proof, { held: true });
  } finally {
    await held.releaseAsync();
  }
}

/**
 * Fail-closed publication boundary. The caller remains responsible for
 * holding the root mutation lock across its before proof, source read, this
 * after proof, and durable publication callback.
 *
 * @param {{
 *   sourceProof: any,
 *   result: any,
 *   viewPath: string,
 *   inspectAfter: (proof: any) => Promise<any>,
 *   publishGeneration: (proof: any) => Promise<any> | any,
 * }} args
 */
export async function publishAtlasMainGenerationIfProven({
  sourceProof,
  result,
  viewPath,
  inspectAfter,
  publishGeneration,
}) {
  const publishable = sourceProof?.ok === true
    && result?.view_written
    && path.resolve(String(result.view_written)) === path.resolve(viewPath)
    && Array.isArray(result?.skipped)
    && result.skipped.every((row) => ACCOUNTED_SKIP_REASONS.has(String(row?.reason || "")))
    && result?.truncated !== true
    && !result?.rebuild_required;
  if (!publishable) {
    result.generation_proof_reason = sourceProof?.reason
      || (sourceProof?.ok ? "warm_result_not_publishable" : "source_proof_unavailable");
    return result;
  }
  const after = await inspectAfter(sourceProof);
  if (!after?.ok) {
    result.generation_proof_reason = after?.reason || "source_post_proof_failed";
    return result;
  }
  try {
    result.generation = await publishGeneration(sourceProof);
    result.generation_proof_reason = "clean_exact_oid_before_after";
  } catch (err) {
    result.generation_proof_reason = "durable_generation_publication_failed";
    Object.defineProperty(result, "_generation_publish_error", {
      value: err,
      enumerable: false,
      configurable: true,
    });
  }
  return result;
}

/**
 * Verify the ledger/view join and publish Git identity into the materialized
 * main view. Callers serialize this with all Atlas writers.
 *
 * @param {{ ledger: any, viewPath: string, targetBranch: string, gitOid: string, intake?: any, treeCompressionMode?: string | null }} args
 */
export function publishAtlasMainGenerationToView({
  ledger,
  viewPath,
  targetBranch,
  gitOid,
  intake = null,
  treeCompressionMode = null,
}) {
  const branch = String(targetBranch || "").trim();
  const oid = String(gitOid || "").trim().toLowerCase();
  if (!ledger || !viewPath || !branch || !/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new TypeError("publishAtlasMainGenerationToView requires ledger, viewPath, targetBranch, and gitOid");
  }
  const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
  try {
    const meta = view.metaLocal();
    if (meta.branch !== branch) {
      throw new Error(`main generation branch mismatch (${meta.branch} != ${branch})`);
    }
    if (ledger.headSeq(branch) !== meta.ledger_seq) {
      throw new Error("main generation ledger sequence is not current");
    }
    if (ledger.layerRevision() !== meta.layer_revision) {
      throw new Error("main generation layer revision is not current");
    }
    const materialization = inspectViewMaterialization(view._unsafeDb(), {
      treeCompressionMode: normalizeTreeCompressionMode(treeCompressionMode),
    });
    if (!materialization.ok) {
      throw new Error(`main generation view materialization is not complete (${materialization.reason || "unknown"})`);
    }
    return view.publishGeneration({
      target_branch: branch,
      git_oid: oid,
      atlas_ledger_seq: meta.ledger_seq,
      atlas_layer_revision: meta.layer_revision,
      view_fingerprint: meta.view_fingerprint,
    }, { intake });
  } finally {
    view.close();
  }
}

/**
 * Universal main-index lifecycle. This is called by ParseEngine itself, so a
 * new caller cannot accidentally warm the main view without recording its
 * source pin and terminal outcome.
 *
 * @param {{
 *   repoRoot: string,
 *   purpose: string,
 *   targetBranch: string,
 *   expectedGitOid?: string | null,
 *   paths?: string[],
 *   viewPath: string,
 *   ledger: any,
 *   signal?: AbortSignal | null,
 *   lockWaitMs?: number,
 *   sourceProof?: any,
 *   sourceLockHeld?: boolean,
 *   treeCompressionMode?: string | null,
 *   run: (context: { intake: any, sourceProof: any }) => Promise<any>,
 * }} args
 */
export async function runAtlasMainIntake({
  repoRoot,
  purpose,
  targetBranch,
  expectedGitOid = null,
  paths = [],
  viewPath,
  ledger,
  signal = null,
  lockWaitMs = 30_000,
  sourceProof: suppliedSourceProof = null,
  sourceLockHeld = false,
  treeCompressionMode = null,
  run,
}) {
  const execute = async (sourceProof) => {
    if (sourceProof?.reason === "repository_mutation_lock_unavailable") {
      const error = Object.assign(
        new Error("ATLAS main intake could not acquire the repository mutation lock"),
        { code: "ATLAS_MAIN_INTAKE_LOCK_UNAVAILABLE" },
      );
      throw error;
    }
    const intake = beginAtlasMainIntake({
      repoRoot,
      purpose,
      targetBranch,
      sourceProof,
      paths,
    });
    let result;
    try {
      result = await run({ intake, sourceProof });
      await publishAtlasMainGenerationIfProven({
        sourceProof,
        result,
        viewPath,
        inspectAfter: (proof) => inspectAtlasMainSourceProof({
          repoRoot,
          targetBranch: proof.target_branch,
          expectedGitOid: proof.git_oid,
          signal,
        }),
        publishGeneration: (proof) => publishAtlasMainGenerationToView({
          ledger,
          viewPath,
          targetBranch: proof.target_branch,
          gitOid: proof.git_oid,
          intake,
          treeCompressionMode,
        }),
      });
    } catch (err) {
      const status = isAbortError(err) ? "interrupted" : "failed";
      try { finishAtlasMainIntake({ repoRoot, intake, status, result, error: err }); }
      catch { /* the original intake failure remains authoritative */ }
      throw err;
    }
    const status = intakeTerminalStatus(result);
    const finished = finishAtlasMainIntake({ repoRoot, intake, status, result });
    result.intake = {
      attempt_id: finished.attempt_id,
      status: finished.status,
      target_branch: finished.target_branch,
      git_oid: finished.git_oid,
      resume_count: finished.resume_count,
      resumed_from_status: finished.resumed_from_status,
    };
    return result;
  };
  if (sourceLockHeld === true && suppliedSourceProof && typeof suppliedSourceProof === "object") {
    return execute(suppliedSourceProof);
  }
  return withAtlasMainSourceProofLock({
    repoRoot,
    targetBranch,
    expectedGitOid,
    signal,
    lockWaitMs,
    run: execute,
  });
}

/**
 * Migrate a legacy exact main generation into the universal intake lifecycle
 * without rebuilding it. This is deliberately narrower than a warm: the
 * source must still be clean, the view must already publish that exact Git
 * generation, and no durable intake state may exist. Any partial/failed state
 * belongs to the normal resume path and must never be papered over here.
 *
 * @param {{
 *   repoRoot: string,
 *   targetBranch: string,
 *   viewPath: string,
 *   ledger: any,
 *   expectedGitOid?: string | null,
 *   treeCompressionMode?: string | null,
 *   signal?: AbortSignal | null,
 *   lockWaitMs?: number,
 * }} args
 */
export async function adoptPublishedAtlasMainGeneration({
  repoRoot,
  targetBranch,
  viewPath,
  ledger,
  expectedGitOid = null,
  treeCompressionMode = null,
  signal = null,
  lockWaitMs = 30_000,
}) {
  return withAtlasMainSourceProofLock({
    repoRoot,
    targetBranch,
    expectedGitOid,
    signal,
    lockWaitMs,
    run: async (sourceProof, lock) => {
      if (!lock.held || sourceProof?.ok !== true) {
        throw Object.assign(
          new Error(`ATLAS legacy intake adoption source proof failed: ${sourceProof?.reason || "unavailable"}`),
          { code: "ATLAS_MAIN_INTAKE_ADOPTION_SOURCE_UNPROVEN" },
        );
      }
      if (readAtlasMainIntakeState(repoRoot)) {
        throw Object.assign(
          new Error("ATLAS legacy intake adoption refuses to replace existing lifecycle state"),
          { code: "ATLAS_MAIN_INTAKE_ADOPTION_STATE_EXISTS" },
        );
      }
      return runAtlasMainIntake({
        repoRoot,
        purpose: "main-incremental",
        targetBranch,
        expectedGitOid: sourceProof.git_oid,
        paths: [],
        viewPath,
        ledger,
        signal,
        sourceProof,
        sourceLockHeld: true,
        treeCompressionMode,
        run: async () => {
          const view = View.mount({ dbPath: viewPath, mode: "readonly" });
          try {
            const generation = view.generationLocal();
            if (!generation
              || generation.target_branch !== sourceProof.target_branch
              || generation.git_oid !== sourceProof.git_oid) {
              throw Object.assign(
                new Error("ATLAS legacy intake adoption requires an already-published exact Git generation"),
                { code: "ATLAS_MAIN_INTAKE_ADOPTION_GENERATION_MISMATCH" },
              );
            }
          } finally {
            view.close();
          }
          return {
            purpose: "main-incremental",
            paths_considered: 0,
            paths_indexed: 0,
            blobs_ingested: 0,
            blobs_reused: 0,
            ledger_entries_appended: 0,
            view_written: viewPath,
            truncated: false,
            rebuild_required: null,
            skipped: [],
          };
        },
      });
    },
  });
}
