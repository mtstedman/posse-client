// lib/domains/planning/functions/plan-routing.js
//
// Planner validation and routing helpers for repo-vs-artifact decisions,
// promote inference, and structured-data task normalization.

import fs from "fs";
import path from "path";
import { REPO_CODE_EXTENSIONS } from "../../../catalog/files.js";
import { isArtifactMode } from "../../artifacts/functions/index.js";
import { validateMutableRepoPath } from "../../runtime/functions/protected-paths.js";
import { validateCreateRootPath, validateScopedPath } from "../../../shared/scope/functions/validation.js";
import { resolvePathWithin } from "../../../shared/scope/functions/path.js";

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateArtifactRootPath(value, label) {
  if (typeof value !== "string") return `${label} must be a string`;
  const raw = value;
  const trimmed = raw.trim();
  if (!trimmed) return `${label} must not be empty`;
  if (trimmed !== raw) return `${label} must not have leading/trailing whitespace`;
  if (trimmed === "*" || trimmed === "." || trimmed === "./" || trimmed === ".\\") {
    return `${label} must not grant repo-wide write scope`;
  }
  if (/[\r\n\t]/.test(trimmed)) return `${label} must be a single-line path`;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return `${label} must reference a directory below the repo root`;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `${label} must not traverse directories`;
  }
  return null;
}

export const REPO_CODE_EXTS = REPO_CODE_EXTENSIONS;

export const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif",
  ".bmp", ".tif", ".tiff", ".ico",
]);

const CODE_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "rakefile",
  "gemfile",
  "procfile",
  "vagrantfile",
]);

const CODE_DOTFILES = new Set([
  ".htaccess",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  ".eslintrc",
  ".prettierrc",
  ".prettierignore",
  ".eslintignore",
  ".stylelintrc",
]);

