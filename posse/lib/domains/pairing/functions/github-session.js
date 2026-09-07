import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { canonicalRepositoryLocator } from "./git.js";

function run(command, args, { cwd, exec = execFileSync } = {}) {
  return String(exec(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }) || "").trim();
}

function safeSessionPart(value) {
  return String(value || "session").replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 48) || "session";
}

export function githubRepositoryName(remoteUrl) {
  const locator = canonicalRepositoryLocator(remoteUrl);
  const [host, ...parts] = locator.split("/");
  if (host !== "github.com" || parts.length !== 2 || parts.some((part) => !part)) return null;
  return parts.join("/");
}

export function readLocalSshCommand(projectDir, options = {}) {
  try {
    return run("git", ["config", "--local", "--get", "core.sshCommand"], {
      cwd: projectDir,
      ...options,
    }) || null;
  } catch {
    return null;
  }
}

export function prepareSessionSshIdentity(projectDir, sessionId, options = {}) {
  const directory = path.join(projectDir, ".posse", "session-credentials", safeSessionPart(sessionId));
  const privateKey = path.join(directory, "id_ed25519");
  const publicKey = `${privateKey}.pub`;
  const configFile = path.join(directory, "ssh_config");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(privateKey) || !fs.existsSync(publicKey)) {
    run("ssh-keygen", [
      "-q", "-t", "ed25519", "-N", "", "-C", `posse-session-${safeSessionPart(sessionId)}`,
      "-f", privateKey,
    ], { cwd: projectDir, ...options });
  }
  fs.chmodSync(privateKey, 0o600);
  fs.writeFileSync(configFile, [
    "Host github.com",
    "  HostName github.com",
    `  IdentityFile ${privateKey}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking yes",
    "",
  ].join("\n"), { mode: 0o600 });
  return {
    directory,
    privateKey,
    publicKey,
    publicKeyText: fs.readFileSync(publicKey, "utf8").trim(),
    sshCommand: `ssh -F ${configFile}`,
  };
}

export function configureRepositorySessionSsh(projectDir, sshCommand, options = {}) {
  run("git", ["config", "--local", "core.sshCommand", String(sshCommand)], {
    cwd: projectDir,
    ...options,
  });
}

export function restoreRepositorySsh(projectDir, originalCommand, options = {}) {
  const args = originalCommand
    ? ["config", "--local", "core.sshCommand", String(originalCommand)]
    : ["config", "--local", "--unset-all", "core.sshCommand"];
  try {
    run("git", args, { cwd: projectDir, ...options });
  } catch (error) {
    // Exit 5 means the key was already absent. Permission and lock failures
    // must propagate so callers retain credentials still referenced by Git.
    if (originalCommand || Number(error?.status) !== 5) throw error;
  }
}

export function provisionGitHubSessionRepository({
  projectDir,
  sessionId,
  originRemoteUrl,
  defaultBranch,
}, options = {}) {
  if (!githubRepositoryName(originRemoteUrl)) {
    throw Object.assign(new Error("Automatic session provisioning currently supports GitHub remotes only"), {
      code: "pairing_provisioning_provider_unsupported",
    });
  }
  const owner = run("gh", ["api", "user", "--jq", ".login"], { cwd: projectDir, ...options });
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
    throw Object.assign(new Error("GitHub CLI did not return a valid authenticated owner"), {
      code: "pairing_github_identity_unavailable",
    });
  }
  const repository = `${owner}/posse-session-${safeSessionPart(sessionId).toLowerCase()}`;
  run("gh", [
    "repo", "create", repository, "--private", "--disable-issues", "--disable-wiki",
    "--description", "Temporary private Posse collaboration trunk",
  ], { cwd: projectDir, ...options });
  try {
    const identity = prepareSessionSshIdentity(projectDir, sessionId, options);
    run("gh", [
      "repo", "deploy-key", "add", identity.publicKey, "--allow-write",
      "--title", `Posse session host ${safeSessionPart(sessionId)}`, "--repo", repository,
    ], { cwd: projectDir, ...options });
    return {
      provider: "github",
      repository,
      remoteUrl: `git@github.com:${repository}.git`,
      defaultBranch,
      identity,
    };
  } catch (error) {
    try {
      run("gh", ["repo", "delete", repository, "--yes"], { cwd: projectDir, ...options });
    } catch { /* report the original provisioning failure */ }
    throw error;
  }
}

export function setGitHubDefaultBranch(repository, branch, options = {}) {
  run("gh", [
    "api", "--method", "PATCH", `repos/${repository}`,
    "-f", `default_branch=${branch}`,
  ], options);
}

export function addGitHubMemberDeployKey(repository, member, options = {}) {
  const key = String(member?.ssh_public_key || "").trim();
  if (!key) {
    throw Object.assign(new Error("Pending member did not provide an SSH public key"), {
      code: "pairing_member_ssh_key_required",
    });
  }
  const title = `Posse member ${safeSessionPart(member.id)} ${safeSessionPart(member.instance_id)}`;
  const output = run("gh", [
    "api", "--method", "POST", `repos/${repository}/keys`,
    "-f", `title=${title}`, "-f", `key=${key}`, "-F", "read_only=false",
  ], options);
  let id = null;
  try { id = JSON.parse(output)?.id ?? null; } catch { id = null; }
  return { id, title };
}

export function removeGitHubMemberDeployKeys(repository, memberId, options = {}) {
  const prefix = `Posse member ${safeSessionPart(memberId)} `;
  const output = run("gh", ["api", `repos/${repository}/keys`, "--paginate"], options);
  const keys = JSON.parse(output || "[]");
  const matches = Array.isArray(keys) ? keys.filter((key) => String(key?.title || "").startsWith(prefix)) : [];
  for (const key of matches) {
    if (!Number.isSafeInteger(key?.id) || key.id <= 0) continue;
    run("gh", ["api", "--method", "DELETE", `repos/${repository}/keys/${key.id}`], options);
  }
  return matches.length;
}

export function cleanupGitHubSessionRepository(repository, options = {}) {
  try {
    run("gh", ["repo", "delete", repository, "--yes"], options);
    return { ok: true, deleted: true, repository };
  } catch (error) {
    return {
      ok: false,
      deleted: false,
      repository,
      message: error?.message || String(error),
      remediation: `Delete the temporary repository manually: gh repo delete ${repository} --yes`,
    };
  }
}

export function removeSessionCredentialDirectory(directory) {
  const value = String(directory || "").trim();
  if (!value || !path.isAbsolute(value) || path.basename(path.dirname(value)) !== "session-credentials") return false;
  fs.rmSync(value, { recursive: true, force: true });
  return true;
}
