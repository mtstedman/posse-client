import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { adminGitExec } from "../../git/functions/admin-git.js";
import { gitPushWithGitHubCliFallback } from "../../git/functions/git-push-auth.js";

const NETWORK_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
const NONINTERACTIVE_GIT_ENV = Object.freeze({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
});

function git(args, projectDir, options = {}) {
  return adminGitExec(args, projectDir, {
    timeoutMs: 60_000,
    env: NONINTERACTIVE_GIT_ENV,
    ...options,
  });
}

function push(args, projectDir, remote, options = {}) {
  return gitPushWithGitHubCliFallback(args, projectDir, {
    remote,
    gitExecFn: git,
    fallbackGitExecFn: git,
    gitOptions: options,
  });
}

export function repositoryRoot(projectDir) {
  return path.resolve(git(["rev-parse", "--show-toplevel"], projectDir, { timeoutMs: 5_000 }));
}

// Posse's own runtime folders never count as changes. Pairing commands do not
// run the artifact boot that normally excludes them, so a first pairing in a
// fresh repo would refuse its own state. Only these are excluded (locally, in
// .git/info/exclude): the clean check must not hide a project's own db/ or
// logs/ folders, which the broader runtime ignore list also covers.
const PAIRING_RUNTIME_EXCLUDES = Object.freeze([".posse/", ".posse-worktrees/", ".posse-test-suites/"]);

export function excludePosseRuntimeFolders(projectDir) {
  try {
    const root = repositoryRoot(projectDir);
    const commonDir = path.resolve(root, git(["rev-parse", "--git-common-dir"], root, { timeoutMs: 5_000 }).trim());
    const file = path.join(commonDir, "info", "exclude");
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/u) : [];
    const present = new Set(lines.map((line) => line.trim()));
    const missing = PAIRING_RUNTIME_EXCLUDES.filter((entry) => !present.has(entry) && !present.has(`/${entry}`));
    if (missing.length === 0) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const separator = lines.length > 0 && lines[lines.length - 1] !== "" ? "\n" : "";
    fs.appendFileSync(file, `${separator}${missing.join("\n")}\n`, "utf8");
    return true;
  } catch {
    return false; // the status check still decides
  }
}

export function assertCleanPairingCheckout(projectDir) {
  excludePosseRuntimeFolders(projectDir);
  // Porcelain v2 lines never start with whitespace, so the trimmed output
  // still parses: "1"/"2"/"u" changed entries end with the path, "?" is
  // untracked (renames carry "path\toriginal").
  const status = git(["status", "--porcelain=v2", "--untracked-files=normal"], projectDir, {
    timeoutMs: 10_000,
  });
  const pathFields = { 1: 8, 2: 9, u: 10 };
  const dirty = status.split("\n").map((line) => {
    if (line.startsWith("? ")) return line.slice(2);
    const fields = pathFields[line[0]];
    return fields ? line.split(" ").slice(fields).join(" ").split("\t")[0] : "";
  }).filter(Boolean);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? `, and ${dirty.length - 5} more` : "");
    const gitignoreHint = dirty.includes(".gitignore")
      ? " (.gitignore may hold the ignore block Posse adds; commit it)"
      : "";
    const error = new Error(`Pairing requires a clean checkout. Commit or stash these first: ${shown}${gitignoreHint}.`);
    error.code = "pairing_checkout_dirty";
    throw error;
  }
}

// original_head of a checkout created empty for a session join: there is no
// commit to return to, so leaving keeps the last shared state instead.
export const FRESH_CHECKOUT_HEAD = "0".repeat(40);
// Entries an otherwise empty folder may hold: Posse creates its own state
// directory before the join command runs.
const FRESH_CHECKOUT_ALLOWED_ENTRIES = new Set([".posse", ".DS_Store"]);

function headIsUnborn(projectDir) {
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD"], projectDir, { timeoutMs: 5_000 });
    return false;
  } catch {
    return true;
  }
}

export function currentCheckout(projectDir, { allowUnborn = false } = {}) {
  let branch;
  try {
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], projectDir, { timeoutMs: 5_000 });
  } catch {
    const error = new Error("Pairing requires a named branch; detached HEAD is not supported.");
    error.code = "pairing_detached_head";
    throw error;
  }
  if (allowUnborn && headIsUnborn(projectDir)) return { branch: branch.trim(), head: FRESH_CHECKOUT_HEAD };
  return {
    branch: branch.trim(),
    head: git(["rev-parse", "HEAD"], projectDir, { timeoutMs: 5_000 }).trim(),
  };
}

