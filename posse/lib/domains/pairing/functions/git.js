import { createHash } from "node:crypto";
import path from "node:path";

import { adminGitExec } from "../../git/functions/admin-git.js";

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

export function repositoryRoot(projectDir) {
  return path.resolve(git(["rev-parse", "--show-toplevel"], projectDir, { timeoutMs: 5_000 }));
}

export function assertCleanPairingCheckout(projectDir) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=normal"], projectDir, {
    timeoutMs: 10_000,
  });
  if (status.trim()) {
    const error = new Error("Pairing requires a clean checkout. Commit or stash local changes first.");
    error.code = "pairing_checkout_dirty";
    throw error;
  }
}

export function currentCheckout(projectDir) {
  let branch;
  try {
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], projectDir, { timeoutMs: 5_000 });
  } catch {
    const error = new Error("Pairing requires a named branch; detached HEAD is not supported.");
    error.code = "pairing_detached_head";
    throw error;
  }
  return {
    branch: branch.trim(),
    head: git(["rev-parse", "HEAD"], projectDir, { timeoutMs: 5_000 }).trim(),
  };
}

function trimRepoPath(value) {
  return String(value || "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "");
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
  if (/^[A-Za-z]:/u.test(value) || /^(?:\\\\|\/\/)/u.test(value)) {
    throw Object.assign(new Error("Pairing requires a network Git remote (HTTPS, SSH, or git protocol)"), {
      code: "pairing_repository_not_networked",
    });
  }

  const scp = value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/u);
  if (!value.includes("://") && scp) {
    return `${scp[1].toLowerCase()}/${trimRepoPath(scp[2])}`;
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
  return `${parsed.host.toLowerCase()}/${trimRepoPath(parsed.pathname)}`;
}

export function repositoryFingerprint(remoteUrl) {
  return createHash("sha256").update(canonicalRepositoryLocator(remoteUrl)).digest("hex");
}

export function validateRemoteName(remoteName) {
  const value = String(remoteName || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)
    || value.includes("..")
    || value.endsWith("/")) {
    throw Object.assign(new Error(`Invalid Git remote name: ${value || "(empty)"}`), {
      code: "pairing_remote_invalid",
    });
  }
  return value;
}

export function remoteUrl(projectDir, remoteName) {
  return git(["remote", "get-url", validateRemoteName(remoteName)], projectDir, { timeoutMs: 5_000 }).trim();
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

export function createAndPublishPairingBranch(projectDir, { remote, branch, expectedUrl = null }) {
  const normalizedRemote = validateRemoteName(remote);
  if (expectedUrl != null) assertPairingRemoteTargets(projectDir, normalizedRemote, expectedUrl);
  validateBranchName(projectDir, branch);
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
  git(["push", "--set-upstream", normalizedRemote, `${oid}:${remoteRef}`], projectDir);
  return oid;
}

export function deletePublishedPairingBranch(projectDir, { remote, branch, expectedOid }) {
  const normalizedRemote = validateRemoteName(remote);
  git([
    "push",
    `--force-with-lease=refs/heads/${branch}:${expectedOid}`,
    normalizedRemote,
    `:refs/heads/${branch}`,
  ], projectDir);
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
  git([
    "push",
    "--dry-run",
    `--force-with-lease=refs/heads/${branch}:${remoteOid}`,
    normalizedRemote,
    `${remoteOid}:refs/heads/${branch}`,
  ], projectDir);
  try {
    git(["merge-base", "HEAD", remoteOid], projectDir, { timeoutMs: 5_000 });
  } catch {
    throw Object.assign(new Error("This checkout does not share Git history with the paired repository"), {
      code: "pairing_repository_history_mismatch",
    });
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

export function restoreOriginalBranch(projectDir, branch) {
  assertCleanPairingCheckout(projectDir);
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
