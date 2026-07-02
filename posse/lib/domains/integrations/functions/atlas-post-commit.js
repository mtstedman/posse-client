#!/usr/bin/env node

import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { closeDb, getDb } from "../../../shared/storage/functions/index.js";
import { closeLog, writeRuntimeLogAtDir } from "../../../shared/telemetry/functions/logging/logger.js";
import { logEvent } from "../../queue/functions/events.js";
import { resolveTargetBranchAsync } from "../../git/functions/target-branch.js";
import { getRuntimeLogDir } from "../../runtime/functions/paths.js";
import {
  getAtlasIntegrationConfig,
  reindexAtlasAfterCommit,
} from "./atlas.js";
import {
  emitMainAdvanced as emitAtlasV2MainAdvanced,
  emitScipRestageRequested as emitAtlasV2ScipRestageRequested,
  isAtlasV2EmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import { normalizeAtlasScipMode, shouldRunScipPhase } from "./atlas-v2-mode.js";
import { describeScipStagingState } from "../../atlas/functions/v2/scip/stager.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function currentShortHead(cwd) {
  try { return git(["rev-parse", "--short", "HEAD"], cwd); } catch { return ""; }
}

function commitRangePaths(cwd, fromSha, toSha) {
  if (!fromSha || !toSha) return [];
  try {
    const raw = git(["diff", "--name-only", fromSha, toSha], cwd);
    return raw.split("\n").map((line) => String(line || "").replace(/\\/g, "/").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function commitParents(cwd, ref = "HEAD") {
  try {
    return git(["show", "-s", "--format=%P", ref], cwd)
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function uniqueCommitRangePaths(cwd, ranges = []) {
  const paths = [];
  const seen = new Set();
  for (const [fromSha, toSha] of ranges) {
    for (const filePath of commitRangePaths(cwd, fromSha, toSha)) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      paths.push(filePath);
    }
  }
  return paths;
}

function previousCommitSha(cwd, headSha) {
  try { return git(["rev-parse", `${headSha || "HEAD"}^`], cwd); } catch { return ""; }
}

function mergeCommitDetails(cwd) {
  const parents = commitParents(cwd);

  let subject = "";
  try { subject = git(["show", "-s", "--format=%s", "HEAD"], cwd); } catch { subject = ""; }
  const branchMatch = subject.match(/^(Squash merge|Manual merge)\s+(.+?)\s+into\s+(.+)$/i);
  const details = {
    reason: null,
    subject: subject || null,
    branch: branchMatch?.[2]?.trim() || null,
    target: branchMatch?.[3]?.trim() || null,
  };
  if (parents.length > 1) return { ...details, reason: "merge_commit" };
  if (/^Squash merge\b/i.test(subject)) return { ...details, reason: "squash_merge" };
  if (/^Manual merge\b/i.test(subject)) return { ...details, reason: "manual_merge" };
  return details;
}

function postCommitDiffScope(cwd, headSha, mergeReason) {
  const prevSha = previousCommitSha(cwd, headSha);
  if (mergeReason === "merge_commit") {
    const parents = commitParents(cwd, headSha);
    if (parents.length > 1) {
      return {
        fromSha: prevSha,
        paths: uniqueCommitRangePaths(cwd, parents.map((parent) => [parent, headSha])),
      };
    }
  }
  return {
    fromSha: prevSha,
    paths: commitRangePaths(cwd, prevSha, headSha),
  };
}

function parseHookArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const mergeOnly = args.includes("--merge-only");
  const cwdArg = args.find((arg) => !String(arg || "").startsWith("--"));
  return {
    cwd: path.resolve(cwdArg || process.cwd()),
    mergeOnly,
  };
}

function skippedStatusIsSuccess(skipped) {
  return [
    "not_merge_commit",
    "atlas_disabled",
    "phase_not_enabled",
    "up_to_date",
    "commit_hook_disabled",
    "atlas_v2_outbox",
  ].includes(String(skipped || ""));
}

function shouldConsiderScipRestage(config = {}) {
  const policy = String(config?.scipRestagePolicy || "missing").trim().toLowerCase();
  return shouldRunScipPhase(normalizeAtlasScipMode(config?.scipMode)) && (policy === "smart" || policy === "always");
}

function eventTypeForPostCommitStatus(message, data = {}) {
  if (data.skipped) return EVENT_TYPES.ATLAS_REINDEX_SKIPPED;
  if (/starting/i.test(message)) return EVENT_TYPES.ATLAS_REINDEX_STARTED;
  if (/complete/i.test(message)) return EVENT_TYPES.ATLAS_REINDEX_COMPLETED;
  if (/failed/i.test(message)) return EVENT_TYPES.ATLAS_REINDEX_FAILED;
  return EVENT_TYPES.ATLAS_REINDEX_STATUS;
}

function workItemIdFromBranch(branchName) {
  const match = String(branchName || "").match(/(?:^|[\/_-])wi[-_]?(\d+)(?:\D|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function resolvePostCommitWorkItemId(data = {}) {
  const branch = data.branch || null;
  if (!branch) return null;
  try {
    const db = getDb();
    const byBranch = db.prepare(`
      SELECT id FROM work_items
      WHERE branch_name = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(branch);
    if (byBranch?.id != null) return Number(byBranch.id);
    const parsedId = workItemIdFromBranch(branch);
    if (parsedId == null) return null;
    const byId = db.prepare(`SELECT id FROM work_items WHERE id = ? LIMIT 1`).get(parsedId);
    return byId?.id != null ? Number(byId.id) : null;
  } catch {
    return null;
  }
}

function writePostCommitVisibleEvent(cwd, level, message, data = {}) {
  const parsedId = workItemIdFromBranch(data.branch);
  const workItemId = resolvePostCommitWorkItemId(data);
  try {
    const eventJson = {
      level,
      phase: "post-commit",
      cwd,
      ...data,
    };
    if (parsedId != null) eventJson.branch_work_item_id = parsedId;
    logEvent({
      work_item_id: workItemId,
      event_type: eventTypeForPostCommitStatus(message, data),
      actor_type: EVENT_ACTORS.SYSTEM,
      message,
      event_json: eventJson,
    });
  } catch {
    // User-visible event logging is best effort; the hook must not block commits.
  }
  return workItemId;
}

function writePostCommitStatus(cwd, level, message, data = {}, { visible = true } = {}) {
  const logDir = getRuntimeLogDir(cwd, cwd);
  writeRuntimeLogAtDir(logDir, level, "atlas", message, {
    phase: "post-commit",
    cwd,
    ...data,
  });
  if (visible) writePostCommitVisibleEvent(cwd, level, message, data);
}

async function emitPostCommitScipRestageIfNeeded({
  cwd,
  config,
  headFull,
  targetBranch,
  mergeReason,
} = {}) {
  if (!mergeReason) return { attempted: false, skipped: "not_merge_commit" };
  if (!shouldConsiderScipRestage(config)) return { attempted: false, skipped: "policy" };
  let staging;
  try {
    staging = await describeScipStagingState({ repoRoot: cwd, config });
  } catch (err) {
    writePostCommitStatus(cwd, "warn", "ATLAS SCIP post-commit restage check failed", {
      error: err?.message || String(err),
    }, { visible: false });
    return { attempted: false, skipped: "check_failed" };
  }
  const pending = (staging.rows || []).filter((row) => row?.decision?.action === "stage");
  if (pending.length === 0) return { attempted: false, skipped: "fresh" };
  const result = emitAtlasV2ScipRestageRequested({
    payload: {
      to_sha: String(headFull || ""),
      target_branch: String(targetBranch || "main"),
      reason: pending.map((row) => `${row.language}:${row.decision.reason}`).join(","),
      source: "post_commit_hook",
    },
    onError: (err) => writePostCommitStatus(cwd, "warn", "ATLAS SCIP restage outbox emission failed", {
      error: err?.message || String(err),
    }, { visible: false }),
  });
  if (result.ok) {
    writePostCommitStatus(cwd, "info", "ATLAS SCIP post-commit restage enqueued", {
      head: headFull || null,
      targetBranch: targetBranch || null,
      policy: config?.scipRestagePolicy || "missing",
      pendingLanguages: pending.map((row) => row.language),
      warmJobId: result.warmJobId || null,
      coalesced: !!result.coalesced,
    }, { visible: false });
  }
  return {
    attempted: result.ok === true,
    skipped: result.ok ? undefined : (result.skipped || "outbox_error"),
    result,
  };
}

export async function runAtlasPostCommitHook({
  cwd = process.cwd(),
  mergeOnly = false,
  config = getAtlasIntegrationConfig(),
  timeoutMs = 10 * 60 * 1000,
  out = process.stdout,
} = {}) {
  const shortHead = currentShortHead(cwd);
  if (config?.reindexOnCommit !== true) {
    out.write(`[atlas] post-commit skipped after ${shortHead || "HEAD"} (commit_hook_disabled)\n`);
    writePostCommitStatus(cwd, "info", "ATLAS post-commit reindex skipped", {
      head: shortHead || null,
      skipped: "commit_hook_disabled",
      exitCode: 0,
    }, { visible: false });
    return { ok: true, attempted: false, skipped: "commit_hook_disabled", exitCode: 0 };
  }
  const mergeDetails = mergeCommitDetails(cwd);
  const mergeReason = mergeDetails.reason;
  if (mergeOnly && !mergeReason) {
    out.write(`[atlas] post-commit skipped after ${shortHead || "HEAD"} (not a merge commit)\n`);
    writePostCommitStatus(cwd, "info", "ATLAS post-commit reindex skipped", {
      head: shortHead || null,
      skipped: "not_merge_commit",
      mergeOnly: true,
      ...mergeDetails,
    }, { visible: false });
    return { ok: true, attempted: false, skipped: "not_merge_commit", exitCode: 0 };
  }

  out.write(`[atlas] reindex kicked off after ${shortHead || "HEAD"}${mergeReason ? ` (${mergeReason})` : ""}\n`);
  writePostCommitStatus(cwd, "info", "ATLAS post-commit reindex starting", {
    head: shortHead || null,
    mergeReason: mergeReason || null,
    ...mergeDetails,
  });

  // ATLAS v2 transactional outbox: hand the change set off as
  // `atlas.main_advanced` so the warmer enqueues an incremental reindex job.
  if (isAtlasV2EmissionEnabled(config)) {
    try {
      const headFull = git(["rev-parse", "HEAD"], cwd);
      const { fromSha, paths } = postCommitDiffScope(cwd, headFull, mergeReason);
      const targetBranch = mergeDetails.target || await resolveTargetBranchAsync(cwd);
      emitAtlasV2MainAdvanced({
        payload: {
          from_sha: String(fromSha || ""),
          to_sha: String(headFull || ""),
          target_branch: String(targetBranch || "main"),
          paths,
          source: mergeReason ? "merge" : "post_commit_hook",
        },
        onError: (err) => writePostCommitStatus(cwd, "warn", "ATLAS v2 outbox emission failed", {
          error: err?.message || String(err),
        }, { visible: false }),
      });
      await emitPostCommitScipRestageIfNeeded({
        cwd,
        config,
        headFull,
        targetBranch,
        mergeReason,
      });
    } catch (emitErr) {
      writePostCommitStatus(cwd, "warn", "ATLAS v2 outbox emission skipped", {
        error: emitErr?.message || String(emitErr),
      }, { visible: false });
    }
  }

  let resolveStatus;
  const statusPromise = new Promise((resolve) => { resolveStatus = resolve; });
  const result = reindexAtlasAfterCommit({
    cwd,
    config,
    timeoutMs,
    onStatus(status) {
      resolveStatus(status);
    },
  });

  if (!result.attempted) {
    const skipped = result.skipped || "unknown";
    out.write(`[atlas] reindex skipped after ${shortHead || "HEAD"} (${skipped})\n`);
    writePostCommitStatus(cwd, skippedStatusIsSuccess(skipped) ? "info" : "warn", "ATLAS post-commit reindex skipped", {
      head: shortHead || null,
      mergeReason: mergeReason || null,
      skipped,
      exitCode: skippedStatusIsSuccess(skipped) ? 0 : 1,
      ...mergeDetails,
    });
    return {
      ok: skippedStatusIsSuccess(skipped),
      attempted: false,
      skipped,
      exitCode: skippedStatusIsSuccess(skipped) ? 0 : 1,
    };
  }

  result.child?.ref?.();

  let timeoutHandle = null;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({
      ok: false,
      error: `hook_wait_timeout_${timeoutMs}ms`,
      status: 1,
    }), Math.max(1000, timeoutMs + 1000));
    timeoutHandle.unref?.();
  });
  const status = await Promise.race([statusPromise, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (status?.ok) {
    const metaNote = status.metaWriteFailed ? `; metadata write failed: ${status.metaError || "unknown"}` : "";
    out.write(`[atlas] reindex complete after ${shortHead || "HEAD"}${metaNote}\n`);
    writePostCommitStatus(cwd, "info", "ATLAS post-commit reindex complete", {
      head: shortHead || null,
      mergeReason: mergeReason || null,
      repoId: status.repoId || result.repoId || null,
      metaWriteFailed: !!status.metaWriteFailed,
      metaError: status.metaError || null,
      exitCode: 0,
      ...mergeDetails,
    });
    return { ok: true, attempted: true, status, result, exitCode: 0 };
  }

  const detail = status?.error || (status?.status != null ? `exit ${status.status}` : "unknown");
  out.write(`[atlas] reindex failed after ${shortHead || "HEAD"}: ${detail}\n`);
  writePostCommitStatus(cwd, "warn", "ATLAS post-commit reindex failed", {
    head: shortHead || null,
    mergeReason: mergeReason || null,
    repoId: status?.repoId || result.repoId || null,
    error: detail,
    status: status?.status ?? null,
    exitCode: 1,
    ...mergeDetails,
  });
  return { ok: false, attempted: true, status, result, exitCode: 1 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseHookArgs();
    const result = await runAtlasPostCommitHook(args);
    process.exitCode = result.exitCode;
  } catch (err) {
    console.log(`[atlas] post-commit hook failed: ${err?.message || String(err)}`);
    writePostCommitStatus(process.cwd(), "warn", "ATLAS post-commit hook failed", {
      error: err?.message || String(err),
      exitCode: 1,
    });
    process.exitCode = 1;
  } finally {
    closeLog();
    closeDb();
  }
}
