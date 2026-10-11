import path from "path";
import { isArtifactMode } from "../../artifacts/functions/index.js";
import { isUnderRoot, normPath, normalizeRoots } from "../../../shared/scope/functions/path.js";
import { assessmentScopePathResolver } from "../classes/AssessmentScopePathResolver.js";

export function mergeUniquePaths(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))];
}

function _scopePathCandidates(filePath, nestedRepoPrefix = null) {
  const normalized = normPath(filePath);
  if (!normalized) return [];
  const candidates = [normalized];
  if (nestedRepoPrefix) {
    const prefix = `${nestedRepoPrefix}/`;
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length);
      if (stripped) candidates.push(stripped);
    }
  }
  return [...new Set(candidates)];
}

export function findOutOfScopeCommittedFiles(filesCommitted, {
  allowedFiles = [],
  allowedCreateFiles = [],
  allowedDeleteFiles = [],
  allowedCreateRoots = [],
  cwd = process.cwd(),
  nestedRepoPrefix = null,
} = {}) {
  const effectiveNestedRepoPrefix = nestedRepoPrefix || assessmentScopePathResolver.deriveNestedRepoPrefix(cwd);
  const allAllowed = new Set([
    ...allowedFiles,
    ...allowedCreateFiles,
    ...allowedDeleteFiles,
  ].flatMap((value) => _scopePathCandidates(value, effectiveNestedRepoPrefix)));
  const normalizedRoots = normalizeRoots(allowedCreateRoots, cwd);
  return (Array.isArray(filesCommitted) ? filesCommitted : []).filter((filePath) => {
    const candidates = _scopePathCandidates(filePath, effectiveNestedRepoPrefix);
    if (candidates.length === 0) return true;
    return !candidates.some((candidate) => allAllowed.has(candidate) || isUnderRoot(candidate, normalizedRoots));
  });
}

function _requestedScopePathSet(filesRequested = [], cwd = null) {
  const out = new Set();
  for (const request of Array.isArray(filesRequested) ? filesRequested : []) {
    const value = normalizeAssessmentScopePath(request?.path, cwd);
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

  const requestedPaths = _requestedScopePathSet(assessmentContext.files_requested, cwd);
  const requestedCommitted = outOfScope.filter((filePath) =>
    requestedPaths.has(normalizeAssessmentScopePath(filePath, cwd))
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

export function normalizeAssessmentScopePath(value, cwd = null, nestedRepoPrefix = null) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  const normalized = raw.replace(/\\/g, "/");
  const prefix = nestedRepoPrefix || (cwd ? assessmentScopePathResolver.deriveNestedRepoPrefix(cwd) : null);
  if (prefix && normalized.startsWith(`${prefix}/`)) {
    return normalized.slice(prefix.length + 1);
  }
  return normalized;
}

export function buildAssessmentProviderScope({ cwd = null, assessmentContext = null } = {}) {
  if (!assessmentContext || typeof assessmentContext !== "object") {
    return { scopedFiles: [], createFiles: [], deleteFiles: [], createRoots: [] };
  }
  const nestedRepoPrefix = assessmentScopePathResolver.deriveNestedRepoPrefix(cwd);

  const scopedFiles = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_files) ? [assessmentContext.allowed_files] : []),
    ...(Array.isArray(assessmentContext.files_committed) ? [assessmentContext.files_committed] : []),
    ...(Array.isArray(assessmentContext.files_reverted) ? [assessmentContext.files_reverted] : []),
    ...(Array.isArray(assessmentContext.manifest?.files)
      ? [assessmentContext.manifest.files.map((f) => f?.path).filter(Boolean)]
      : []),
  ).map((value) => normalizeAssessmentScopePath(value, cwd, nestedRepoPrefix)).filter(Boolean);

  const createFiles = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_create_files) ? [assessmentContext.allowed_create_files] : []),
    ...(Array.isArray(assessmentContext.manifest?.files)
      ? [assessmentContext.manifest.files.map((f) => f?.path).filter(Boolean)]
      : []),
  ).map((value) => normalizeAssessmentScopePath(value, cwd, nestedRepoPrefix)).filter(Boolean);

  const deleteFiles = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_delete_files) ? [assessmentContext.allowed_delete_files] : []),
  ).map((value) => normalizeAssessmentScopePath(value, cwd, nestedRepoPrefix)).filter(Boolean);

  const createRoots = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_create_roots) ? [assessmentContext.allowed_create_roots] : []),
    ...(assessmentContext.output_root ? [normalizeAssessmentScopePath(assessmentContext.output_root, cwd, nestedRepoPrefix)] : []),
  ).filter(Boolean);

  return { scopedFiles, createFiles, deleteFiles, createRoots };
}
