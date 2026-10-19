import { PROMOTION_IMAGE_ARTIFACT_EXTENSIONS as IMAGE_ARTIFACT_EXTENSIONS } from "../../../../catalog/files.js";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { resolvePathWithin } from "../../../../shared/scope/functions/path.js";
import { artifactsDir, wiScopeId } from "../../../artifacts/functions/index.js";
import { gitCommitAllAsync } from "../../../git/functions/commit-scope.js";
import { gitHasChangesAsync } from "../../../git/functions/utils.js";
import { snapshotAndResetDirtyWorktreeAsync } from "../../../git/functions/worktree.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import {
  addDependency,
  completeAttempt,
  createJob,
  getDependents,
  getJob,
  getWorkItem,
  incrementAndCreateAttempt,
  listJobsByWorkItem,
  logEvent,
  setAttemptCommitHash,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { buildArtifactRecoveryPayload, buildImageArtifactRecoveryPayload } from "../helpers/verdicts/fail.js";
import { refreshAndExtractInsights } from "../helpers/insights.js";
import { looksLikeFileDestination, normalizeRootRelativePromoteDest, validatePromoteDestinationPath } from "../../../planning/functions/plan-routing.js";
import { logAttemptSkippedStaleLease } from "./attempt-logging.js";
import { logBadInputFailure } from "./bad-input.js";
import { activeSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import { EVENT_TYPES, EVENT_ACTORS, PROMOTE_SOURCE_PICK_RULES } from "../../../../catalog/event.js";
import { LEASE_HOLDING_STATUSES } from "../../../../catalog/job.js";
import { assertPromoteCopyPlan, copyPromoteFileSync } from "./promote-files.js";

export { assertPromoteCopyPlan, copyPromoteFileSync } from "./promote-files.js";

function rootRelativePromoteDestHint(dest) {
  const raw = String(dest || "").replace(/\\/g, "/").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return "";
  return " Root-relative promote destinations are auto-mapped only when exactly one existing repo/web-root file proves the target path; use a repo-relative destination if this path is intentional.";
}

function fileDigest(filePath) {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

export function buildPromoteConflictPreview({ copies = [], cwd = process.cwd() } = {}) {
  const planned = [];
  for (const copy of Array.isArray(copies) ? copies : []) {
    const source = String(copy.source || "").trim();
    const destination = String(copy.destination || "").trim();
    if (!source || !destination) continue;
    const destinationRel = (copy.destinationRel || path.relative(cwd, destination)).replace(/\\/g, "/");
    let sourceStat = null;
    let targetStat = null;
    try { sourceStat = fs.statSync(source); } catch { sourceStat = null; }
    try { targetStat = fs.statSync(destination); } catch { targetStat = null; }
    const sourceHash = sourceStat?.isFile() ? fileDigest(source) : null;
    const targetHash = targetStat?.isFile() ? fileDigest(destination) : null;
    const targetExists = !!targetStat?.isFile();
    planned.push({
      source: path.relative(cwd, source).replace(/\\/g, "/") || source,
      destination: destinationRel,
      source_bytes: sourceStat?.isFile() ? sourceStat.size : null,
      target_exists: targetExists,
      target_bytes: targetExists ? targetStat.size : null,
      identical: targetExists && sourceHash != null && sourceHash === targetHash,
      source_sha256: sourceHash,
      target_sha256: targetHash,
    });
  }
  const overwrites = planned.filter((entry) => entry.target_exists && !entry.identical);
  const identicalExisting = planned.filter((entry) => entry.target_exists && entry.identical);
  return {
    ok: true,
    planned_count: planned.length,
    existing_count: overwrites.length + identicalExisting.length,
    overwrite_count: overwrites.length,
    identical_existing_count: identicalExisting.length,
    overwrites,
    identical_existing: identicalExisting,
    planned,
  };
}

export function formatPromoteConflictPreview(preview) {
  if (!preview || preview.planned_count === 0) return "promote conflict preview: no files planned";
  if (preview.existing_count === 0) return `promote conflict preview: ${preview.planned_count} new file(s), no overwrites`;
  const changed = (preview.overwrites || []).map((entry) => `${entry.destination} (${entry.target_bytes ?? "?"} -> ${entry.source_bytes ?? "?"} bytes)`);
  const identical = (preview.identical_existing || []).map((entry) => `${entry.destination} (identical)`);
  return [
    `promote conflict preview: ${preview.planned_count} planned, ${preview.overwrite_count} overwrite(s), ${preview.identical_existing_count} identical existing`,
    ...changed.slice(0, 12).map((entry) => `overwrite: ${entry}`),
    ...identical.slice(0, 12 - Math.min(12, changed.length)).map((entry) => `existing: ${entry}`),
  ].join("\n");
}

function normalizePromotePolicyPath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim());
  const cleaned = normalized === "." ? "" : normalized.replace(/\/+$/, "");
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

function promotePathSet(paths = []) {
  return new Set(
    (Array.isArray(paths) ? paths : [])
      .map(normalizePromotePolicyPath)
      .filter(Boolean)
  );
}

export function assertPromoteOverwritePolicy(preview, { allowOverwrite = false, allowedOverwritePaths = [] } = {}) {
  const overwriteCount = Number(preview?.overwrite_count || 0);
  if (overwriteCount <= 0 || allowOverwrite === true) return;
  const allowed = promotePathSet(allowedOverwritePaths);
  const blockedOverwrites = (preview.overwrites || []).filter((entry) => !allowed.has(normalizePromotePolicyPath(entry.destination)));
  if (blockedOverwrites.length === 0) return;
  const targets = blockedOverwrites
    .map((entry) => entry.destination)
    .filter(Boolean)
    .slice(0, 12);
  const suffix = targets.length > 0 ? `: ${targets.join(", ")}` : "";
  const err = new Error(`Promote would overwrite ${blockedOverwrites.length} existing file(s)${suffix}`);
  // Deterministic conflict — retrying the identical promote cannot succeed.
  // retryOrFail routes this straight to dead-letter/operator recovery.
  err.code = "PROMOTE_OVERWRITE_BLOCKED";
  throw err;
}



function isImageArtifactName(name) {
  return IMAGE_ARTIFACT_EXTENSIONS.has(path.posix.extname(String(name || "")).toLowerCase());
}

function listSourceFiles(sourceDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({
        name: entry.name,
        full,
        relative: path.relative(sourceDir, full).replace(/\\/g, "/"),
      });
    }
  };
  walk(sourceDir);
  return files;
}