function normalizePlannerPath(value) {
  return String(value || "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

function normalizeArtifactRoot(value) {
  return normalizePlannerPath(value).replace(/\/+$/, "");
}

export function isArtifactScopedPath(file, artifactDirAbs) {
  const normalized = normalizeArtifactRoot(file);
  if (!normalized) return false;
  const artifactRoot = normalizeArtifactRoot(artifactDirAbs);
  const artifactPathRe = /(?:^|\/)\.posse\/resources\/artifacts(?:\/|$)/;
  return normalized === artifactRoot
    || (!!artifactRoot && normalized.startsWith(`${artifactRoot}/`))
    || artifactPathRe.test(normalized);
}

export function classifyCreateFileKind(file, artifactDirAbs = "") {
  const normalized = normalizePlannerPath(file);
  if (!normalized) return "unknown";
  const basename = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(normalized).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (REPO_CODE_EXTS.has(ext) || CODE_BASENAMES.has(basename) || CODE_DOTFILES.has(basename)) return "code";
  if (ext === ".svg") return "ambiguous_image";
  if (isArtifactScopedPath(normalized, artifactDirAbs)) return "artifact";
  return "other";
}

export function getCreateFileKindSummary(task, artifactDirAbs = "") {
  const createFiles = Array.isArray(task?.files_to_create)
    ? task.files_to_create.map(normalizePlannerPath).filter(Boolean)
    : [];
  const summary = {
    createFiles,
    codeFiles: [],
    imageFiles: [],
    repoImageFiles: [],
    artifactImageFiles: [],
    ambiguousImageFiles: [],
    otherFiles: [],
  };
  for (const file of createFiles) {
    const kind = classifyCreateFileKind(file, artifactDirAbs);
    if (kind === "code") summary.codeFiles.push(file);
    else if (kind === "image") {
      summary.imageFiles.push(file);
      if (isArtifactScopedPath(file, artifactDirAbs)) summary.artifactImageFiles.push(file);
      else summary.repoImageFiles.push(file);
    } else if (kind === "ambiguous_image") {
      summary.ambiguousImageFiles.push(file);
      summary.otherFiles.push(file);
    } else {
      summary.otherFiles.push(file);
    }
  }
  return summary;
}

export function looksLikeFileDestination(dest) {
  const normalized = String(dest || "").replace(/\\/g, "/").trim();
  if (!normalized) return false;
  const base = path.posix.basename(normalized);
  return base.includes(".") && base !== "." && base !== "..";
}

export function validatePromoteDestinationPath(value, label = "promote mapping.dest") {
  if (typeof value !== "string") return `${label} must be a string`;
  const raw = value;
  const trimmed = raw.trim();
  if (!trimmed) return `${label} must not be empty`;
  if (trimmed !== raw) return `${label} must not have leading/trailing whitespace`;
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("\\\\")) {
    return `${label} must be repo-relative, not absolute`;
  }
  if (/[\r\n\t]/.test(trimmed)) return `${label} must be a single-line path`;
  if (/[<>"`?*|]/.test(trimmed)) return `${label} contains invalid filename characters`;

  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return `${label} must reference a path below the repo root`;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `${label} must not traverse directories`;
  }
  const protectedErr = validateMutableRepoPath(normalized, label, { allowRuntimeResources: false });
  if (protectedErr) return protectedErr;
  return null;
}

const ARTIFACT_SOURCE_PATTERN = String.raw`(?:\b(?:artifacts?|generated|outputs?|deliverables?|source_dir|output_root)\b|\.posse\/resources\/artifacts|(?:markdown|json|csv|data|image|report)\s+(?:artifacts?|outputs?|deliverables?))`;
const ARTIFACT_SOURCE_RE = new RegExp(ARTIFACT_SOURCE_PATTERN);
const PROMOTE_ACTION_PATTERN = String.raw`(?:promote|copy|install|publish|place|move)`;
const PROMOTE_ACTION_NEAR_ARTIFACT_RE = new RegExp(
  String.raw`\b${PROMOTE_ACTION_PATTERN}\b[\s\S]{0,120}${ARTIFACT_SOURCE_PATTERN}|${ARTIFACT_SOURCE_PATTERN}[\s\S]{0,120}\b${PROMOTE_ACTION_PATTERN}\b`
);
const PROMOTE_DESTINATION_RE = /\b(?:into|to|under|within|dest(?:ination)?|repo(?:sitory)?|public|htdocs|assets?|docs?|snapshots?)\b|(?:^|\/)(?:public|htdocs|assets|docs|data)\//;
const COMMON_WEB_ROOTS = Object.freeze(["", "htdocs", "public", "public_html", "www", "web", "static"]);

function hasExplicitPromoteFields(task) {
  return (typeof task?.source_dir === "string" && task.source_dir.trim())
    || (Array.isArray(task?.mappings) && task.mappings.length > 0);
}

function hasExplicitArtifactCopyIntent(task, text) {
  if (hasExplicitPromoteFields(task)) return true;
  return PROMOTE_ACTION_NEAR_ARTIFACT_RE.test(text) && PROMOTE_DESTINATION_RE.test(text);
}

export function inferPromoteTask(task, artifactDirAbs) {
  if (!task || task.job_type !== "dev") return null;

  const createFiles = Array.isArray(task.files_to_create) ? task.files_to_create.filter(Boolean) : [];
  if (createFiles.length === 0) return null;
  if (Array.isArray(task.files_to_modify) && task.files_to_modify.length > 0) return null;
  const kindSummary = getCreateFileKindSummary(task, artifactDirAbs);
  if (kindSummary.codeFiles.length > 0) return null;

  const text = [task.title, task.task_spec, task.instructions].filter(Boolean).join("\n").toLowerCase();
  const artifactTaskMode = isArtifactMode(task.task_mode || "code");
  const explicitPromoteFields = hasExplicitPromoteFields(task);
  const explicitArtifactCopyIntent = hasExplicitArtifactCopyIntent(task, text);
  const mentionsArtifactSource = ARTIFACT_SOURCE_RE.test(text);
  const commonArtifactExts = new Set([".md", ".txt", ".json", ".csv"]);
  const createFileExts = [...new Set(createFiles.map((file) => path.posix.extname(String(file).replace(/\\/g, "/")).toLowerCase()).filter(Boolean))];
  const targetsOnlyCommonArtifactFiles = createFileExts.length > 0 && createFileExts.every((ext) => commonArtifactExts.has(ext));
  const looksLikePromote = explicitArtifactCopyIntent && (explicitPromoteFields || artifactTaskMode || mentionsArtifactSource || targetsOnlyCommonArtifactFiles);
  if (!looksLikePromote) return null;

  const destDirs = [...new Set(createFiles.map((file) => path.posix.dirname(String(file).replace(/\\/g, "/"))))];
  if (destDirs.length !== 1 || !destDirs[0] || destDirs[0] === ".") return null;

  const mappings = createFiles.map((file) => ({
    pattern: path.posix.basename(String(file).replace(/\\/g, "/")),
    dest: destDirs[0],
  }));

  // Artifacts are not WI-bound — a WI may legitimately promote from another
  // WI's artifact namespace (e.g., a follow-up "deploy" WI consuming an
  // earlier generation WI's output). Accept any source under
  // `.posse/resources/artifacts/`, not just this WI's subdir; only fall back
  // to the current WI's root if the planner's value escapes the namespace
  // entirely (path traversal attempt).
  const artifactsBaseAbs = artifactDirAbs ? path.dirname(artifactDirAbs) : null;
  const trimmedSource = typeof task.source_dir === "string" ? task.source_dir.trim() : "";
  let safeSourceDir = null;
  if (trimmedSource) {
    safeSourceDir = artifactsBaseAbs
      ? resolvePathWithin(artifactsBaseAbs, trimmedSource)
      : resolvePathWithin(artifactDirAbs, trimmedSource);
  }

  return {
    ...task,
    job_type: "promote",
    source_dir: safeSourceDir || artifactDirAbs,
    mappings,
  };
}

export function looksLikeArtifactGenerationTask(task, artifactDirAbs) {
  if (!task || typeof task !== "object") return false;
  if (task.job_type && task.job_type !== "dev") return false;
  if (Array.isArray(task.files_to_modify) && task.files_to_modify.length > 0) return false;

  const normalize = (value) => String(value || "").replace(/\\/g, "/").trim();
  const artifactRoot = normalize(artifactDirAbs).replace(/\/+$/, "");
  const outputRoot = normalize(task.output_root).replace(/\/+$/, "");
  const createRoots = Array.isArray(task.create_roots) ? task.create_roots.map(normalize).filter(Boolean) : [];
  const createFiles = Array.isArray(task.files_to_create) ? task.files_to_create.map(normalize).filter(Boolean) : [];
  const payloadText = [task.title, task.task_spec, task.instructions, ...(Array.isArray(task.success_criteria) ? task.success_criteria : [])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  // Action-verb guard: a task that asks for repo modifications ("assess and fix",
  // "act on findings", "research patterns then refactor X") is not a pure report
  // task even if it mentions data-collection words. Demoting it to artificer/report
  // would silently drop the modification work.
  const repoActionVerbs = /\b(fix\w*|implement\w*|refactor\w*|modif\w*|updat\w*|patch\w*|remediat\w*|appl\w*|integrat\w*|wir\w*\s+up|act\w*\s+on|address\w*\s+(?:the\s+)?findings)\b/;
  if (repoActionVerbs.test(payloadText)) return false;

  const createFilesOutsideArtifactRoot = createFiles.filter((file) =>
    file && file !== artifactRoot && !file.startsWith(`${artifactRoot}/`)
  );
  const writesRepoCodeFile = createFilesOutsideArtifactRoot.some((file) =>
    REPO_CODE_EXTS.has(path.posix.extname(file).toLowerCase())
  );
  const looksLikeFrontendRepoTask =
    writesRepoCodeFile
    && /\b(index\.html|homepage|home page|site|website|web page|frontend|front-end|html|css|javascript|js)\b/.test(payloadText);
  if (looksLikeFrontendRepoTask) return false;

  const writesToArtifactRoot =
    (!!outputRoot && (outputRoot === artifactRoot || outputRoot.startsWith(`${artifactRoot}/`)))
    || createRoots.some((root) => root === artifactRoot || root.startsWith(`${artifactRoot}/`))
    || createFiles.some((file) => file === artifactRoot || file.startsWith(`${artifactRoot}/`));

  const artifactLikeExts = new Set([".json", ".csv", ".tsv", ".md", ".txt"]);
  const artifactCreateFiles = createFiles.filter(Boolean);
  const artifactCreateExts = [...new Set(artifactCreateFiles.map((file) => path.posix.extname(file).toLowerCase()).filter(Boolean))];
  const writesStructuredArtifacts = artifactCreateExts.length > 0 && artifactCreateExts.every((ext) => artifactLikeExts.has(ext));

  const looksLikeDataCollection =
    /\b(research|collect|compile|gather|export|generate|directory|dataset|seed data|officials data|report)\b/.test(payloadText)
    && /\b(json|csv|records?|entries|rows|offices|officials|contacts?)\b/.test(payloadText);

  return writesToArtifactRoot || writesStructuredArtifacts || looksLikeDataCollection;
}

export function looksLikeStructuredDataRepoTransformTask(task, artifactDirAbs) {
  if (!task || typeof task !== "object") return false;
  if (task.job_type && task.job_type !== "dev") return false;

  const normalize = (value) => String(value || "").replace(/\\/g, "/").trim();
  const artifactRoot = normalize(artifactDirAbs).replace(/\/+$/, "");
  const modifyFiles = Array.isArray(task.files_to_modify) ? task.files_to_modify.map(normalize).filter(Boolean) : [];
  const createFiles = Array.isArray(task.files_to_create) ? task.files_to_create.map(normalize).filter(Boolean) : [];
  if (modifyFiles.length === 0) return false;
  if (createFiles.length > 0) return false;

  const structuredExts = new Set([".json", ".csv", ".tsv", ".txt"]);
  const allStructured = modifyFiles.every((file) => {
    if (!file || file === artifactRoot || file.startsWith(`${artifactRoot}/`)) return false;
    return structuredExts.has(path.posix.extname(file).toLowerCase());
  });
  if (!allStructured) return false;

  const payloadText = [
    task.title || "",
    task.task_spec || "",
    task.instructions || "",
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria || ""]),
  ].filter(Boolean).join("\n").toLowerCase();

  const transformVerb = /\b(regenerate|reformat|transform|normalize|merge|compile|synthesize|consolidate|reshape|rewrite|refresh|backfill)\b/.test(payloadText);
  const dataNoun = /\b(data|dataset|json|csv|records?|entries|rows|contacts?|offices?|officials?)\b/.test(payloadText);
  const codeIntent = /\b(function|class|api|endpoint|schema|frontend|html|css|javascript|sql|migration)\b/.test(payloadText);

  return transformVerb && dataNoun && !codeIntent;
}

export function looksLikeRepoDesignTask(task, intakeHints = null) {
  if (!task || typeof task !== "object") return false;
  const hints = intakeHints && typeof intakeHints === "object" ? intakeHints : {};
  const repoBiased = hints.output_mode === "repo" || hints.deliverable_type === "code" || hints.deliverable_type === "patch";
  const hintedRepoScope = (Array.isArray(hints.suspected_files) && hints.suspected_files.length > 0)
    || (Array.isArray(hints.suspected_dirs) && hints.suspected_dirs.length > 0);
  if (!repoBiased && !hintedRepoScope) return false;

  const text = [
    task.title || "",
    task.task_spec || "",
    task.instructions || "",
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria || ""]),
  ].filter(Boolean).join("\n").toLowerCase();

  const designIntent = /\b(design|retheme|restyle|restyling|style|styling|layout|spacing|theme|background|backdrop|panel|panels|viewer|admin|page|header|footer|body|card|cards|boundary|boundaries|contrast|visual|ui|ux)\b/.test(text);
  const repoSurface = /\b(css|scss|sass|html|php|template|templates|frontend|viewer|admin|component|components|layout|page|pages)\b/.test(text);
  const explicitAssetGeneration = /\b(generate|create|render|produce)\b[\s\S]{0,40}\b(image|images|illustration|logo|icon set|graphic|artwork|mockup|thumbnail|hero image)\b/.test(text)
    || /\b(image|images|illustration|logo|icon set|graphic|artwork|mockup|thumbnail|hero image)\b[\s\S]{0,40}\b(generate|create|render|produce)\b/.test(text);

  return designIntent && repoSurface && !explicitAssetGeneration;
}

