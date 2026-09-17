import { adminGitExec } from "../../git/functions/admin-git.js";
import { TEAM_SCOPE_GLOB_PATTERN, TEAM_SCOPE_LIMITS } from "../../../catalog/team.js";

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const MAX_INCOMING_COMMITS = 256;
const MAX_CHANGED_PATHS = 4096;

function git(args, projectDir, options = {}) {
  return adminGitExec(args, projectDir, { timeoutMs: 20_000, ...options });
}

function safeOid(value) {
  return typeof value === "string" && OID_RE.test(value);
}

function changedNames(output) {
  const names = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(output))
    .split("\0").filter(Boolean);
  if (names.length > MAX_CHANGED_PATHS) throw new Error("Too many changed paths to verify completely");
  return names;
}

function incomingPaths(projectDir, baseOid, headOid) {
  if (!safeOid(baseOid) || !safeOid(headOid)) throw new Error("Invalid Git object identity");
  const commits = git(["rev-list", "--reverse", `${baseOid}..${headOid}`], projectDir)
    .split("\n").filter(Boolean);
  if (commits.length > MAX_INCOMING_COMMITS) throw new Error("Too many incoming commits to verify completely");
  const paths = [];
  for (const commit of commits) {
    paths.push(...changedNames(git([
      "diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-z",
      "-r", "--root", "-m", "--first-parent", commit,
    ], projectDir, { encoding: "buffer" })));
    if (paths.length > MAX_CHANGED_PATHS) throw new Error("Too many changed paths to verify completely");
  }
  return paths;
}

/** The single canonical scope-path rule for both sides of the boundary.
 * Registered in the catalog because the bridge command surface, the grant
 * request/issue validator and this scope check all have to apply exactly the
 * same rule; they previously each applied a different one. */
export function cleanScopePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= TEAM_SCOPE_LIMITS.MAX_PATH_LENGTH
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !TEAM_SCOPE_GLOB_PATTERN.test(value)
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function normalizedRoot(value) {
  return typeof value === "string" ? value.replace(/\/+$/u, "") : value;
}

function writeSetPermits(write, path) {
  if (!Array.isArray(write.files) || !Array.isArray(write.roots)) return false;
  const roots = write.roots.map(normalizedRoot);
  if (write.files.some((file) => !cleanScopePath(file))
    || roots.some((root) => !cleanScopePath(root))) return false;
  return write.files.includes(path)
    || roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** A grant is the exhaustive, explicit authority for what may be written.
 * An unknown set permits nothing. */
export function permitsGrantPath(write, path) {
  if (!write || write.unknown !== false || !cleanScopePath(path)) return false;
  return writeSetPermits(write, path);
}

/** A member scope is a ceiling, not a grant. Remote records an unbounded
 * ceiling as `unknown: true` and treats it as unrestricted (the pre-Session
 * member backfill spells it exactly that way), so an unknown ceiling
 * constrains nothing here either. The signed grant still has to name every
 * path explicitly, so this can widen no actual write. */
export function permitsCeilingPath(write, path) {
  if (!write || !cleanScopePath(path)) return false;
  if (write.unknown === true) return true;
  if (write.unknown !== false) return false;
  return writeSetPermits(write, path);
}

/** The relay cannot see Git objects. Derive complete paths from both the source
 * history and the proposed result, then intersect the host grant with the
 * member's session scope. Renames expose their source and destination paths. */
export function verifyTeamGitScope({
  projectDir,
  targetOid,
  sourceOid,
  candidateOid,
  effectivePermissions,
  memberScope = null,
} = {}) {
  try {
    if (![targetOid, sourceOid, candidateOid].every(safeOid)) {
      return { ok: false, reason: "invalid_git_oid" };
    }
    const parentLine = git(["rev-list", "--parents", "-n", "1", candidateOid], projectDir);
    if (parentLine !== `${candidateOid} ${targetOid}`) {
      return { ok: false, reason: "candidate_parent_mismatch" };
    }
    const sourcePaths = incomingPaths(projectDir, targetOid, sourceOid);
    const candidatePaths = incomingPaths(projectDir, targetOid, candidateOid);
    const paths = [...new Set([...sourcePaths, ...candidatePaths])];
    if (paths.length === 0) return { ok: false, reason: "empty_submission" };
    const grantWrite = effectivePermissions?.write;
    const memberWrite = memberScope?.write;
    const denied = paths.filter((path) => !permitsGrantPath(grantWrite, path)
      || (memberScope && !permitsCeilingPath(memberWrite, path)));
    return denied.length
      ? { ok: false, reason: "out_of_scope", paths: denied.slice(0, 20) }
      : { ok: true, paths };
  } catch (error) {
    return { ok: false, reason: "git_scope_unverifiable", message: String(error?.message || error).slice(0, 240) };
  }
}