// A member may join from an empty folder: the session repository holds the
// full history and admission grants the member's session key access to it, so
// no clone of the host's own repository is needed. Returns the new root.
export function initializeFreshPairingCheckout(projectDir) {
  const root = path.resolve(projectDir);
  const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const unexpected = entries.filter((entry) => !FRESH_CHECKOUT_ALLOWED_ENTRIES.has(entry));
  if (unexpected.length > 0) {
    throw Object.assign(new Error(
      "Join a session from an empty folder, or from a clean clone of the session's repository",
    ), { code: "pairing_folder_not_empty" });
  }
  fs.mkdirSync(root, { recursive: true });
  git(["init", "--quiet"], root, { timeoutMs: 10_000 });
  excludePosseRuntimeFolders(root);
  return root;
}

// Undo initializeFreshPairingCheckout after a join that never checked anything
// out, so the folder is empty again for the next attempt.
export function discardFreshPairingCheckout(root) {
  if (!headIsUnborn(root)) return false;
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  return true;
}

function trimRepoPath(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .replace(/^\/+|\/+$/gu, "");
}

function requireRepositoryPath(value) {
  const repoPath = trimRepoPath(value);
  if (!repoPath) {
    throw Object.assign(new Error("Pairing remote URL does not identify a repository path"), {
      code: "pairing_repository_invalid",
    });
  }
  return repoPath;
}

