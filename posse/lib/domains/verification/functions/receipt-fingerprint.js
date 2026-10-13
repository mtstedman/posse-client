import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { gitExecAsync } from "../../git/functions/utils.js";
import { DIRTY_INPUT_FINGERPRINT_LIMITS, VERIFICATION_ENVIRONMENT_FILES } from "../../../catalog/verification.js";
import { sha256 } from "../../../shared/format/functions/sha256.js";

export async function currentCommit(cwd) {
  try {
    return String(await gitExecAsync(["rev-parse", "HEAD"], cwd) || "").trim() || null;
  } catch {
    return null;
  }
}

export async function currentHeadRef(cwd) {
  try {
    return String(await gitExecAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd) || "").trim() || null;
  } catch {
    return null;
  }
}

export async function repositoryFingerprint(cwd) {
  try {
    const origin = String(await gitExecAsync(["config", "--get", "remote.origin.url"], cwd) || "").trim();
    if (origin) return sha256(`origin\0${origin}`);
  } catch {
    // A local-only repository falls back to its shared Git directory below.
  }
  try {
    const commonDir = String(await gitExecAsync(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd) || "").trim();
    if (commonDir) return sha256(`git-common-dir\0${fs.realpathSync(commonDir)}`);
  } catch {
    return null;
  }
  return null;
}

export function worktreeFingerprint(commitHash, porcelainStatus) {
  if (!commitHash || porcelainStatus == null) return null;
  return sha256(`worktree-v1\0${commitHash}\0${porcelainStatus}`);
}

// Content digests of the dirty paths, or null when one escapes the root,
// cannot be read, or the set exceeds the catalog's file or byte bound (the
// caller records dirty_input_fingerprint_unavailable).
export async function dirtyPathDigests(cwd, porcelainStatus) {
  const root = path.resolve(cwd);
  const entries = [];
  const relatives = porcelainChangedPaths(porcelainStatus).sort();
  if (relatives.length > DIRTY_INPUT_FINGERPRINT_LIMITS.max_files) return null;
  let bytes = 0;
  for (const relative of relatives) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
    let digest;
    try {
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) digest = sha256(`symlink\0${await fs.promises.readlink(absolute)}`);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > DIRTY_INPUT_FINGERPRINT_LIMITS.max_bytes) return null;
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
        digest = hash.digest("hex");
      } else digest = sha256(`kind\0${stat.mode}`);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      digest = "missing";
    }
    entries.push([relative, digest]);
  }
  return entries;
}

export function dirtyFingerprintFromDigests(commitHash, porcelainStatus, digests) {
  if (!commitHash || !porcelainStatus || !digests) return null;
  return sha256(`worktree-dirty-v1\0${commitHash}\0${porcelainStatus}\0${JSON.stringify(digests)}`);
}

// Dirty receipts are historical evidence only. Hash their actual bytes so a
// second edit with the same porcelain status cannot impersonate this input.
export async function dirtyWorktreeFingerprint(cwd, commitHash, porcelainStatus) {
  if (!commitHash || !porcelainStatus) return null;
  return dirtyFingerprintFromDigests(commitHash, porcelainStatus, await dirtyPathDigests(cwd, porcelainStatus));
}

// Ignored environment files change what a test run sees without changing Git
// status. One digest over the catalog's files at the project root binds a
// receipt to them; only the digest is kept, never their contents.
export function environmentFilesFingerprint(cwd) {
  if (!cwd) return null;
  const hash = createHash("sha256").update("environment-files-v1");
  for (const name of VERIFICATION_ENVIRONMENT_FILES) {
    hash.update(`\0${name}\0`);
    try {
      const stat = fs.lstatSync(path.join(cwd, name));
      if (!stat.isFile() || stat.size > DIRTY_INPUT_FINGERPRINT_LIMITS.max_bytes) {
        hash.update(`kind:${stat.isFile() ? "oversized" : stat.mode}`);
        continue;
      }
      hash.update(fs.readFileSync(path.join(cwd, name)));
    } catch (error) {
      hash.update(error?.code === "ENOENT" ? "missing" : "unreadable");
    }
  }
  return hash.digest("hex");
}

export async function isAncestorCommit(cwd, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function porcelain(cwd) {
  return String(await gitExecAsync(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    { trim: false },
  ) || "");
}

// Paths named by `git status --porcelain=v1 -z` output (rename/copy sources
// are reported too, since they changed as well).
export function porcelainChangedPaths(output) {
  const entries = String(output || "").split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/u.test(status) && entries[index + 1]) {
      paths.push(entries[index + 1]);
      index += 1;
    }
  }
  return [...new Set(paths)];
}