export function getExplicitIntakeBindings(workItem) {
  try {
    const metadata = workItem?.metadata_json ? JSON.parse(workItem.metadata_json) : {};
    const hints = metadata?.intake_hints && typeof metadata.intake_hints === "object" ? metadata.intake_hints : {};
    const outputMode = typeof hints.output_mode === "string" ? hints.output_mode.trim().toLowerCase() : null;
    const outputModeSource = typeof hints.output_mode_source === "string" ? hints.output_mode_source.trim().toLowerCase() : null;
    const desiredOutputsSource = typeof hints.desired_outputs_source === "string" ? hints.desired_outputs_source.trim().toLowerCase() : null;
    const deliverableTypeSource = typeof hints.deliverable_type_source === "string" ? hints.deliverable_type_source.trim().toLowerCase() : null;
    const hasSourceMetadata = !!(outputModeSource || desiredOutputsSource || deliverableTypeSource);
    const desiredOutputs = Array.isArray(hints.desired_outputs)
      ? hints.desired_outputs.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [];
    const deliverableType = typeof hints.deliverable_type === "string" ? hints.deliverable_type.trim().toLowerCase() : null;
    const hasExplicitOutputMode = (outputMode === "repo" || outputMode === "artifact" || outputMode === "question_only")
      && (!hasSourceMetadata || outputModeSource === "explicit");
    const hasExplicitDesiredOutputs = desiredOutputs.length > 0
      && (!hasSourceMetadata || desiredOutputsSource === "explicit");
    const hasExplicitDeliverableType = !!deliverableType
      && (!hasSourceMetadata || deliverableTypeSource === "explicit");
    return {
      outputMode: hasExplicitOutputMode ? outputMode : null,
      desiredOutputs: hasExplicitDesiredOutputs ? desiredOutputs : [],
      deliverableType: hasExplicitDeliverableType ? deliverableType : null,
      isBound: hasExplicitOutputMode || hasExplicitDeliverableType || hasExplicitDesiredOutputs,
    };
  } catch {
    return { outputMode: null, desiredOutputs: [], deliverableType: null, isBound: false };
  }
}