/**
 * Resolve duplicate basenames before copying to a single destination. A
 * declared path matches one file exactly, never by suffix: resolved against
 * the project (absolute or `.posse/resources/...` forms) or equal to the
 * file's path under the output root.
 */
export function selectPromoteSourceFiles(files, { sourceDir, projectDir = null, namedFiles = [], onPick = () => {} } = {}) {
  const declared = (Array.isArray(namedFiles) ? namedFiles : [])
    .map((raw) => String(raw || "").trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const isDeclared = (file) => declared.some((raw) => {
    if (path.posix.normalize(raw) === file.relative) return true;
    const resolved = projectDir ? path.resolve(projectDir, raw) : path.isAbsolute(raw) ? path.resolve(raw) : null;
    return resolved === path.resolve(file.full);
  });
  const byName = new Map();
  for (const file of files) {
    if (!byName.has(file.name)) byName.set(file.name, []);
    byName.get(file.name).push(file);
  }
  const selected = [];
  for (const [name, matches] of byName) {
    if (matches.length === 1) {
      selected.push(matches[0]);
      continue;
    }
    const byContent = new Map();
    for (const file of matches) {
      const sha = createHash("sha256").update(fs.readFileSync(file.full)).digest("hex");
      if (!byContent.has(sha)) byContent.set(sha, []);
      byContent.get(sha).push(file);
    }
    const candidates = [...byContent.values()].map((copies) => (
      copies.find(isDeclared) || copies.find((file) => file.relative === name) || copies[0]
    ));
    let pick = candidates.length === 1 ? candidates[0] : null;
    let rule = pick ? PROMOTE_SOURCE_PICK_RULES.IDENTICAL_CONTENT : null;
    if (!pick) {
      const named = candidates.filter(isDeclared);
      if (named.length === 1) [pick, rule] = [named[0], PROMOTE_SOURCE_PICK_RULES.DECLARED];
    }
    if (!pick) {
      const topLevel = candidates.filter((file) => file.relative === name);
      if (topLevel.length === 1) [pick, rule] = [topLevel[0], PROMOTE_SOURCE_PICK_RULES.TOP_LEVEL];
    }
    if (!pick) throw new Error(`Promote source "${name}" is ambiguous in ${sourceDir}: ${matches.map((file) => file.relative).join(", ")}`);
    onPick({ name, selected: pick.relative, alternatives: matches.map((file) => file.relative), rule });
    selected.push(pick);
  }
  return selected;
}

// The artificer that produced this promote's source directory (its output
// root is that directory or contains it), preferring the one whose brief
// names the missing files; its task and criteria give the repair the set's
// style and constraints.
function findSourceArtificer(job, sourceDir, missingNames) {
  const candidates = [];
  for (const sibling of listJobsByWorkItem(job.work_item_id)) {
    if (sibling.job_type !== "artificer" || sibling.id === job.id) continue;
    const payload = parseJobPayload(sibling);
    const outputRoot = String(payload?.output_root || "").trim();
    if (!outputRoot || !resolvePathWithin(path.resolve(outputRoot), sourceDir)) continue;
    const exact = path.resolve(outputRoot) === path.resolve(sourceDir);
    const text = `${payload.task_spec || ""}\n${(payload.success_criteria || []).join("\n")}\n${(payload.files_to_create || []).join("\n")}`;
    const mentions = missingNames.filter((name) => text.includes(name)).length;
    candidates.push({ sibling, payload, mentions, exact });
  }
  candidates.sort((left, right) => right.mentions - left.mentions
    || Number(right.exact) - Number(left.exact)
    || left.sibling.id - right.sibling.id);
  return candidates[0] || null;
}

// A repair that has not finished: waiting to run, or holding a lease.
const PENDING_REPAIR_STATUSES = new Set(["queued", ...LEASE_HOLDING_STATUSES]);

// File names an unfinished repair job in this WI is producing into the
// source directory: the assessor's partial-deliverable repair, or an earlier
// promote's own repair. Those files are deferred to that job rather than
// installed now (possibly defective) or produced twice.
function pendingMissingFileRepairs(job, sourceDir) {
  const byName = new Map();
  for (const sibling of listJobsByWorkItem(job.work_item_id)) {
    if (sibling.job_type !== "artificer" || !PENDING_REPAIR_STATUSES.has(sibling.status)) continue;
    const payload = parseJobPayload(sibling);
    const names = [payload?._repair_image_names, payload?._repair_file_names].flatMap((list) => (Array.isArray(list) ? list : []));
    const outputRoot = String(payload?.output_root || "").trim();
    if (names.length === 0 || !outputRoot || path.resolve(outputRoot) !== path.resolve(sourceDir)) continue;
    for (const name of names) if (!byName.has(name)) byName.set(name, sibling);
  }
  return byName;
}

// How many missing-file repairs this promote's chain has already spawned.
function promoteMissingRepairRound(payload) {
  const round = Number(payload?._promote_missing_repair_round);
  return Number.isInteger(round) && round > 0 ? round : 0;
}

function spawnFollowupPromote(worker, job, payload, { mappings, repairJob, attemptId, extraPayload = {} }) {
  const followupJob = createJob({
    work_item_id: job.work_item_id,
    job_type: "promote",
    title: `${job.title} (after repair #${repairJob.id})`.slice(0, 200),
    parent_job_id: job.parent_job_id || job.id,
    priority: job.priority,
    model_tier: job.model_tier,
    payload_json: JSON.stringify({ ...payload, mappings, ...extraPayload, _promote_followup_of: job.id }),
  });
  addDependency(followupJob.id, repairJob.id, "hard");
  const rewired = [];
  for (const dependent of getDependents(job.id)) {
    if (dependent.job_id === followupJob.id || dependent.job_id === repairJob.id) continue;
    if (String(getJob(dependent.job_id)?.job_type || "").toLowerCase() === "promote") continue;
    if (addDependency(dependent.job_id, followupJob.id, dependent.kind || "hard")) rewired.push(dependent.job_id);
  }
  void attemptId;
  return { followupJob, rewired };
}

/**
 * A promote whose named source files are partly or wholly missing installs
 * what is there and hands the rest to a repair scoped to exactly the missing
 * files: an artificer job for those names, then a promote of only those
 * mappings. Jobs that waited on this promote also wait on the follow-up, so
 * the WI still converges on the full set without redoing what was good.
 */
function spawnMissingFileRepair(worker, job, payload, { sourceDir, missingMappings, source, attemptId, copied = true }) {
  const missingNames = missingMappings.map((mapping) => mapping.pattern);
  const outputRoot = path.relative(worker.projectDir, sourceDir).replace(/\\/g, "/");
  const images = missingNames.every(isImageArtifactName);
  const existing = listSourceFiles(sourceDir).filter((file) => !images || isImageArtifactName(file.name))
    .map((file) => file.relative);
  const existingNote = `${existing.length} file(s)${existing.length > 0 ? `: ${existing.slice(0, 12).join(", ")}${existing.length > 12 ? ", …" : ""}` : ""}`;
  const sourceCriteria = (source?.payload?.success_criteria || []).filter((criterion) => !/^exactly \d+ /iu.test(String(criterion)));
  const repairPayload = images
    ? {
      ...buildImageArtifactRecoveryPayload({
        job: source?.sibling || job,
        fixInstructions: [
          `Generate exactly these missing image files into the output root, with these exact filenames: ${missingNames.join(", ")}.`,
          `The other files of this set already exist in the output root (${existingNote}); match their style, dimensions and border, and do not regenerate or modify them.`,
        ].join("\n"),
        assessorFeedback: [],
        originalCreateFiles: [],
        originalCreateRoots: [outputRoot],
        originalFiles: [],
        originalOutputRoot: outputRoot,
        originalSuccessCriteria: [`Each of ${missingNames.join(", ")} exists in the output root as a valid image.`, ...sourceCriteria],
        originalTaskSpec: source?.payload?.task_spec || null,
      }),
      _repair_image_names: missingNames,
    }
    : {
      ...buildArtifactRecoveryPayload({
        job: source?.sibling || job,
        fixInstructions: [
          `Produce exactly these missing files in the output root, with these exact filenames: ${missingNames.join(", ")}.`,
          `The other files of this deliverable already exist in the output root (${existingNote}); keep the new files consistent with them, and do not regenerate or modify them.`,
        ].join("\n"),
        assessorFeedback: [],
        originalOutputRoot: outputRoot,
        originalSuccessCriteria: [`Each of ${missingNames.join(", ")} exists in the output root.`, ...sourceCriteria],
        originalTaskSpec: source?.payload?.task_spec || null,
        originalTaskMode: source?.payload?.task_mode || "content",
      }),
      files_to_create: missingNames.map((name) => path.join(sourceDir, name).replace(/\\/g, "/")),
      _repair_file_names: missingNames,
    };
  const noun = images ? "images" : "files";
  const repairJob = createJob({
    work_item_id: job.work_item_id,
    job_type: "artificer",
    title: `${images ? "Generate" : "Produce"} missing ${noun} (${missingNames.length}): ${missingNames.slice(0, 3).join(", ")}${missingNames.length > 3 ? ", …" : ""}`,
    parent_job_id: job.id,
    priority: job.priority,
    model_tier: source?.sibling?.model_tier || "standard",
    reasoning_effort: source?.sibling?.reasoning_effort || "medium",
    skills: source?.sibling?.skills || null,
    payload_json: JSON.stringify({ ...repairPayload, _promote_missing_repair_for: job.id }),
  });
  const { followupJob, rewired } = spawnFollowupPromote(worker, job, payload, {
    mappings: missingMappings,
    repairJob,
    attemptId,
    extraPayload: { _promote_missing_repair_round: promoteMissingRepairRound(payload) + 1 },
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    event_type: EVENT_TYPES.JOB_PROMOTE_PARTIAL,
    actor_type: EVENT_ACTORS.WORKER,
    message: `${copied ? "Promoted the existing files; " : ""}${missingNames.length} missing ${noun} routed to repair #${repairJob.id} and follow-up promote #${followupJob.id}: ${missingNames.join(", ")}`,
    event_json: JSON.stringify({
      missing: missingNames,
      repair_job_id: repairJob.id,
      followup_job_id: followupJob.id,
      source_artificer_job_id: source?.sibling?.id || null,
      dependents_rewired: rewired,
    }),
  });
  worker.emit(job.id, `${C.yellow}[promote]${C.reset} WI#${job.work_item_id} job #${job.id}: ${missingNames.length} ${noun} missing; spawned repair #${repairJob.id} -> promote #${followupJob.id}`);
  return { repairJob, followupJob, rewired };
}

export async function runPromoteJob(worker, job, wrappedJob, { leaseToken } = {}) {
  const attempt = incrementAndCreateAttempt(job.id, leaseToken, "system", "system", null);
  if (!attempt) {
    logAttemptSkippedStaleLease(job, "system", "Skipped promote attempt because the lease was stale or expired");
    worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} - lease lost${C.reset}`);
    return;
  }

  const startTime = Date.now();
  try {
    const payload = worker.parsePayload(job);
    const sourceDir = typeof payload.source_dir === "string"
      ? resolvePathWithin(worker.projectDir, payload.source_dir)
      : null;
    const artifactRoot = artifactsDir(wiScopeId(job.work_item_id), worker.projectDir);
    // Allow promote sources to come from any work item's artifact namespace,
    // not just the current WI's. A WI#80 plan that promotes artifacts produced
    // by WI#79 is a legitimate workflow (a follow-up "deploy" WI); the strict
    // per-WI check was rejecting these even though the source is still safely
    // inside `.posse/resources/artifacts/`.
    const artifactsBase = path.dirname(artifactRoot);
    const mappings = payload.mappings || [];
    const promCwd = job._worktreePath || worker.projectDir;
    worker._throwIfKilled(job.id);

    const rootLabel = path.relative(worker.projectDir, artifactsBase).replace(/\\/g, "/") || artifactsBase;
    if (!sourceDir || !resolvePathWithin(artifactsBase, sourceDir)) {
      throw new Error(`Promote source directory must be inside ${rootLabel}: ${payload.source_dir}`);
    }
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      throw new Error(`Source directory does not exist: ${sourceDir}`);
    }
    if (mappings.length === 0) {
      throw new Error("No file mappings specified");
    }
    const sourceRelToArtifacts = path.relative(artifactsBase, sourceDir).replace(/\\/g, "/");
    const sourceScope = sourceRelToArtifacts.split("/").find(Boolean) || "";
    const sourceWiId = Number(/^wi-(\d+)$/.exec(sourceScope)?.[1] || 0);
    if (Number.isInteger(sourceWiId) && sourceWiId > 0 && sourceWiId !== Number(job.work_item_id)) {
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.attempt.id,
        event_type: EVENT_TYPES.JOB_PROMOTE_CROSS_WI_SOURCE,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Promote source crosses WI boundary: WI#${job.work_item_id} reading artifacts from WI#${sourceWiId}`,
        event_json: JSON.stringify({
          source_work_item_id: sourceWiId,
          target_work_item_id: Number(job.work_item_id),
          source_dir: sourceRelToArtifacts,
        }),
      });
    }

    const plannedCopies = [];
    const missingMappings = [];
    const pendingRepairs = pendingMissingFileRepairs(job, sourceDir);
    const deferredByRepair = new Map();
    for (const mapping of mappings) {
      worker._throwIfKilled(job.id);
      const { pattern, dest } = mapping;
      const wildcard = pattern.startsWith("*.");
      const pendingRepair = !wildcard && pendingRepairs.get(pattern);
      if (pendingRepair) {
        // Being regenerated by an unfinished repair: install it from the
        // follow-up promote that waits on that repair, not now.
        const group = deferredByRepair.get(pendingRepair.id) || { repairJob: pendingRepair, mappings: [] };
        group.mappings.push(mapping);
        deferredByRepair.set(pendingRepair.id, group);
        continue;
      }
      const explicitFileDest = mapping.destination_type === "file"
        || (!wildcard && looksLikeFileDestination(dest));
      const resolvedDest = normalizeRootRelativePromoteDest(dest, {
        pattern,
        fileDest: explicitFileDest,
        projectDir: promCwd,
      });
      const protectedDestErr = validatePromoteDestinationPath(resolvedDest, "promote destination");
      if (protectedDestErr) {
        throw new Error(protectedDestErr);
      }
      const destAbs = resolvePathWithin(promCwd, resolvedDest);
      if (!destAbs) {
        const hint = rootRelativePromoteDestHint(dest);
        throw new Error(`Destination escapes project scope: ${dest}${hint ? `.${hint}` : ""}`);
      }
      const matchFile = (name) => {
        if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
        return name === pattern;
      };
      if (wildcard && explicitFileDest) {
        throw new Error(`Wildcard promote mapping "${pattern}" cannot target file destination "${resolvedDest}"`);
      }
      let deferredWildcard = false;
      if (wildcard) {
        // Include missing repair outputs too: a wildcard must eventually
        // install them even if the repair has not created the file yet.
        for (const [name, repairJob] of pendingRepairs) {
          if (!matchFile(name)) continue;
          const group = deferredByRepair.get(repairJob.id) || { repairJob, mappings: [] };
          group.mappings.push({ ...mapping, pattern: name, dest: path.posix.join(resolvedDest, name), destination_type: "file" });
          deferredByRepair.set(repairJob.id, group);
          deferredWildcard = true;
        }
      }
      const sourceFiles = listSourceFiles(sourceDir)
        .filter((file) => matchFile(file.name) && !(wildcard && pendingRepairs.has(file.name)));

      if (sourceFiles.length === 0) {
        if (deferredWildcard) continue;
        // A named file that was never produced is a gap in the set, not a
        // reason to discard the files that were: decided below.
        if (!wildcard) {
          missingMappings.push(mapping);
          continue;
        }
        worker.display?.updateWorkerTier(job.id, "standard", attempt.attempt_number || job.attempt_count || 1);
        logBadInputFailure(job, {
          layer: "promote",
          upstream: "artifact_output",
          classification: "missing_expected_files",
          detail: `Promote mapping "${pattern}" matched no files in ${sourceDir}`,
        });
        throw new Error(`No files matching "${pattern}" in ${sourceDir}`);
      }
      const sourceArtificer = findSourceArtificer(job, sourceDir, [pattern]);
      const selectedFiles = selectPromoteSourceFiles(sourceFiles, {
        sourceDir,
        projectDir: worker.projectDir,
        namedFiles: sourceArtificer?.payload?.files_to_create || [],
        onPick: (pick) => {
          worker.emit(job.id, `${C.yellow}[promote]${C.reset} selected ${pick.selected} for ${pick.name} (${pick.rule}); alternatives: ${pick.alternatives.join(", ")}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.attempt.id,
            event_type: EVENT_TYPES.JOB_PROMOTE_SOURCE_SELECTED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Promote selected ${pick.selected} for ${pick.name} by ${pick.rule}`,
            event_json: JSON.stringify({ pattern, ...pick }),
          });
        },
      });
      if (explicitFileDest && selectedFiles.length > 1) {
        throw new Error(`Promote mapping "${pattern}" matched ${selectedFiles.length} files but destination is a single file: ${resolvedDest}`);
      }

      for (const { name, full } of selectedFiles) {
        worker._throwIfKilled(job.id);
        const dst = explicitFileDest ? destAbs : path.join(destAbs, name);
        plannedCopies.push({
          source: full,
          destination: dst,
          destinationRel: path.relative(promCwd, dst).replace(/\\/g, "/"),
        });
      }
    }

    // The files that exist are promoted and the missing ones go to a repair
    // of the artificer that wrote the source directory (image sets fall back
    // to the image route without one). A follow-up promote after a repair
    // must install something to repair again, so a repair that never
    // produces its files ends at the dead-letter gate instead of looping.
    let missingRepairSource = null;
    if (missingMappings.length > 0) {
      const missingNames = missingMappings.map((mapping) => mapping.pattern);
      missingRepairSource = findSourceArtificer(job, sourceDir, missingNames);
      const madeProgress = promoteMissingRepairRound(payload) === 0 || plannedCopies.length > 0;
      const repairable = madeProgress && (!!missingRepairSource
        || (plannedCopies.length > 0 && missingNames.every(isImageArtifactName)));
      if (!repairable) {
        worker.display?.updateWorkerTier(job.id, "standard", attempt.attempt_number || job.attempt_count || 1);
        logBadInputFailure(job, {
          layer: "promote",
          upstream: "artifact_output",
          classification: "missing_expected_files",
          detail: plannedCopies.length === 0
            ? `None of the ${missingMappings.length} promote mapping(s) matched a file in ${sourceDir}`
            : `Promote mapping "${missingNames[0]}" matched no files in ${sourceDir}`,
        });
        throw new Error(plannedCopies.length === 0
          ? `No files matching any mapping in ${sourceDir}: ${missingNames.join(", ")}`
          : `No files matching "${missingNames[0]}" in ${sourceDir}`);
      }
    }

    if (plannedCopies.length === 0 && (missingMappings.length > 0 || deferredByRepair.size > 0)) {
      // Nothing to promote now: the repairs produce every mapped file and
      // their follow-up promotes install them.
      const repair = missingMappings.length > 0
        ? spawnMissingFileRepair(worker, job, payload, { sourceDir, missingMappings, source: missingRepairSource, attemptId: attempt.attempt.id, copied: false })
        : null;
      for (const group of deferredByRepair.values()) {
        spawnFollowupPromote(worker, job, payload, { mappings: group.mappings, repairJob: group.repairJob, attemptId: attempt.attempt.id });
      }
      if (!repair) worker.emit(job.id, `${C.yellow}[promote]${C.reset} WI#${job.work_item_id} job #${job.id}: every mapping awaits a pending repair; deferred to follow-up promote(s)`);
      completeAttempt(attempt.attempt.id, { status: "succeeded", duration_ms: Date.now() - startTime, output_chars: 0 });
      worker._releaseLease(job, leaseToken, "succeeded");
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
      return;
    }
    assertPromoteCopyPlan(plannedCopies, { cwd: promCwd });
    const conflictPreview = buildPromoteConflictPreview({ copies: plannedCopies, cwd: promCwd });
    if (conflictPreview.existing_count > 0) {
      const previewText = formatPromoteConflictPreview(conflictPreview);
      worker.emit(job.id, `${C.yellow}[promote]${C.reset} WI#${job.work_item_id} job #${job.id}: ${previewText.split("\n")[0]}`);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.attempt.id,
        event_type: EVENT_TYPES.JOB_PROMOTE_CONFLICT_PREVIEW,
        actor_type: EVENT_ACTORS.WORKER,
        message: previewText,
        event_json: JSON.stringify(conflictPreview),
      });
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.attempt.id,
        artifact_type: "log",
        content_long: previewText,
        content_json: conflictPreview,
      });
    }
    assertPromoteOverwritePolicy(conflictPreview, {
      allowOverwrite: payload.allow_overwrite === true,
      allowedOverwritePaths: payload.files_to_modify || [],
    });

    const copiedFiles = [];
    for (const copy of plannedCopies) {
      worker._throwIfKilled(job.id);
      copyPromoteFileSync(copy, { cwd: promCwd });
      copiedFiles.push(copy.destinationRel);
    }

    worker._throwIfKilled(job.id);
    for (const relFile of copiedFiles) {
      if (!fs.existsSync(path.join(promCwd, relFile))) {
        throw new Error(`Copied file missing after write: ${relFile}`);
      }
    }

    worker._throwIfKilled(job.id);
    const existingDestinations = promotePathSet([
      ...(conflictPreview.overwrites || []).map((entry) => entry.destination),
      ...(conflictPreview.identical_existing || []).map((entry) => entry.destination),
    ]);
    const copiedModifyFiles = copiedFiles.filter((file) => existingDestinations.has(normalizePromotePolicyPath(file)));
    const copiedCreateFiles = copiedFiles.filter((file) => !existingDestinations.has(normalizePromotePolicyPath(file)));
    const commitMsg = `posse: promote artifacts - ${job.title}`;
    const { hash: commitHash } = await gitCommitAllAsync(commitMsg, promCwd, {
      modifyFiles: copiedModifyFiles,
      createFiles: copiedCreateFiles,
      createRoots: [...new Set(copiedCreateFiles.map((file) => path.posix.dirname(file)).filter((dir) => dir && dir !== "."))],
    }, {
      projectDir: worker.projectDir,
      wiId: job.work_item_id,
      branchName: getWorkItem(job.work_item_id)?.branch_name || null,
      snapshotReason: `promote-scope-enforcement-job-${job.id}`,
      jobId: job.id,
    });

    setAttemptCommitHash(attempt.attempt.id, commitHash);
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      observation_type: "git.commit",
      summary: `Promote commit ${commitHash.slice(0, 8)}`,
      detail: { cwd: promCwd, commit_hash: commitHash, files: copiedFiles },
    });
    worker.emit(job.id, `${C.magenta}[promote]${C.reset} WI#${job.work_item_id} job #${job.id}: copied ${copiedFiles.length} file(s) -> ${commitHash.slice(0, 8)}`);
    worker._kickAtlasReindex(job, commitHash);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      event_type: EVENT_TYPES.JOB_PROMOTE_COMPLETE,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Promoted ${copiedFiles.length} file(s): ${copiedFiles.join(", ")}`,
    });
    const partial = missingMappings.length > 0
      ? spawnMissingFileRepair(worker, job, payload, { sourceDir, missingMappings, source: missingRepairSource, attemptId: attempt.attempt.id })
      : null;
    const deferred = [];
    for (const group of deferredByRepair.values()) {
      const { followupJob } = spawnFollowupPromote(worker, job, payload, { mappings: group.mappings, repairJob: group.repairJob, attemptId: attempt.attempt.id });
      deferred.push({ repair_job_id: group.repairJob.id, followup_job_id: followupJob.id, names: group.mappings.map((mapping) => mapping.pattern) });
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.attempt.id,
        event_type: EVENT_TYPES.JOB_PROMOTE_PARTIAL,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Deferred ${group.mappings.length} image(s) awaiting repair #${group.repairJob.id} to follow-up promote #${followupJob.id}: ${group.mappings.map((mapping) => mapping.pattern).join(", ")}`,
        event_json: JSON.stringify({ deferred: group.mappings.map((mapping) => mapping.pattern), repair_job_id: group.repairJob.id, followup_job_id: followupJob.id }),
      });
    }
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      artifact_type: "response",
      content_long: JSON.stringify({
        files_copied: copiedFiles,
        ...(partial ? {
          files_missing: missingMappings.map((mapping) => mapping.pattern),
          repair_job_id: partial.repairJob.id,
          followup_promote_job_id: partial.followupJob.id,
        } : {}),
        ...(deferred.length > 0 ? { files_deferred: deferred } : {}),
      }),
    });
    completeAttempt(attempt.attempt.id, {
      status: "succeeded",
      duration_ms: Date.now() - startTime,
      output_chars: copiedFiles.length,
    });
    worker._releaseLease(job, leaseToken, "succeeded");
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
  } catch (err) {
    if (worker._handleDeterministicInterruption(job, attempt.attempt.id, startTime, leaseToken, err)) {
      return;
    }
    worker.emit(job.id, `${C.red}[promote] WI#${job.work_item_id} job #${job.id} failed: ${err.message}${C.reset}`);
    if (job._worktreePath) {
      try {
        if (await gitHasChangesAsync(job._worktreePath)) {
          const siblingLocks = activeSiblingWriteLocks(job);
          if (siblingLocks.length > 0) {
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.attempt.id,
              event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
              actor_type: EVENT_ACTORS.WORKER,
              message: `Deferred promote failure dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
              event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
            });
          } else {
            try {
              await snapshotAndResetDirtyWorktreeAsync(job._worktreePath, worker.projectDir, {
                reason: `promote-failed-job-${job.id}`,
                branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                wiId: job.work_item_id,
              });
            } catch (resetErr) {
              // Snapshot refused or failed — leave the dirt for setup
              // recovery rather than wiping the only copy.
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.attempt.id,
                event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Left promote-failure dirty state in place; snapshot/reset failed: ${resetErr?.message || String(resetErr)}`,
                event_json: JSON.stringify({ reason: `promote-failed-job-${job.id}` }),
              });
            }
          }
        }
      } catch {
        // best effort cleanup
      }
    }
    completeAttempt(attempt.attempt.id, {
      status: "failed",
      duration_ms: Date.now() - startTime,
      error_text: err.message,
    });
    await wrappedJob.setError(err.message);
    worker._retryOrFail(job, leaseToken, err.message, { attemptId: attempt.attempt.id });
  }
}
