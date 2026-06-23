import path from "path";
import fs from "fs";
import { normPath, normalizeRoots, isUnderRoot } from "../../../../shared/scope/functions/path.js";
import { validateMutableRepoPath } from "../../../runtime/functions/protected-paths.js";
import { DECLARED_OUTPUT_CONTRACT_JOB_TYPES } from "../../../../catalog/job.js";

function normalizeDeclaredOutputPath(filePath, cwd) {
  return normalizeFileRequestScopePath(filePath, cwd);
}

function uniqueNormalizedPaths(paths = [], cwd = process.cwd()) {
  const out = [];
  const seen = new Set();
  for (const pathValue of Array.isArray(paths) ? paths : []) {
    const normalized = normalizeDeclaredOutputPath(pathValue, cwd);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function declaredOutputContractDisabled(payload = {}) {
  return payload?.declared_output_contract === false
    || payload?.declared_output_contract === "false"
    || payload?._skip_output_contract === true
    || payload?._skip_output_contract === "true"
    || payload?._allow_missing_declared_outputs === true
    || payload?._allow_missing_declared_outputs === "true";
}

async function pathExistsInWorktreeAsync(cwd, relativePath) {
  if (!relativePath) return false;
  const resolved = path.resolve(cwd || process.cwd(), relativePath);
  try {
    await fs.promises.access(resolved);
    return true;
  } catch {
    return false;
  }
}

export async function validateDeclaredOutputContract({
  job,
  payload = {},
  filesCommitted = [],
  cwd = process.cwd(),
} = {}) {
  if (!DECLARED_OUTPUT_CONTRACT_JOB_TYPES.has(job?.job_type)) return { ok: true };
  if (declaredOutputContractDisabled(payload)) return { ok: true, skipped: true };

  // normPath lowercases on win32 so comparisons are case-insensitive, but
  // failure messages must show paths as the planner declared them.
  const displayByNormalized = new Map();
  for (const raw of [
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload.must_modify) ? payload.must_modify : []),
  ]) {
    const normalized = normalizeDeclaredOutputPath(raw, cwd);
    if (normalized && !displayByNormalized.has(normalized)) {
      displayByNormalized.set(normalized, String(raw).replace(/\\/g, "/").trim());
    }
  }
  const display = (paths) => paths.map((p) => displayByNormalized.get(p) || p);

  const declaredCreates = uniqueNormalizedPaths(payload.files_to_create, cwd);
  // must_modify is a hard requirement on its own; the planner is not required
  // to duplicate those paths into files_to_modify for them to be enforced.
  const declaredModifies = uniqueNormalizedPaths(
    [
      ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
      ...(Array.isArray(payload.must_modify) ? payload.must_modify : []),
    ],
    cwd,
  );
  if (declaredCreates.length === 0 && declaredModifies.length === 0) return { ok: true };

  const mustModify = new Set(uniqueNormalizedPaths(payload.must_modify, cwd));
  const committed = new Set(uniqueNormalizedPaths(filesCommitted, cwd));
  // Check all declared paths in parallel. This is in the post-commit hot
  // path so a synchronous loop of fs.existsSync over N declared files
  // would block the event loop and starve other workers' progress.
  const [createsExist, modifiesExist] = await Promise.all([
    Promise.all(declaredCreates.map((filePath) => pathExistsInWorktreeAsync(cwd, filePath))),
    Promise.all(declaredModifies.map((filePath) => pathExistsInWorktreeAsync(cwd, filePath))),
  ]);
  const missingCreates = declaredCreates.filter((_, i) => !createsExist[i]);
  const untouchedCreates = declaredCreates.filter((filePath) => !committed.has(filePath));
  // files_to_modify is allowed scope, not a work order: a dev that correctly
  // judges a declared file needs no change must not fail the attempt. Only
  // paths the planner explicitly listed in must_modify stay hard-required;
  // the rest are reported as unmodified scope for the assessor to weigh.
  const missingModifiesAll = declaredModifies.filter((_, i) => !modifiesExist[i]);
  const missingModifies = missingModifiesAll.filter((filePath) => mustModify.has(filePath));
  const untouchedModifiesAll = declaredModifies.filter((filePath) => !committed.has(filePath));
  const untouchedModifies = untouchedModifiesAll.filter((filePath) => mustModify.has(filePath));
  const unmodifiedDeclaredScope = untouchedModifiesAll.filter((filePath) => !mustModify.has(filePath));

  return {
    ok: missingCreates.length === 0
      && missingModifies.length === 0
      && untouchedCreates.length === 0
      && untouchedModifies.length === 0,
    missingCreates: display(missingCreates),
    missingModifies: display(missingModifies),
    untouchedCreates: display(untouchedCreates),
    untouchedModifies: display(untouchedModifies),
    unmodifiedDeclaredScope: display(unmodifiedDeclaredScope),
  };
}

function normalizeFileRequestScopePath(filePath, cwd) {
  if (!filePath) return "";
  const raw = String(filePath);
  const relative = path.isAbsolute(raw) ? path.relative(cwd || process.cwd(), raw) : raw;
  const normalized = normPath(relative);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

export function filterFileRequestsToOutOfScope(fileRequests, jobPayloadScope = {}, allowedDeleteScope = [], cwd = process.cwd()) {
  if (!Array.isArray(fileRequests) || fileRequests.length === 0) return fileRequests;
  const scopedFiles = [
    ...(jobPayloadScope.files_to_create || []),
    ...(jobPayloadScope.files_to_modify || []),
    ...(allowedDeleteScope || []),
  ]
    .map((filePath) => normalizeFileRequestScopePath(filePath, cwd))
    .filter(Boolean);
  const inScope = new Set(scopedFiles);
  const scopeRoots = normalizeRoots(jobPayloadScope.create_roots || [], cwd);
  return fileRequests.filter((request) => {
    const requestPath = normalizeFileRequestScopePath(request?.path, cwd);
    if (!requestPath) return false;
    if (validateMutableRepoPath(requestPath, "file_request.path")) return false;
    if (inScope.has(requestPath)) return false;
    if (isUnderRoot(requestPath, scopeRoots)) return false;
    return true;
  });
}