export function buildStructuredDataPromotePlan(task, artifactDirAbs) {
  const normalize = (value) => String(value || "").replace(/\\/g, "/").trim();
  const files = Array.isArray(task.files_to_modify) ? task.files_to_modify.map(normalize).filter(Boolean) : [];
  if (files.length === 0) return null;

  const mappings = files.map((dest) => ({
    pattern: path.posix.basename(dest),
    dest,
  }));

  const outputFiles = files.map((dest) => path.posix.join(artifactDirAbs.replace(/\/+$/, ""), path.posix.basename(dest)));
  return {
    artifactTask: {
      ...task,
      job_type: "artificer",
      task_mode: "content",
      output_root: artifactDirAbs,
      create_roots: [artifactDirAbs],
      files_to_modify: [],
      files_to_create: outputFiles,
      task_spec: [
        task.task_spec || task.instructions || "",
        "",
        "Produce the transformed dataset as artifact output, then let the deterministic promote step copy it into the repo.",
        "Write these output files exactly:",
        ...outputFiles.map((file) => `- ${file}`),
      ].filter(Boolean).join("\n"),
    },
    promoteTask: {
      title: `Promote: ${task.title}`,
      job_type: "promote",
      model_tier: "cheap",
      reasoning_effort: "low",
      task_spec: `Promote transformed dataset output for "${task.title}" into the repo target paths.`,
      mappings,
      source_dir: artifactDirAbs,
      files_to_modify: files,
      success_criteria: Array.isArray(task.success_criteria)
        ? task.success_criteria
        : task.success_criteria ? [task.success_criteria] : [],
      depends_on_index: [],
    },
  };
}