export function canonicalRepositoryLocator(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value || value.length > 2048) {
    throw Object.assign(new Error("Pairing remote URL is missing or too long"), {
      code: "pairing_repository_invalid",
    });
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("Pairing remote URL contains control characters"), {
      code: "pairing_repository_invalid",
    });
  }
  // SCP-style remotes are parsed before URL remotes, so Windows drive syntax
  // would otherwise turn `C:\\repo` into the network locator `c/\\repo`.
  // Pairing is network-only: reject absolute/drive-relative and UNC forms at
  // the ambiguity boundary instead of letting them acquire a shared identity.
  if (/^[A-Za-z]:/u.test(value) || /^(?:\\\\|\/\/)/u.test(value) || /^file:/iu.test(value)) {
    throw Object.assign(new Error("Pairing requires a network Git remote (HTTPS, SSH, or git protocol)"), {
      code: "pairing_repository_not_networked",
    });
  }

  const scp = value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/u);
  if (!value.includes("://") && scp) {
    return `${scp[1].toLowerCase()}/${requireRepositoryPath(scp[2])}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error("Pairing requires a network Git remote (HTTPS, SSH, or git protocol)"), {
      code: "pairing_repository_not_networked",
    });
  }
  if (!NETWORK_SCHEMES.has(parsed.protocol)) {
    throw Object.assign(new Error("Pairing requires a network Git remote (HTTPS, SSH, or git protocol)"), {
      code: "pairing_repository_not_networked",
    });
  }
  if (parsed.password
    || ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username)
    || parsed.search
    || parsed.hash) {
    throw Object.assign(new Error("Pairing refuses remote URLs with embedded credentials, query parameters, or fragments"), {
      code: "pairing_repository_credentials_forbidden",
    });
  }
  // Preserve non-default ports: two repositories with the same host/path but
  // different SSH or HTTPS endpoints are not interchangeable access targets.
  return `${parsed.host.toLowerCase()}/${requireRepositoryPath(parsed.pathname)}`;
}

export function repositoryFingerprint(remoteUrl) {
  return createHash("sha256").update(canonicalRepositoryLocator(remoteUrl)).digest("hex");
}

export function validateRemoteName(remoteName) {
  const value = String(remoteName || "").trim();
  if (value.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw Object.assign(new Error(`Invalid Git remote name: ${value || "(empty)"}`), {
      code: "pairing_remote_invalid",
    });
  }
  return value;
}

export function remoteUrl(projectDir, remoteName) {
  return git(["remote", "get-url", validateRemoteName(remoteName)], projectDir, { timeoutMs: 5_000 }).trim();
}

export function remoteDefaultBranch(projectDir, remoteName) {
  const normalizedRemote = validateRemoteName(remoteName);
  const advertised = git(["ls-remote", "--symref", normalizedRemote, "HEAD"], projectDir);
  const match = advertised.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/mu);
  if (!match) {
    throw Object.assign(new Error(`Could not determine the default branch of Git remote ${normalizedRemote}`), {
      code: "pairing_remote_default_unresolved",
    });
  }
  return validateBranchName(projectDir, match[1]);
}

function remoteAccessUrls(projectDir, remoteName, { push = false } = {}) {
  const normalizedRemote = validateRemoteName(remoteName);
  const args = ["remote", "get-url", "--all"];
  if (push) args.push("--push");
  args.push(normalizedRemote);
  return git(args, projectDir, { timeoutMs: 5_000 })
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuredRemoteUrls(projectDir, remoteName, { push = false } = {}) {
  const normalizedRemote = validateRemoteName(remoteName);
  const key = `remote.${normalizedRemote}.${push ? "pushurl" : "url"}`;
  try {
    return git(["config", "--local", "--get-all", key], projectDir, { timeoutMs: 5_000 })
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function assertPairingRemoteTargets(projectDir, remoteName, expectedUrl = null) {
  const normalizedRemote = validateRemoteName(remoteName);
  const fetchUrls = remoteAccessUrls(projectDir, normalizedRemote);
  const pushUrls = remoteAccessUrls(projectDir, normalizedRemote, { push: true });
  const advertisedUrl = expectedUrl == null ? fetchUrls[0] : String(expectedUrl).trim();
  const expectedLocator = canonicalRepositoryLocator(advertisedUrl);
  if (fetchUrls.length === 0 || pushUrls.length === 0) {
    throw Object.assign(new Error(`Git remote ${normalizedRemote} has no usable fetch/push URL`), {
      code: "pairing_remote_target_mismatch",
    });
  }
  for (const candidate of [...fetchUrls, ...pushUrls]) {
    let candidateLocator;
    try {
      candidateLocator = canonicalRepositoryLocator(candidate);
    } catch {
      candidateLocator = null;
    }
    if (candidateLocator !== expectedLocator) {
      throw Object.assign(new Error(
        `Git remote ${normalizedRemote} does not use one repository for every fetch and push URL`,
      ), {
        code: "pairing_remote_target_mismatch",
      });
    }
  }
  return {
    remote: normalizedRemote,
    url: fetchUrls[0],
    fetchUrls,
    pushUrls,
  };
}

export function validateBranchName(projectDir, branch) {
  const normalized = String(branch || "").trim();
  try {
    git(["check-ref-format", "--branch", normalized], projectDir, { timeoutMs: 5_000 });
  } catch {
    throw Object.assign(new Error(`Invalid pairing branch: ${normalized || "(empty)"}`), {
      code: "pairing_branch_invalid",
    });
  }
  return normalized;
}

// `baseBranch` publishes the same starting commit under the repository's
// trunk name before the pairing branch. A provisioned session repository is
// empty, and its default branch must be that trunk, never the shared side
// branch: shared-trunk preflight refuses a side trunk that is the remote's
// default branch.
export function createAndPublishPairingBranch(projectDir, { remote, branch, expectedUrl = null, baseBranch = null }) {
  const normalizedRemote = validateRemoteName(remote);
  if (expectedUrl != null) assertPairingRemoteTargets(projectDir, normalizedRemote, expectedUrl);
  validateBranchName(projectDir, branch);
  if (baseBranch != null) validateBranchName(projectDir, baseBranch);
  if (baseBranch === branch) {
    throw Object.assign(new Error(`Pairing branch ${branch} cannot also be the session trunk`), {
      code: "pairing_branch_is_trunk",
    });
  }
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/heads/${branch}`;
  try {
    git(["show-ref", "--verify", "--quiet", localRef], projectDir, { timeoutMs: 5_000 });
    throw Object.assign(new Error(`Local branch ${branch} already exists`), {
      code: "pairing_branch_exists",
    });
  } catch (error) {
    if (error?.code === "pairing_branch_exists") throw error;
  }
  const remoteExisting = git(["ls-remote", "--heads", normalizedRemote, remoteRef], projectDir).trim();
  if (remoteExisting) {
    throw Object.assign(new Error(`Remote branch ${branch} already exists`), {
      code: "pairing_branch_exists",
    });
  }
  git(["switch", "--create", branch], projectDir);
  const oid = git(["rev-parse", "HEAD"], projectDir, { timeoutMs: 5_000 }).trim();
  if (baseBranch != null) {
    const baseRef = `refs/heads/${baseBranch}`;
    const baseExisting = git(["ls-remote", "--heads", normalizedRemote, baseRef], projectDir).trim();
    if (!baseExisting) push(["push", normalizedRemote, `${oid}:${baseRef}`], projectDir, normalizedRemote);
  }
  push(["push", "--set-upstream", normalizedRemote, `${oid}:${remoteRef}`], projectDir, normalizedRemote);
  // Pushing an object id sets no upstream. The shared branch must track the
  // session remote (as a member's does): session-scoped commits on it are
  // matched to the session repository through that remote.
  git(["config", `branch.${branch}.remote`, normalizedRemote], projectDir, { timeoutMs: 5_000 });
  git(["config", `branch.${branch}.merge`, remoteRef], projectDir, { timeoutMs: 5_000 });
  return oid;
}

