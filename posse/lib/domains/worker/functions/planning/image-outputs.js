import path from "path";
import { slugify } from "../../../../shared/format/functions/slug.js";

const REQUESTED_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|ico)\b/i;
const REQUESTED_IMAGE_PATH_RE = /(?:^|[\s"'`(])([A-Za-z0-9._@:/\\-]+?\.(?:png|jpe?g|webp|gif|avif|svg|ico))(?=$|[\s"'`),.;:])/gi;
const STRONG_IMAGE_OUTPUT_NOUN_RE = /\b(?:pngs?|jpe?gs?|webps?|image assets?|visual assets?|icons?|logos?|illustrations?|graphics?|artwork|decor(?:\s+figures?)?|figures?|hero images?|hero art|thumbnails?|banners?|sprites?|mockups?)\b/i;
const IMAGE_GENERATION_VERB_RE = /\b(?:generate|create|render|produce|regenerate|draw|make)\b/i;
const NEGATED_IMAGE_GENERATION_RE = /\b(?:do not|don't|without|no need to)\s+(?:generate|create|render|produce|regenerate|draw|make)\b[\s\S]{0,50}\b(?:images?|assets?|icons?|logos?|illustrations?|graphics?|artwork|decor|figures?|thumbnails?|banners?)\b|\bno\s+(?:new\s+)?(?:images?|assets?|icons?|logos?|illustrations?|graphics?)\b/i;
const IMAGE_SLOT_ONLY_RE = /\bimage[-\s]?slots?\b/i;

const WEB_ASSET_ANCHOR_EXTS = new Set([".css", ".scss", ".sass", ".less", ".html", ".htm", ".php"]);
const STYLE_ASSET_ANCHOR_EXTS = new Set([".css", ".scss", ".sass", ".less"]);
const PAGE_ASSET_ANCHOR_EXTS = new Set([".html", ".htm", ".php"]);
const RELATIVE_WEB_ASSET_RE = /^(?:\.\.?\/|assets\/|img\/)/i;

function hasNearbyImageGenerationIntent(text) {
  const compact = String(text || "");
  const verbRe = new RegExp(IMAGE_GENERATION_VERB_RE.source, "gi");
  for (const match of compact.matchAll(verbRe)) {
    const tail = compact.slice(match.index, match.index + 160);
    const boundaryMatch = /[.!?\r\n]+/.exec(tail);
    const localClause = boundaryMatch ? tail.slice(0, boundaryMatch.index) : tail;
    if (STRONG_IMAGE_OUTPUT_NOUN_RE.test(localClause) || REQUESTED_IMAGE_EXT_RE.test(localClause)) return true;
  }
  return false;
}

export function normalizePlannerPath(value) {
  return String(value || "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

export function normalizeCreateRootsForFiles(files = []) {
  return [...new Set((files || [])
    .map((file) => path.posix.dirname(normalizePlannerPath(file)))
    .filter((dir) => dir && dir !== "."))];
}

function candidateRelativeToAnchors(repoPath, anchors = []) {
  const normalized = normalizePlannerPath(repoPath);
  const candidates = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const anchorPath = normalizePlannerPath(anchor);
    if (!anchorPath) continue;
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(anchorPath), normalized)).replace(/^\.\//, "");
    if (!candidate || candidate === "." || candidate === ".." || candidate.startsWith("../")) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function uniqueCandidates(candidates = []) {
  return [...new Set(candidates.filter(Boolean))];
}

function candidateWebRootRelativeToAnchors(repoPath, anchors = []) {
  const normalized = normalizePlannerPath(repoPath);
  const candidates = [];
  for (const anchor of anchors) {
    const anchorPath = normalizePlannerPath(anchor);
    if (!anchorPath) continue;
    const assetIndex = anchorPath.indexOf("/assets/");
    if (assetIndex > 0) {
      candidates.push(path.posix.join(anchorPath.slice(0, assetIndex), normalized));
      continue;
    }
    const parts = anchorPath.split("/");
    if (parts.length > 1) {
      candidates.push(path.posix.join(parts[0], normalized));
    }
  }
  return uniqueCandidates(candidates);
}

export function resolveRepoImageDestination(repoPath, task = {}) {
  const normalized = normalizePlannerPath(repoPath);
  if (!normalized || !RELATIVE_WEB_ASSET_RE.test(normalized)) return normalized;

  const modifyFiles = Array.isArray(task.files_to_modify)
    ? task.files_to_modify.map(normalizePlannerPath).filter(Boolean)
    : [];
  const createFiles = Array.isArray(task.files_to_create)
    ? task.files_to_create.map(normalizePlannerPath).filter(Boolean)
    : [];
  const webAnchors = [...new Set([...modifyFiles, ...createFiles])]
    .filter((file) => WEB_ASSET_ANCHOR_EXTS.has(path.posix.extname(file).toLowerCase()));
  if (webAnchors.length === 0) return normalized;

  const styleAnchors = webAnchors.filter((file) => STYLE_ASSET_ANCHOR_EXTS.has(path.posix.extname(file).toLowerCase()));
  if (/^\.\.?\//.test(normalized) && styleAnchors.length > 0) {
    const styleCandidates = candidateRelativeToAnchors(normalized, styleAnchors);
    if (styleCandidates.length === 1) return styleCandidates[0];
  }

  const pageAnchors = webAnchors.filter((file) => PAGE_ASSET_ANCHOR_EXTS.has(path.posix.extname(file).toLowerCase()));
  if (/^(?:assets|img)\//i.test(normalized)) {
    const pageCandidates = candidateRelativeToAnchors(normalized, pageAnchors);
    const rootCandidates = candidateWebRootRelativeToAnchors(normalized, webAnchors);
    const candidates = uniqueCandidates([...pageCandidates, ...rootCandidates]);
    if (candidates.length === 1) return candidates[0];
  }

  return normalized;
}

export function normalizeRequestedImageOutput(value) {
  const normalized = normalizePlannerPath(value)
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!normalized || !REQUESTED_IMAGE_EXT_RE.test(normalized)) return null;
  if (/^https?:\/\//i.test(normalized) || /^data:/i.test(normalized)) return null;
  return normalized;
}

export function collectRequestedImageOutputs(task = {}) {
  const candidates = [];
  const appendArray = (value) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") {
        candidates.push(item);
      } else if (item && typeof item === "object") {
        candidates.push(item.path, item.file, item.filename, item.name, item.dest, item.output);
      }
    }
  };
  appendArray(task.files_to_create);
  appendArray(task.expected_outputs);
  appendArray(task.output_files);
  appendArray(task.deliverables);
  appendArray(task.outputs);
  if (task.outputs && typeof task.outputs === "object" && !Array.isArray(task.outputs)) {
    appendArray(task.outputs.files);
    appendArray(task.outputs.images);
    appendArray(task.outputs.assets);
  }

  const text = [
    task.title || "",
    task.task_spec || "",
    task.instructions || "",
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria || ""]),
  ].join("\n");
  for (const match of String(text || "").matchAll(REQUESTED_IMAGE_PATH_RE)) {
    if (match?.[1]) candidates.push(match[1]);
  }

  const outputs = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeRequestedImageOutput(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    outputs.push(normalized);
  }
  return outputs;
}

