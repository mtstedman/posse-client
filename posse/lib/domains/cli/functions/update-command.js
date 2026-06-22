import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { C } from "../../../shared/format/functions/colors.js";
import { DEFAULT_POSSE_ROOT } from "../../runtime/functions/python-runtime.js";
import {
  doctorRepoDependencies,
  formatBootDependencySync,
} from "../../system/functions/dependency-sync.js";

const execFileAsync = promisify(execFile);

const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const GIT_TIMEOUT_MS = 120_000;
const UPDATE_CHECK_TIMEOUT_MS = 2_000;

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function firstLine(value) {
  return stripAnsi(value)
    .replace(/\r(?!\n)/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function shortSha(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 8) : "";
}

function hasArg(argv, flag) {
  return argv.includes(flag);
}

function flagValue(argv, flag) {
  const eqPrefix = `${flag}=`;
  const eq = argv.find((arg) => String(arg || "").startsWith(eqPrefix));
  if (eq) return eq.slice(eqPrefix.length);
  const index = argv.indexOf(flag);
  if (index >= 0) {
    const value = argv[index + 1];
    if (value != null && !String(value).startsWith("-")) return value;
  }
  return null;
}

function normalizeBranch(value) {
  const branch = String(value || DEFAULT_BRANCH).trim();
  if (!branch || branch.startsWith("-") || branch.includes("..") || /[\s~^:?*[\\]/u.test(branch)) {
    throw new Error(`invalid update branch: ${value}`);
  }
  return branch;
}

function normalizeGitResult(value, args = []) {
  if (value && typeof value === "object" && Object.hasOwn(value, "ok")) {
    return {
      args,
      stdout: String(value.stdout || ""),
      stderr: String(value.stderr || ""),
      status: value.status ?? (value.ok ? 0 : 1),
      ...value,
    };
  }
  return { ok: true, status: 0, stdout: String(value || ""), stderr: "", args };
}

function formatGitFailure(args, result) {
  const detail = firstLine(result.stderr || result.stdout || result.error || result.message);
  const suffix = detail ? `: ${detail}` : "";
  return `git ${args.join(" ")} failed${suffix}`;
}

export async function runGitCommand(args, {
  cwd,
  allowFailure = false,
  timeoutMs = GIT_TIMEOUT_MS,
} = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true, status: 0, stdout, stderr, args };
  } catch (err) {
    const result = {
      ok: false,
      status: err?.status ?? 1,
      stdout: String(err?.stdout || ""),
      stderr: String(err?.stderr || ""),
      error: err?.message || String(err),
      args,
    };
    if (allowFailure) return result;
    throw new Error(formatGitFailure(args, result));
  }
}

async function callGit(git, args, opts) {
  const result = normalizeGitResult(await git(args, opts), args);
  if (!result.ok && !opts?.allowFailure) {
    throw new Error(formatGitFailure(args, result));
  }
  return result;
}

async function gitOutput(git, args, opts) {
  const result = await callGit(git, args, opts);
  return String(result.stdout || "").trim();
}

function parseLsRemoteSha(output) {
  const line = String(output || "").split(/\r?\n/u).find(Boolean) || "";
  const [sha] = line.trim().split(/\s+/u);
  return /^[0-9a-f]{40}$/iu.test(sha || "") ? sha : "";
}

function blockedUpdate(message, details = {}) {
  return {
    ok: false,
    status: "blocked",
    changed: false,
    message,
    ...details,
  };
}

function unavailableUpdateCheck(reason, details = {}) {
  return {
    ok: false,
    available: false,
    status: "unavailable",
    reason,
    ...details,
  };
}