export function looksLikeRepoCodeCreationTask(task, artifactDirAbs) {
  if (!task || typeof task !== "object") return false;
  if (task.job_type && task.job_type !== "dev") return false;

  const normalize = (value) => String(value || "").replace(/\\/g, "/").trim();
  const artifactRoot = normalize(artifactDirAbs).replace(/\/+$/, "");
  const createFiles = Array.isArray(task.files_to_create) ? task.files_to_create.map(normalize).filter(Boolean) : [];
  if (createFiles.length === 0) return false;

  return createFiles.some((file) =>
    file
    && file !== artifactRoot
    && !file.startsWith(`${artifactRoot}/`)
    && REPO_CODE_EXTS.has(path.posix.extname(file).toLowerCase())
  );
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function pathExistsAsFile(projectDir, relPath) {
  if (!projectDir || !relPath) return false;
  const abs = resolvePathWithin(projectDir, relPath);
  if (!abs) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function pathExistsAsDir(projectDir, relPath) {
  if (!projectDir || !relPath) return false;
  const abs = resolvePathWithin(projectDir, relPath);
  if (!abs) return false;
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function rootRelativePromoteCandidates(dest, pattern, fileDest, projectDir) {
  if (!projectDir || typeof dest !== "string") return [];
  const raw = dest.replace(/\\/g, "/").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return [];
  const target = path.posix.normalize(raw.replace(/^\/+/, "")).replace(/^\.\//, "");
  if (!target || target === "." || target.startsWith("../") || path.posix.isAbsolute(target)) return [];

  const wildcard = String(pattern || "").startsWith("*.");
  const roots = COMMON_WEB_ROOTS.filter(Boolean);
  const buildCandidate = (root) => root && (target === root || target.startsWith(`${root}/`))
    ? target
    : path.posix.normalize(root ? path.posix.join(root, target) : target);
  const proofFileFor = (candidateRel) => fileDest
    ? candidateRel
    : wildcard
      ? null
      : path.posix.join(candidateRel.replace(/\/+$/, ""), pattern);
  const proofDirFor = (candidateRel) => fileDest
    ? path.posix.dirname(candidateRel)
    : candidateRel.replace(/\/+$/, "");

  const rootProofRel = proofFileFor(target);
  const rootProofDir = proofDirFor(target);
  if (
    (rootProofRel && pathExistsAsFile(projectDir, rootProofRel))
    || (rootProofDir && rootProofDir !== "." && pathExistsAsDir(projectDir, rootProofDir))
  ) {
    return [target];
  }

  const fileCandidates = [];
  for (const root of roots) {
    const candidateRel = buildCandidate(root);
    if (!candidateRel || candidateRel === "." || candidateRel.startsWith("../") || path.posix.isAbsolute(candidateRel)) {
      continue;
    }
    const proofRel = proofFileFor(candidateRel);
    if (proofRel && pathExistsAsFile(projectDir, proofRel)) fileCandidates.push(candidateRel);
  }
  const uniqueFileCandidates = uniqueValues(fileCandidates);
  if (uniqueFileCandidates.length > 0) return uniqueFileCandidates;

  const candidates = [];
  for (const root of roots) {
    const candidateRel = buildCandidate(root);
    if (!candidateRel || candidateRel === "." || candidateRel.startsWith("../") || path.posix.isAbsolute(candidateRel)) {
      continue;
    }
    const proofRel = proofFileFor(candidateRel);
    const proofDir = proofDirFor(candidateRel);
    const targetDirExists = proofDir && proofDir !== "." ? pathExistsAsDir(projectDir, proofDir) : false;
    const targetFileExists = proofRel ? pathExistsAsFile(projectDir, proofRel) : false;
    if (targetFileExists || targetDirExists) candidates.push(candidateRel);
  }
  const uniqueCandidates = uniqueValues(candidates);
  if (uniqueCandidates.length > 0) return uniqueCandidates;

  const existingWebRoots = roots.filter((root) => pathExistsAsDir(projectDir, root));
  if (
    existingWebRoots.length === 1
    && existingWebRoots[0] === "htdocs"
    && !target.startsWith("htdocs/")
  ) {
    return [path.posix.normalize(path.posix.join("htdocs", target))];
  }

  return [target];
}

export function normalizeRootRelativePromoteDest(dest, { pattern = "", fileDest = false, projectDir = null } = {}) {
  const normalizedDest = String(dest || "").replace(/\\/g, "/").trim();
  if (!normalizedDest.startsWith("/") || normalizedDest.startsWith("//")) return normalizedDest;
  const candidates = rootRelativePromoteCandidates(normalizedDest, pattern, fileDest, projectDir);
  return candidates.length === 1 ? candidates[0] : normalizedDest;
}

export function normalizePromoteMappings(task, artifactDirAbs, { projectDir = null } = {}) {
  const rawMappings = Array.isArray(task?.mappings) ? task.mappings : [];
  const sourceDir = (task?.source_dir || artifactDirAbs || "").replace(/\\/g, "/");
  const mappings = [];
  const filesToModify = [];
  const createFiles = [];
  const createRoots = new Set();
  const seenModify = new Set();
  const seenCreate = new Set();
  const concretePatterns = new Set(rawMappings
    .map((mapping) => String(mapping?.pattern || "").trim())
    .filter(Boolean));

  const normalizeOutputPath = (value) => String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
  const addModify = (file) => {
    const normalized = normalizeOutputPath(file);
    if (!normalized || validatePromoteDestinationPath(normalized, "files_to_modify")) return;
    if (seenModify.has(normalized)) return;
    seenModify.add(normalized);
    filesToModify.push(normalized);
  };
  const addCreate = (file) => {
    const normalized = normalizeOutputPath(file);
    if (!normalized || validatePromoteDestinationPath(normalized, "files_to_create")) return;
    if (seenCreate.has(normalized) || seenModify.has(normalized)) return;
    seenCreate.add(normalized);
    createFiles.push(normalized);
  };
  const destinationExists = (file) => {
    if (!projectDir) return false;
    const fullPath = resolvePathWithin(projectDir, file);
    if (!fullPath) return false;
    try {
      return fs.statSync(fullPath).isFile();
    } catch {
      return false;
    }
  };
  for (const rawModify of Array.isArray(task?.files_to_modify) ? task.files_to_modify : []) {
    addModify(rawModify);
  }

  for (const raw of rawMappings) {
    if (!raw || typeof raw !== "object") continue;
    const pattern = String(raw.pattern || "").trim();
    const rawDest = String(raw.dest || "").replace(/\\/g, "/").trim();
    if (!pattern || !rawDest) continue;
    const placeholderPattern = pattern.match(/^(.*?)(?:[-_])N(\.[A-Za-z0-9]+)$/);
    if (
      placeholderPattern
      && [...concretePatterns].some((candidate) =>
        new RegExp(`^${placeholderPattern[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-_]\\d+${placeholderPattern[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(candidate)
      )
    ) {
      continue;
    }

    const wildcard = pattern.startsWith("*.");
    const rawFileDest = !wildcard && looksLikeFileDestination(rawDest);
    const dest = normalizeRootRelativePromoteDest(rawDest, {
      pattern,
      fileDest: rawFileDest,
      projectDir,
    });
    if (rawDest.startsWith("/") && !rawDest.startsWith("//") && dest.startsWith("/")) continue;
    const fileDest = !wildcard && looksLikeFileDestination(dest);
    const destDir = fileDest ? path.posix.dirname(dest) : dest.replace(/\/+$/, "");
    if (validatePromoteDestinationPath(dest)) continue;

    if (!wildcard) {
      const destFile = fileDest ? dest : path.posix.join(dest.replace(/\/+$/, ""), pattern);
      if (seenModify.has(normalizeOutputPath(destFile)) || destinationExists(destFile)) {
        addModify(destFile);
      } else {
        addCreate(destFile);
        if (destDir && destDir !== ".") createRoots.add(destDir);
      }
    } else if (destDir && destDir !== ".") {
      createRoots.add(destDir);
    }

    mappings.push({
      pattern,
      dest,
      destination_type: fileDest ? "file" : "directory",
    });
  }

  return {
    source_dir: sourceDir,
    mappings,
    files_to_modify: filesToModify,
    files_to_create: [...new Set(createFiles)],
    create_roots: [...createRoots],
    ...(task?.allow_overwrite === true ? { allow_overwrite: true } : {}),
  };
}

export function validatePlannedTask(task, index, taskCount) {
  const errors = [];
  if (!task || typeof task !== "object") {
    return ["task must be an object"];
  }

  if (!task.title || typeof task.title !== "string" || !task.title.trim()) {
    errors.push("title is required");
  }

  const jobType = task.job_type || "dev";
  const depends = task.depends_on_index;
  if (depends != null) {
    if (!Array.isArray(depends)) {
      errors.push("depends_on_index must be an array");
    } else {
      for (const depIdx of depends) {
        if (!Number.isInteger(depIdx)) {
          errors.push(`depends_on_index contains non-integer value: ${depIdx}`);
          continue;
        }
        if (depIdx < 0 || depIdx >= taskCount) {
          errors.push(`depends_on_index ${depIdx} is out of range`);
        } else if (depIdx === index) {
          errors.push(`depends_on_index ${depIdx} cannot reference itself`);
        }
      }
    }
  }

  if (jobType === "promote") {
    if (!Array.isArray(task.mappings) || task.mappings.length === 0) {
      errors.push("promote tasks require a non-empty mappings array");
    } else {
      for (const mapping of task.mappings) {
        if (!mapping || typeof mapping !== "object") {
          errors.push("each promote mapping must be an object");
          continue;
        }
        if (!mapping.pattern || typeof mapping.pattern !== "string") {
          errors.push("promote mapping.pattern is required");
        }
        if (!mapping.dest || typeof mapping.dest !== "string") {
          errors.push("promote mapping.dest is required");
        } else {
          const err = validatePromoteDestinationPath(mapping.dest, "promote mapping.dest");
          if (err) errors.push(err);
        }
        if (typeof mapping.pattern === "string" && mapping.pattern.startsWith("*.") && looksLikeFileDestination(mapping.dest)) {
          errors.push("wildcard promote mappings must target a directory destination");
        }
      }
    }
    return errors;
  }

  if (!task.task_spec && !task.instructions) {
    errors.push("task_spec is required");
  }

  if (task.success_criteria == null) {
    errors.push("success_criteria is required");
  } else if (!(Array.isArray(task.success_criteria) || typeof task.success_criteria === "string")) {
    errors.push("success_criteria must be a string or array");
  }

  if (jobType === "dev" || !task.job_type) {
    if (task.files_to_modify != null && !isStringArray(task.files_to_modify)) {
      errors.push("files_to_modify must be an array of strings");
    } else if (Array.isArray(task.files_to_modify)) {
      for (let i = 0; i < task.files_to_modify.length; i++) {
        const err = validateScopedPath(task.files_to_modify[i], `files_to_modify[${i}]`);
        if (err) errors.push(err);
      }
    }
    if (task.files_to_create != null && !isStringArray(task.files_to_create)) {
      errors.push("files_to_create must be an array of strings");
    } else if (Array.isArray(task.files_to_create)) {
      for (let i = 0; i < task.files_to_create.length; i++) {
        const err = validateScopedPath(task.files_to_create[i], `files_to_create[${i}]`);
        if (err) errors.push(err);
      }
    }
    if (task.files_to_delete != null && !isStringArray(task.files_to_delete)) {
      errors.push("files_to_delete must be an array of strings");
    } else if (Array.isArray(task.files_to_delete)) {
      for (let i = 0; i < task.files_to_delete.length; i++) {
        const err = validateScopedPath(task.files_to_delete[i], `files_to_delete[${i}]`);
        if (err) errors.push(err);
      }
    }
    if (task.create_roots != null && !isStringArray(task.create_roots)) {
      errors.push("create_roots must be an array of strings");
    } else if (Array.isArray(task.create_roots)) {
      for (let i = 0; i < task.create_roots.length; i++) {
        const err = validateCreateRootPath(task.create_roots[i], `create_roots[${i}]`);
        if (err) errors.push(err);
      }
    }
  }

  if (jobType === "artificer") {
    if (task.output_root != null) {
      const err = validateArtifactRootPath(task.output_root, "output_root");
      if (err) errors.push(err);
    }
    if (task.create_roots != null && !isStringArray(task.create_roots)) {
      errors.push("create_roots must be an array of strings");
    } else if (Array.isArray(task.create_roots)) {
      for (let i = 0; i < task.create_roots.length; i++) {
        const err = validateArtifactRootPath(task.create_roots[i], `create_roots[${i}]`);
        if (err) errors.push(err);
      }
    }
  }

  if (task.task_mode != null && typeof task.task_mode !== "string") {
    errors.push("task_mode must be a string");
  }

  if (task.deepthink != null && typeof task.deepthink !== "boolean") {
    errors.push("deepthink must be a boolean");
  }
  if (task.deepthink_budget != null) {
    const budget = String(task.deepthink_budget || "").trim().toLowerCase();
    if (!["low", "normal", "high", "xhigh"].includes(budget)) {
      errors.push("deepthink_budget must be one of low, normal, high, xhigh");
    }
  }

  if (task.skills != null && !isStringArray(task.skills)) {
    errors.push("skills must be an array of strings");
  }
  if (task.dev_brief != null && (!task.dev_brief || typeof task.dev_brief !== "object" || Array.isArray(task.dev_brief))) {
    errors.push("dev_brief must be an object");
  }

  return errors;
}
