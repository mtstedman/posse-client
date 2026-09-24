// Git push authentication fallback for operator-initiated publication.
//
// `gh` does not implement a push transport of its own. Its supported bridge is
// `gh auth git-credential`, which speaks Git's credential-helper protocol. We
// try the repository's normal Git configuration first and only install that
// helper for one retry after a definite authentication failure. Nothing is
// written to local or global Git config.

import { execFileSync } from "node:child_process";

import { adminGitExec } from "./admin-git-exec.js";

const AUTH_FAILURE_PATTERNS = Object.freeze([
  /authentication failed/iu,
  /invalid (?:username|user name|password|credentials?|token)/iu,
  /could not read (?:username|password)/iu,
  /terminal prompts? disabled/iu,
  /permission denied \(publickey\)/iu,
  /publickey authentication failed/iu,
  /requested url returned error:\s*(?:401|403)\b/iu,
  /\bhttp (?:401|403)\b/iu,
  /\b(?:401|403)\b[^\n]*(?:unauthori[sz]ed|forbidden)/iu,
  /permission to [^\s]+ denied to/iu,
  /repository not found/iu,
  /could not read from remote repository/iu,
  /access denied/iu,
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);

function errorDetail(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
}

export function isGitPushAuthenticationFailure(error) {
  const detail = errorDetail(error);
  return detail.length > 0 && AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(detail));
}

function stripIpv6Brackets(value) {
  return String(value || "").replace(/^\[|\]$/gu, "");
}

function isGitPushArgs(args) {
  for (let index = 0; index < args.length;) {
    const arg = String(args[index] || "");
    if (!arg) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg === "push";
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if ((arg.startsWith("-c") && arg.length > 2)
      || arg.startsWith("--config-env=")
      || arg.startsWith("--exec-path=")
      || arg.startsWith("--git-dir=")
      || arg.startsWith("--namespace=")
      || arg.startsWith("--work-tree=")) {
      index += 1;
      continue;
    }
    index += 1;
  }
  return false;
}

// Return the gh hostname and, for SSH/plain-git remotes, the exact URL prefix
// Git should rewrite to HTTPS for the credential-helper retry. HTTPS remotes
// need only the helper. Local paths and file:// remotes are deliberately not
// eligible for a GitHub CLI fallback.
export function gitHubCliAuthTarget(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  if (/^[A-Za-z]:[\\/]/u.test(value) || /^(?:\\\\|\/\/)/u.test(value)) return null;

  if (!value.includes("://")) {
    const scp = value.match(/^(?:([^@/:]+)@)?(\[[^\]]+\]|[^/:]+):(.+)$/u);
    if (!scp || !scp[3]) return null;
    const host = stripIpv6Brackets(scp[2]);
    if (!host) return null;
    return {
      host,
      insteadOf: `${scp[1] ? `${scp[1]}@` : ""}${scp[2]}:`,
      httpsBase: `https://${scp[2]}/`,
    };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.password || parsed.search || parsed.hash) return null;
  const host = parsed.host;
  if (parsed.protocol === "https:") return { host, insteadOf: null, httpsBase: null };
  if (!["http:", "ssh:", "git:"].includes(parsed.protocol)) return null;

  const username = parsed.username ? `${parsed.username}@` : "";
  return {
    host,
    insteadOf: `${parsed.protocol}//${username}${parsed.host}/`,
    httpsBase: `https://${parsed.host}/`,
  };
}

export function gitHubCliAuthCommands(remoteUrl) {
  const target = gitHubCliAuthTarget(remoteUrl);
  if (!target || !/^[A-Za-z0-9._:-]+$/u.test(target.host)) return null;
  return {
    host: target.host,
    login: `gh auth login --hostname ${target.host} --git-protocol https`,
    setupGit: `gh auth setup-git --hostname ${target.host}`,
  };
}

export function gitHubCliAuthRemediation(remoteUrl = null) {
  const commands = gitHubCliAuthCommands(remoteUrl);
  const login = commands?.login || "gh auth login --git-protocol https";
  const setupGit = commands?.setupGit || "gh auth setup-git";
  return {
    reason: "shared_trunk_authentication_required",
    commands: [login, setupGit],
    message: [
      "Shared-trunk remote authentication failed.",
      "Authenticate GitHub CLI and configure Git to use it, then retry:",
      `  ${login}`,
      `  ${setupGit}`,
    ].join("\n"),
  };
}

function nonInteractiveOptions(options = {}) {
  return {
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  };
}

function ghAuthIsConfigured(host, cwd, execGh, options) {
  try {
    execGh("gh", ["auth", "status", "--hostname", host], {
      cwd,
      env: options.env,
      timeout: Math.min(Number(options.timeoutMs || options.timeout || 60_000), 60_000),
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an exact `git push` argv with the repository's normal authentication,
 * then retry through an authenticated GitHub CLI credential helper when (and
 * only when) Git reported an authentication failure.
 */
export function gitPushWithGitHubCliFallback(args, cwd, {
  remote,
  gitExecFn = adminGitExec,
  fallbackGitExecFn = adminGitExec,
  execGh = execFileSync,
  gitOptions = {},
} = {}) {
  if (!Array.isArray(args) || !isGitPushArgs(args)) {
    throw new TypeError("gitPushWithGitHubCliFallback requires git push argv");
  }
  const remoteName = String(remote || "").trim();
  if (!remoteName) throw new TypeError("gitPushWithGitHubCliFallback requires a remote name");

  try {
    return gitExecFn(args, cwd, gitOptions);
  } catch (initialError) {
    if (!isGitPushAuthenticationFailure(initialError)) throw initialError;

    const fallbackOptions = nonInteractiveOptions(gitOptions);
    let remoteUrl;
    try {
      remoteUrl = fallbackGitExecFn(
        ["remote", "get-url", "--push", remoteName],
        cwd,
        { ...fallbackOptions, timeoutMs: 5_000 },
      );
    } catch {
      throw initialError;
    }
    const target = gitHubCliAuthTarget(remoteUrl);
    if (!target || !ghAuthIsConfigured(target.host, cwd, execGh, fallbackOptions)) {
      throw initialError;
    }

    const retryArgs = [
      "-c", "credential.helper=",
      "-c", "credential.helper=!gh auth git-credential",
    ];
    if (target.insteadOf && target.httpsBase) {
      retryArgs.push("-c", `url.${target.httpsBase}.insteadOf=${target.insteadOf}`);
    }
    retryArgs.push(...args);

    try {
      return fallbackGitExecFn(retryArgs, cwd, fallbackOptions);
    } catch (fallbackError) {
      if (fallbackError && typeof fallbackError === "object") {
        if (fallbackError.cause == null) fallbackError.cause = initialError;
        fallbackError.gitAuthFallback = "gh";
      }
      throw fallbackError;
    }
  }
}
