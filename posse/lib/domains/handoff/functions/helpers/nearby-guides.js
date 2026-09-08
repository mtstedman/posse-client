import fs from "node:fs";
import path from "node:path";

import {
  REPOSITORY_GUIDE_FILENAMES,
  REPOSITORY_GUIDE_LIMITS as LIMITS,
} from "../../../../catalog/repository-guides.js";
import { resolveDeterministicReadableFile } from "../../../../shared/tools/functions/toolkit/path-policy.js";

function canonicalCandidate(value) {
  return typeof value === "string" && value.length <= LIMITS.pathChars
    && !/[\\\x00-\x1f\x7f]/u.test(value)
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

// Breadth-first ancestors preserve nearby package guides for scattered scopes.
// Reserve one directory for root guidance even when candidates are deeply nested.
function guideDirectories(candidateFiles) {
  const dirs = new Set();
  let level = candidateFiles.filter(canonicalCandidate).slice(0, LIMITS.candidateFiles)
    .map((file) => path.posix.dirname(file));
  while (level.length && dirs.size < LIMITS.directories - 1) {
    const next = [];
    for (const dir of level) {
      if (dir === "." || dirs.has(dir)) continue;
      dirs.add(dir);
      next.push(path.posix.dirname(dir));
      if (dirs.size >= LIMITS.directories - 1) break;
    }
    level = next;
  }
  return [...dirs, "."];
}

/** Discover filenames only; contents must pass the normal read/citation path. */
export function collectNearbyGuides(cwd, candidateFiles = []) {
  if (typeof cwd !== "string" || !cwd) return [];
  let root;
  try { root = fs.realpathSync(cwd); } catch { return []; }
  const guides = [];
  let renderedChars = 0;
  for (const dir of guideDirectories(Array.isArray(candidateFiles) ? candidateFiles : [])) {
    for (const name of REPOSITORY_GUIDE_FILENAMES) {
      const relative = dir === "." ? name : `${dir}/${name}`;
      if (relative.length > LIMITS.pathChars) continue;
      const absolute = path.resolve(root, relative);
      try {
        // Navigation never follows a file or ancestor symlink, even within root.
        if (fs.realpathSync(absolute) !== absolute) continue;
      } catch { continue; }
      if (!resolveDeterministicReadableFile(root, relative).ok) continue;
      const chars = JSON.stringify(relative).length + (guides.length ? 2 : 0);
      if (renderedChars + chars > LIMITS.renderedPathChars) continue;
      guides.push(relative);
      renderedChars += chars;
      if (guides.length >= LIMITS.paths) return guides;
    }
  }
  return guides;
}

export function renderNearbyGuides(paths, { trim = 0 } = {}) {
  if (trim >= 2 || !Array.isArray(paths)) return [];
  const selected = [];
  let chars = 0;
  for (const file of [...new Set(paths)].filter(canonicalCandidate)) {
    const rendered = JSON.stringify(file);
    if (chars + rendered.length + (selected.length ? 2 : 0) > LIMITS.renderedPathChars) continue;
    selected.push(rendered);
    chars += rendered.length + (selected.length > 1 ? 2 : 0);
    if (selected.length >= LIMITS.paths) break;
  }
  return selected.length ? [
    `Nearby guides/manifests (paths only; partial): ${selected.join(", ")}.`,
    "These files are outside the code survey; inspect only if they affect the requested behavior.",
  ] : [];
}