export function hasRequestedImageGenerationOutput(task = {}, { pathOnlyIsIntent = true } = {}) {
  if (pathOnlyIsIntent && collectRequestedImageOutputs(task).length > 0) return true;
  const text = [
    task.title || "",
    task.task_spec || "",
    task.instructions || "",
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria || ""]),
  ].join("\n");
  const compact = String(text || "");
  if (!compact.trim()) return false;
  if (NEGATED_IMAGE_GENERATION_RE.test(compact)) return false;
  if (IMAGE_SLOT_ONLY_RE.test(compact) && !STRONG_IMAGE_OUTPUT_NOUN_RE.test(compact.replace(IMAGE_SLOT_ONLY_RE, ""))) {
    return false;
  }
  return hasNearbyImageGenerationIntent(compact);
}

export function artifactBasenameForRepoImage(repoPath, usedNames) {
  const normalized = normalizePlannerPath(repoPath);
  const base = path.posix.basename(normalized);
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  const dirSlug = path.posix.dirname(normalized)
    .replace(/^\.+\/?/, "");
  const safeDirSlug = slugify(dirSlug, { fallback: "image" });
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = `${safeDirSlug}-${stem}${ext}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${safeDirSlug}-${stem}-${counter}${ext}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

export function uniqueNormalizedPlannerPaths(paths = []) {
  const seen = new Set();
  const out = [];
  for (const value of paths || []) {
    const normalized = normalizePlannerPath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