async function resolveRemoteSha({ git, repoRoot, remote, branch, dryRun }) {
  if (dryRun) {
    const output = await gitOutput(git, ["ls-remote", remote, `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return parseLsRemoteSha(output);
  }
  await callGit(git, ["fetch", remote, branch], { cwd: repoRoot });
  return await gitOutput(git, ["rev-parse", "--verify", "FETCH_HEAD"], {
    cwd: repoRoot,
  });
}

export async function checkPosseUpdateAvailability({
  posseRoot = DEFAULT_POSSE_ROOT,
  remote = DEFAULT_REMOTE,
  branch = DEFAULT_BRANCH,
  git = runGitCommand,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
} = {}) {
  const resolvedPosseRoot = path.resolve(posseRoot || DEFAULT_POSSE_ROOT);
  const targetBranch = normalizeBranch(branch);
  try {
    const repoRoot = path.resolve(await gitOutput(git, ["rev-parse", "--show-toplevel"], {
      cwd: resolvedPosseRoot,
      timeoutMs,
    }));
    const currentBranch = await gitOutput(git, ["branch", "--show-current"], {
      cwd: repoRoot,
      timeoutMs,
    });
    if (currentBranch !== targetBranch) {
      return {
        ok: true,
        available: false,
        status: "skipped",
        reason: `checkout is on ${currentBranch || "detached HEAD"}, not ${targetBranch}`,
        repo_root: repoRoot,
        branch: targetBranch,
        current_branch: currentBranch,
      };
    }
    const [localSha, remoteUrl, remoteOutput] = await Promise.all([
      gitOutput(git, ["rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs }),
      gitOutput(git, ["remote", "get-url", remote], { cwd: repoRoot, timeoutMs }),
      gitOutput(git, ["ls-remote", remote, `refs/heads/${targetBranch}`], { cwd: repoRoot, timeoutMs }),
    ]);
    const remoteSha = parseLsRemoteSha(remoteOutput);
    if (!remoteSha) {
      return unavailableUpdateCheck(`could not resolve ${remote}/${targetBranch}`, {
        repo_root: repoRoot,
        remote,
        branch: targetBranch,
        current_branch: currentBranch,
        remote_url: remoteUrl,
        local_sha: localSha,
      });
    }
    const available = localSha !== remoteSha;
    return {
      ok: true,
      available,
      status: available ? "available" : "up-to-date",
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
      local_sha: localSha,
      remote_sha: remoteSha,
    };
  } catch (err) {
    return unavailableUpdateCheck(firstLine(err?.message || err) || "update check failed", {
      posse_root: resolvedPosseRoot,
      remote,
      branch: targetBranch,
    });
  }
}

export function formatPosseUpdateAvailableWarning(check = {}) {
  const from = shortSha(check.local_sha);
  const to = shortSha(check.remote_sha);
  const range = from && to ? ` (${from} -> ${to})` : "";
  return `Posse update available${range}. Run posse update.`;
}

export async function updatePosseClient({
  posseRoot = DEFAULT_POSSE_ROOT,
  remote = DEFAULT_REMOTE,
  branch = DEFAULT_BRANCH,
  dryRun = false,
  git = runGitCommand,
  runDoctor = doctorRepoDependencies,
  onProgress = null,
} = {}) {
  const resolvedPosseRoot = path.resolve(posseRoot || DEFAULT_POSSE_ROOT);
  const targetBranch = normalizeBranch(branch);
  const progress = typeof onProgress === "function" ? onProgress : () => {};

  let repoRoot = "";
  try {
    repoRoot = path.resolve(await gitOutput(git, ["rev-parse", "--show-toplevel"], {
      cwd: resolvedPosseRoot,
    }));
  } catch (err) {
    const update = blockedUpdate("Posse is not installed from a git checkout", {
      error: err?.message || String(err),
      posse_root: resolvedPosseRoot,
    });
    return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, update, dependencies: null };
  }

  let remoteUrl = "";
  try {
    remoteUrl = await gitOutput(git, ["remote", "get-url", remote], {
      cwd: repoRoot,
    });
  } catch (err) {
    const update = blockedUpdate(`Posse checkout does not have a ${remote} remote`, {
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      error: err?.message || String(err),
    });
    return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
  }
  const currentBranch = await gitOutput(git, ["branch", "--show-current"], {
    cwd: repoRoot,
  });
  if (!currentBranch) {
    const update = blockedUpdate("Posse checkout is in detached HEAD; cannot update safely", {
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      remote_url: remoteUrl,
    });
    return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
  }
  if (currentBranch !== targetBranch) {
    const update = blockedUpdate(`Posse checkout is on ${currentBranch}, not ${targetBranch}`, {
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
    });
    return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
  }

  const dirty = await gitOutput(git, ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repoRoot,
  });
  if (dirty) {
    const update = blockedUpdate("Posse checkout has local tracked changes; commit or stash them before updating", {
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
      dirty,
    });
    return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
  }

  const before = await gitOutput(git, ["rev-parse", "HEAD"], { cwd: repoRoot });
  progress(dryRun
    ? `checking ${remote}/${targetBranch}`
    : `fetching ${remote}/${targetBranch}`);
  const remoteSha = await resolveRemoteSha({
    git,
    repoRoot,
    remote,
    branch: targetBranch,
    dryRun,
  });
  if (!remoteSha) {
    const update = blockedUpdate(`Could not resolve ${remote}/${targetBranch}`, {
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
      before,
    });
    return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
  }

  const upToDate = before === remoteSha;
  if (!upToDate && !dryRun) {
    const ancestor = await callGit(git, ["merge-base", "--is-ancestor", before, remoteSha], {
      cwd: repoRoot,
      allowFailure: true,
    });
    if (!ancestor.ok) {
      const update = blockedUpdate(`Local ${targetBranch} cannot fast-forward to ${remote}/${targetBranch}`, {
        repo_root: repoRoot,
        remote,
        branch: targetBranch,
        current_branch: currentBranch,
        remote_url: remoteUrl,
        before,
        remote_sha: remoteSha,
      });
      return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
    }
  }

  let update;
  if (upToDate) {
    update = {
      ok: true,
      status: "up-to-date",
      changed: false,
      message: `already at ${shortSha(before)}`,
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
      before,
      after: before,
      remote_sha: remoteSha,
    };
  } else if (dryRun) {
    update = {
      ok: true,
      status: "would-update",
      changed: true,
      message: `would fast-forward ${shortSha(before)} -> ${shortSha(remoteSha)}`,
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
      before,
      after: before,
      remote_sha: remoteSha,
    };
  } else {
    progress(`fast-forwarding ${targetBranch} to ${shortSha(remoteSha)}`);
    await callGit(git, ["merge", "--ff-only", "FETCH_HEAD"], {
      cwd: repoRoot,
    });
    const after = await gitOutput(git, ["rev-parse", "HEAD"], { cwd: repoRoot });
    update = {
      ok: true,
      status: "updated",
      changed: true,
      message: `fast-forwarded ${shortSha(before)} -> ${shortSha(after)}`,
      repo_root: repoRoot,
      remote,
      branch: targetBranch,
      current_branch: currentBranch,
      remote_url: remoteUrl,
      before,
      after,
      remote_sha: remoteSha,
    };
  }

  progress(dryRun ? "checking dependency plan" : "checking dependencies");
  const dependencies = await runDoctor({
    projectDir: resolvedPosseRoot,
    posseRoot: resolvedPosseRoot,
    dryRun,
    timeoutMs: null,
    onProgress: (message) => progress(`dependencies: ${message}`),
  });

  return {
    ok: update.ok !== false && dependencies?.ok !== false,
    dry_run: dryRun,
    posse_root: resolvedPosseRoot,
    repo_root: repoRoot,
    update,
    dependencies,
  };
}

function dependencyEntries(result) {
  const report = result?.doctor || {};
  return [
    ...(Array.isArray(report.repaired) ? report.repaired : []),
    ...(Array.isArray(report.pending) ? report.pending : []),
    ...(Array.isArray(report.failed) ? report.failed : []),
  ];
}

function renderDependencyEntries({ log, colors, entries }) {
  if (!entries.length) return;
  log(`\n  ${colors.bold}Dependencies${colors.reset}`);
  for (const entry of entries) {
    const label = entry.label || entry.language || "dependency";
    const status = entry.status || (entry.ok ? "ok" : "failed");
    const message = firstLine(entry.message || entry.reason || "");
    log(`    ${label}: ${status}${message ? ` - ${message}` : ""}`);
  }
}

function renderUpdateHelp({ log, colors }) {
  log(`
  ${colors.bold}posse update${colors.reset}

  Update the local Posse client checkout and refresh dependencies when manifests changed.

  Usage:
    posse update
    posse update --dry-run
    posse update --json
    posse update --branch main

  The update is fast-forward only and refuses local tracked edits.
`);
}

export async function cmdUpdate({
  argv = process.argv.slice(3),
  posseRoot = DEFAULT_POSSE_ROOT,
  colors = C,
  log = console.log,
  git = runGitCommand,
  runDoctor = doctorRepoDependencies,
} = {}) {
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    renderUpdateHelp({ log, colors });
    return null;
  }

  const json = hasArg(argv, "--json");
  const dryRun = hasArg(argv, "--dry-run");
  const branch = normalizeBranch(flagValue(argv, "--branch") || DEFAULT_BRANCH);
  const result = await updatePosseClient({
    posseRoot,
    branch,
    dryRun,
    git,
    runDoctor,
    onProgress: (message) => {
      if (!json) log(`  ${colors.dim}[update]${colors.reset} ${message}`);
    },
  });

  if (json) {
    log(JSON.stringify(result, null, 2));
  } else {
    const update = result.update || {};
    const statusColor = result.ok ? colors.green : colors.red;
    log(`\n  ${statusColor}[update]${colors.reset} ${update.status || "failed"}: ${update.message || "update failed"}`);
    log(`  ${colors.dim}install: ${result.posse_root}${colors.reset}`);
    if (update.remote_url) {
      log(`  ${colors.dim}source:  ${update.remote}/${update.branch} (${update.remote_url})${colors.reset}`);
    }
    if (result.dependencies) {
      const summary = result.dependencies?.doctor?.summary || formatBootDependencySync(result.dependencies);
      log(`  ${colors.dim}deps:    ${summary}${colors.reset}`);
      const entries = dependencyEntries(result.dependencies);
      renderDependencyEntries({ log, colors, entries });
      if (!entries.length) {
        log(`\n  ${colors.green}All Posse dependencies are ready.${colors.reset}`);
      }
    }
    log("");
  }

  if (!result.ok) process.exitCode = 1;
  return result;
}
