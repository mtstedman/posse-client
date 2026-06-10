import path from "path";
import { execFile, spawnSync } from "child_process";
import { slugify } from "../../../../shared/format/functions/slug.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { isAbortError, signalAbortError } from "../../../runtime/functions/yield.js";

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
    const res = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }) || {};
    if (res.status === 0 && res.stdout) {
      const sha = String(res.stdout).trim();
      return sha || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function getCurrentGitHeadAsync(cwd, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signalAbortError(signal));
      return;
    }
    try {
      const options = {
        cwd: cwd || process.cwd(),
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      };
      if (signal) options.signal = signal;
      execFile("git", ["rev-parse", "HEAD"], options, (err, stdout) => {
        if (isAbortError(err)) {
          reject(signalAbortError(signal));
          return;
        }
        if (!err && stdout) {
          const sha = String(stdout).trim();
          resolve(sha || null);
          return;
        }
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}
