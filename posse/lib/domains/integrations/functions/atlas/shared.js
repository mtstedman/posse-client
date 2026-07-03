import path from "path";
import { slugify } from "../../../../shared/format/functions/slug.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { isAbortError, signalAbortError } from "../../../runtime/functions/yield.js";
import { gitCurrentHash, gitCurrentHashAsync } from "../../../git/functions/utils.js";

export function normalizeAbsolutePath(value) {
  if (!value || !String(value).trim()) return null;
  return path.resolve(String(value).trim());
}

export function pathsEqual(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

export function isPathWithin(child, parent) {
  if (!child || !parent) return false;
  return isInsideRoot(child, parent, { allowEqual: false });
}

export function deriveRepoId(repoPath) {
  if (!repoPath) return null;
  const base = path.basename(repoPath).trim();
  return base || null;
}

export function sanitizeRepoToken(value) {
  return slugify(value, { alphabet: "filename", fallback: "repo" });
}

export function getCurrentGitHead(cwd) {
  try {
    const sha = String(gitCurrentHash(cwd || process.cwd()) || "").trim();
    return sha || null;
  } catch { /* ignore */ }
  return null;
}

export function getCurrentGitHeadAsync(cwd, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signalAbortError(signal));
      return;
    }
    gitCurrentHashAsync(cwd || process.cwd(), { timeoutMs: 5000, signal })
      .then((sha) => resolve(String(sha || "").trim() || null))
      .catch((err) => {
        if (isAbortError(err)) reject(signalAbortError(signal));
        else resolve(null);
      });
  });
}
