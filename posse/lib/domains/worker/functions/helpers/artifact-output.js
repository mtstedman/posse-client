// lib/domains/worker/functions/helpers/artifact-output.js
//
// Helpers for artifact manifests, artificer result parsing, and fallback
// artifact materialization when the model returns usable content without files.

import fs from "fs";
import path from "path";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";

export function filterNewOrChangedManifestFiles(fullManifest, preManifestState = null) {
  const files = Array.isArray(fullManifest?.files) ? fullManifest.files : [];
  if (!preManifestState || preManifestState.size === 0) return fullManifest;
  const changedFiles = files.filter((entry) => {
    const rel = String(entry?.path || "").replace(/\\/g, "/");
    const prev = preManifestState.get(rel);
    if (!prev) return true;
    return prev.size !== entry.size || prev.mtimeMs !== entry.mtimeMs || prev.ext !== entry.ext;
  });
  const changedSize = changedFiles.reduce((sum, file) => sum + file.size, 0);
  return {
    files: changedFiles,
    totalSize: changedSize,
    count: changedFiles.length,
    errors: fullManifest?.errors,
  };
}

export function hasStructuredArtificerLog(output = "") {
  const text = String(output || "");
  const match = text.match(/---\s*ARTIFICER (RESULT|LOG) START\s*---\s*([\s\S]*?)---\s*ARTIFICER \1 END\s*---/i);
  if (!match) return false;
  return /status:\s*(COMPLETE|BLOCKED|PARTIAL)/i.test(match[2] || "");
}

export function extractArtificerLog(output = "") {
  const text = String(output || "");
  const match = text.match(/---\s*ARTIFICER (RESULT|LOG) START\s*---\s*([\s\S]*?)---\s*ARTIFICER \1 END\s*---/i);
  return match ? match[2].trim() : "";
}

export function structuredArtificerStatus(output = "") {
  const logBlock = extractArtificerLog(output);
  const match = logBlock.match(/status:\s*(COMPLETE|BLOCKED|PARTIAL)/i);
  return match ? match[1].toUpperCase() : null;
}

export function artifactOutputClaimsReusableComplete(output = "") {
  const status = structuredArtificerStatus(output);
  if (status) return status === "COMPLETE";

  const text = String(output || "");
  if (/\b(?:cannot|can't|couldn't|did not|didn't|not|failed to|unable to|won't)\s+(?:reuse|reusing|complete|find|write|generate|produce)\b/i.test(text)) {
    return false;
  }
  return /\b(?:already (?:exists|generated|present|in place)|reus(?:ed|ing)|no changes needed|nothing to (?:generate|write|do)|up[- ]to[- ]date|left unchanged|kept existing)\b/i.test(text);
}

export function stripArtificerLog(output = "") {
  return String(output || "")
    .replace(/---\s*ARTIFICER (RESULT|LOG) START\s*---[\s\S]*?---\s*ARTIFICER \1 END\s*---/i, "")
    .trim();
}

export function fallbackArtifactCandidate(taskMode, payload = {}) {
  const outputRoot = payload.output_root || null;
  const expectedFiles = Array.isArray(payload.files_to_create) ? payload.files_to_create.filter(Boolean) : [];
  const textExtensions = new Set([".md", ".txt", ".html"]);
  for (const filePath of expectedFiles) {
    const normalized = String(filePath).replace(/\\/g, "/");
    const ext = path.extname(normalized).toLowerCase();
    if (!textExtensions.has(ext)) continue;
    if (!outputRoot) return normalized;
    const normalizedRoot = String(outputRoot).replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === normalizedRoot || !normalized.startsWith(`${normalizedRoot}/`)) continue;
    return normalized.slice(normalizedRoot.length + 1);
  }
  if (taskMode === "report") return "report.md";
  return null;
}

export function buildFallbackArtifactContent(output = "", job = null) {
  const narrative = stripArtificerLog(output);
  const logBlock = extractArtificerLog(output);
  const title = job?.title || "Generated report";
  const sections = [`# ${title}`];

  if (narrative) sections.push("", narrative);
  if (logBlock) sections.push("", "## Completion Log", "", "```text", logBlock, "```");

  return sections.join("\n").trim() + "\n";
}

function resolveFallbackArtifactTarget(outputRootAbs, candidate) {
  const raw = String(candidate || "").replace(/\\/g, "/").trim();
  if (!raw || raw === "." || raw === "..") return null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return null;

  const targetAbs = path.resolve(outputRootAbs, raw);
  return isInsideRoot(targetAbs, outputRootAbs) ? targetAbs : null;
}

export function materializeFallbackArtifactOutput({ taskMode = "code", payload = {}, output = "", projectDir = ".", job = null } = {}) {
  if (taskMode !== "report") return null;
  if (!payload.output_root || !String(output || "").trim()) return null;

  const candidate = fallbackArtifactCandidate(taskMode, payload);
  if (!candidate) return null;

  const projectRoot = path.resolve(projectDir);
  const outputRootAbs = path.resolve(projectRoot, payload.output_root);
  if (!isInsideRoot(outputRootAbs, projectRoot)) return null;

  const targetAbs = resolveFallbackArtifactTarget(outputRootAbs, candidate);
  if (!targetAbs) return null;

  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, buildFallbackArtifactContent(output, job), "utf-8");
  return targetAbs;
}
