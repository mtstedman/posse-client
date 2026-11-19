import path from "path";
import { isArtifactMode } from "../../artifacts/functions/index.js";
import { isUnderRoot, normPath, normalizeRoots } from "../../../shared/scope/functions/path.js";

export function mergeUniquePaths(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))];
}

// Committed files, job scopes, requests and manifests all name paths relative
// to the project directory the job ran in (`git diff --relative` for commits
// and branch net diffs), so they are compared as they are. A project nested
// in its repository makes "strip the prefix if present" ambiguous: with
// project `backend`, `backend/settings.py` is the package's file, not
// ./settings.py.
export function findOutOfScopeCommittedFiles(filesCommitted, {
  allowedFiles = [],
  allowedCreateFiles = [],
  allowedDeleteFiles = [],
  allowedCreateRoots = [],
  cwd = process.cwd(),
} = {}) {
  const allAllowed = new Set([
    ...allowedFiles,
    ...allowedCreateFiles,
    ...allowedDeleteFiles,
  ].map(normPath).filter(Boolean));
  const normalizedRoots = normalizeRoots(allowedCreateRoots, cwd);
  return (Array.isArray(filesCommitted) ? filesCommitted : []).filter((filePath) => {
    const candidate = normPath(filePath);
    if (!candidate) return true;
    return !(allAllowed.has(candidate) || isUnderRoot(candidate, normalizedRoots));
  });
}

function _requestedScopePathSet(filesRequested = []) {
  const out = new Set();
  for (const request of Array.isArray(filesRequested) ? filesRequested : []) {
    const value = normalizeAssessmentScopePath(request?.path);
    if (value) out.add(value);
  }
  return out;
}

export function buildCommittedScopeViolationVerdict(assessmentContext = null, cwd = null) {
  if (!assessmentContext || typeof assessmentContext !== "object") return null;
  const taskMode = assessmentContext.task_mode || "code";
  if (isArtifactMode(taskMode)) return null;
  if (assessmentContext.files_committed_unknown === true) {
    const detail = assessmentContext.files_committed_error
      ? ` Error: ${String(assessmentContext.files_committed_error).slice(0, 240)}`
      : "";
    return {
      verdict: "fail",
      confidence: "high",
      reasons: [
        `Deterministic scope verification failed: could not verify the actual committed files for commit ${assessmentContext.commit_hash || "(unknown)"}.${detail}`,
      ],
      spawn_jobs: [],
      human_questions: [],
      suggestions: [],
      raw: "",
    };
  }
  const filesCommitted = Array.isArray(assessmentContext.files_committed)
    ? assessmentContext.files_committed
    : [];
  if (filesCommitted.length === 0) return null;

  const outOfScope = findOutOfScopeCommittedFiles(filesCommitted, {
    // The harness hands the job the paths both sides of its target merge
    // changed; resolving them is required, so they are in scope.
    allowedFiles: mergeUniquePaths(
      assessmentContext.allowed_files || [],
      assessmentContext.merge_resolution_files || [],
    ),
    allowedCreateFiles: assessmentContext.allowed_create_files || [],
    allowedDeleteFiles: assessmentContext.allowed_delete_files || [],
    allowedCreateRoots: assessmentContext.allowed_create_roots || [],
    cwd,
  });
  if (outOfScope.length === 0) return null;

  const requestedPaths = _requestedScopePathSet(assessmentContext.files_requested);
  const requestedCommitted = outOfScope.filter((filePath) =>
    requestedPaths.has(normalizeAssessmentScopePath(filePath))
  );
  const requestedNote = requestedCommitted.length > 0
    ? ` Requested-file entries are follow-up scope, not permission for this commit: ${JSON.stringify(requestedCommitted)}.`
    : "";
  return {
    verdict: "fail",
    confidence: "high",
    reasons: [
      `Deterministic scope violation: committed out-of-scope file(s) ${JSON.stringify(outOfScope)}.${requestedNote}`,
    ],
    spawn_jobs: [],
    human_questions: [],
    suggestions: [],
    raw: "",
  };
}

export function normalizeAssessmentScopePath(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  return raw.replace(/\\/g, "/");
}

export function buildAssessmentProviderScope({ cwd = null, assessmentContext = null } = {}) {
  if (!assessmentContext || typeof assessmentContext !== "object") {
    return { scopedFiles: [], createFiles: [], deleteFiles: [], createRoots: [] };
  }
  const scopedFiles = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_files) ? [assessmentContext.allowed_files] : []),
    ...(Array.isArray(assessmentContext.files_committed) ? [assessmentContext.files_committed] : []),
    ...(Array.isArray(assessmentContext.files_reverted) ? [assessmentContext.files_reverted] : []),
    ...(Array.isArray(assessmentContext.manifest?.files)
      ? [assessmentContext.manifest.files.map((f) => f?.path).filter(Boolean)]
      : []),
  ).map((value) => normalizeAssessmentScopePath(value)).filter(Boolean);

  const createFiles = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_create_files) ? [assessmentContext.allowed_create_files] : []),
    ...(Array.isArray(assessmentContext.manifest?.files)
      ? [assessmentContext.manifest.files.map((f) => f?.path).filter(Boolean)]
      : []),
  ).map((value) => normalizeAssessmentScopePath(value)).filter(Boolean);

  const deleteFiles = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_delete_files) ? [assessmentContext.allowed_delete_files] : []),
  ).map((value) => normalizeAssessmentScopePath(value)).filter(Boolean);

  const createRoots = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_create_roots) ? [assessmentContext.allowed_create_roots] : []),
    ...(assessmentContext.output_root ? [normalizeAssessmentScopePath(assessmentContext.output_root)] : []),
  ).filter(Boolean);

  return { scopedFiles, createFiles, deleteFiles, createRoots };
}