// True when the local pairing branch holds commits beyond `baseOid`. A missing
// branch or base holds nothing to lose.
export function pairingBranchHasOwnCommits(projectDir, branch, baseOid) {
  if (!branch || !baseOid) return false;
  try {
    git(["rev-parse", "--verify", `refs/heads/${branch}`], projectDir, { timeoutMs: 5_000 });
  } catch {
    return false;
  }
  const count = git(["rev-list", "--count", `${baseOid}..refs/heads/${branch}`], projectDir, { timeoutMs: 5_000 });
  return Number(String(count).trim()) > 0;
}

export function deletePublishedPairingBranch(projectDir, { remote, branch, expectedOid }) {
  const normalizedRemote = validateRemoteName(remote);
  push([
    "push",
    `--force-with-lease=refs/heads/${branch}:${expectedOid}`,
    normalizedRemote,
    `:refs/heads/${branch}`,
  ], projectDir, normalizedRemote);
}

export function findPairingRemote(projectDir, expectedUrl) {
  const expectedLocator = canonicalRepositoryLocator(expectedUrl);
  const remotes = git(["remote"], projectDir, { timeoutMs: 5_000 })
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const remote of remotes) {
    let candidate;
    try {
      candidate = remoteUrl(projectDir, remote);
    } catch {
      continue;
    }
    try {
      if (canonicalRepositoryLocator(candidate) === expectedLocator) {
        const access = assertPairingRemoteTargets(projectDir, remote, expectedUrl);
        return { remote, added: false, url: candidate, ...access };
      }
    } catch {
      // Ignore malformed or split-target remotes. A temporary remote with one
      // fetch/push target is safer than silently publishing somewhere else.
    }
  }

  return null;
}

export function pairingTemporaryRemoteName(projectDir, sessionId) {
  const remotes = git(["remote"], projectDir, { timeoutMs: 5_000 })
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const stem = `posse-pair-${String(sessionId || "session").replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8) || "session"}`;
  let remote = stem;
  let suffix = 2;
  while (remotes.includes(remote)) remote = `${stem}-${suffix++}`;
  return remote;
}

export function addPairingRemote(projectDir, remote, expectedUrl) {
  const normalizedRemote = validateRemoteName(remote);
  canonicalRepositoryLocator(expectedUrl);
  git(["remote", "add", normalizedRemote, expectedUrl], projectDir, { timeoutMs: 5_000 });
  return { remote: normalizedRemote, added: true, url: expectedUrl };
}

export function findOrAddPairingRemote(projectDir, { remoteUrl: expectedUrl, sessionId }) {
  const existing = findPairingRemote(projectDir, expectedUrl);
  if (existing) return existing;
  const remote = pairingTemporaryRemoteName(projectDir, sessionId);
  return addPairingRemote(projectDir, remote, expectedUrl);
}

export function preflightAndCheckoutPairingBranch(projectDir, { remote, branch, expectedUrl = null }) {
  const normalizedRemote = validateRemoteName(remote);
  if (expectedUrl != null) assertPairingRemoteTargets(projectDir, normalizedRemote, expectedUrl);
  validateBranchName(projectDir, branch);
  const checkedOutBranch = git(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    projectDir,
    { timeoutMs: 5_000 },
  ).trim();
  if (checkedOutBranch === branch) {
    throw Object.assign(new Error(`Local branch ${branch} is already checked out and cannot be used as a restorable pairing branch`), {
      code: "pairing_local_branch_checked_out",
    });
  }
  const remoteRef = `refs/remotes/${normalizedRemote}/${branch}`;
  git([
    "fetch",
    "--no-tags",
    normalizedRemote,
    `+refs/heads/${branch}:${remoteRef}`,
  ], projectDir);
  const remoteOid = git(["rev-parse", "--verify", remoteRef], projectDir, { timeoutMs: 5_000 }).trim();
  push([
    "push",
    "--dry-run",
    `--force-with-lease=refs/heads/${branch}:${remoteOid}`,
    normalizedRemote,
    `${remoteOid}:refs/heads/${branch}`,
  ], projectDir, normalizedRemote);
  // A checkout created empty for this join has no history yet; it takes the
  // session's history as its own.
  if (!headIsUnborn(projectDir)) {
    try {
      git(["merge-base", "HEAD", remoteOid], projectDir, { timeoutMs: 5_000 });
    } catch {
      throw Object.assign(new Error("This checkout does not share Git history with the paired repository"), {
        code: "pairing_repository_history_mismatch",
      });
    }
  }

  let localOid = null;
  try {
    localOid = git(["rev-parse", "--verify", `refs/heads/${branch}`], projectDir, { timeoutMs: 5_000 }).trim();
  } catch {
    localOid = null;
  }
  if (localOid && localOid !== remoteOid) {
    try {
      git(["merge-base", "--is-ancestor", localOid, remoteOid], projectDir, { timeoutMs: 5_000 });
    } catch {
      throw Object.assign(new Error(`Local branch ${branch} has diverged from the paired branch`), {
        code: "pairing_local_branch_diverged",
      });
    }
    // Unpairing deliberately retains the local side branch. Move that retained
    // ref only when the fetched remote proves a strict fast-forward, preserving
    // the shared-trunk FF-mirror invariant without blocking a later rejoin.
    git(["branch", "--force", branch, remoteOid], projectDir, { timeoutMs: 5_000 });
  }
  if (localOid) {
    git(["switch", branch], projectDir);
    git(["branch", "--set-upstream-to", `${normalizedRemote}/${branch}`, branch], projectDir, { timeoutMs: 5_000 });
  } else {
    git(["switch", "--create", branch, "--track", `${normalizedRemote}/${branch}`], projectDir);
  }
  return remoteOid;
}

// The close-time final sync fast-forwards the checked-out shared branch. After
// a crash the user may have switched away (for example back to main); a clean
// checkout is switched back first so the close can finish. Returns whether a
// switch happened; a dirty checkout is left for the sync to report.
/** The local commit of `branch`, or null when it does not exist. */
export function localBranchHead(projectDir, branch) {
  try {
    return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir, { timeoutMs: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

export function checkoutSharedBranchForClose(projectDir, branch) {
  let current = "";
  try {
    current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], projectDir, { timeoutMs: 5_000 }).trim();
  } catch { /* detached: let the sync report it */ }
  if (!branch || current === branch) return false;
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir, { timeoutMs: 5_000 });
    assertCleanPairingCheckout(projectDir);
  } catch {
    return false;
  }
  git(["switch", String(branch)], projectDir);
  return true;
}

export function restoreOriginalBranch(projectDir, branch, { originalHead = null } = {}) {
  assertCleanPairingCheckout(projectDir);
  if (originalHead === FRESH_CHECKOUT_HEAD) {
    // A checkout created empty for the join never had this branch: keep the
    // last shared state under it, or leave an unborn checkout as it is.
    if (headIsUnborn(projectDir)) return;
    try {
      git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir, { timeoutMs: 5_000 });
    } catch {
      git(["switch", "--create", String(branch)], projectDir);
      return;
    }
  }
  git(["switch", String(branch)], projectDir);
}

export function removeTemporaryRemote(projectDir, { remote, expectedUrl }) {
  const configuredFetchUrls = configuredRemoteUrls(projectDir, remote);
  const configuredPushUrls = configuredRemoteUrls(projectDir, remote, { push: true });
  if (configuredFetchUrls.length === 0 && configuredPushUrls.length === 0) return false;
  if (configuredFetchUrls.length !== 1
    || configuredFetchUrls[0] !== expectedUrl
    || configuredPushUrls.length !== 0) {
    throw Object.assign(new Error(`Temporary remote ${remote} changed during pairing; it was not removed`), {
      code: "pairing_remote_changed",
    });
  }
  git(["remote", "remove", remote], projectDir, { timeoutMs: 5_000 });
  return true;
}
