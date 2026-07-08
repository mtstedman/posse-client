import fs from "fs";
import os from "os";
import path from "path";

import { C } from "../../../shared/format/functions/colors.js";
import { DEFAULT_POSSE_ROOT } from "../../runtime/functions/python-runtime.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import {
  doctorRepoDependencies,
  formatBootDependencySync,
} from "../../system/functions/dependency-sync.js";

const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const GIT_TIMEOUT_MS = 120_000;
// A fetch/ff-merge can move native binaries and rewrite the working tree, so
// they get far more room than ordinary plumbing calls.
const FETCH_TIMEOUT_MS = 600_000;
const MERGE_TIMEOUT_MS = 300_000;
const UPDATE_CHECK_TIMEOUT_MS = 2_000;
const UPDATE_CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CHANGELOG_LIMIT = 8;

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
    const stdout = await gitExecAsync(args, cwd, {
      timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, status: 0, stdout, stderr: "", args };
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
  await callGit(git, ["fetch", remote, branch], { cwd: repoRoot, timeoutMs: FETCH_TIMEOUT_MS });
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

// Test processes must never read or write the operator's real update-check
// cache (same isolation contract as the account DB): redirect to a per-process
// temp path under test context so raced-past background checks can't publish
// test-derived verdicts into ~/.posse.
export function defaultUpdateCheckCachePath() {
  if (process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN) {
    return path.join(os.tmpdir(), `posse-test-${process.pid}`, "update-check.json");
  }
  return path.join(os.homedir(), ".posse", "update-check.json");
}

function readUpdateCheckCache(cachePath) {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!data || typeof data !== "object" || !data.check || typeof data.check !== "object") return null;
    if (!Number.isFinite(Number(data.checked_at))) return null;
    return data;
  } catch {
    return null;
  }
}

function writeUpdateCheckCache(cachePath, payload) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // The cache only saves latency; never let it interfere with the check.
  }
}

// The advisory pre-command check hits the network (ls-remote) — without a
// cache every CLI invocation stalls up to the check timeout. Verdicts are
// trusted for the TTL, except "update available", which goes stale the moment
// HEAD moves (posse update ran) and is therefore re-verified locally first.
export async function checkPosseUpdateAvailabilityCached({
  cachePath = defaultUpdateCheckCachePath(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  now = Date.now,
  git = runGitCommand,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  ...checkOpts
} = {}) {
  const cached = readUpdateCheckCache(cachePath);
  if (cached && now() - Number(cached.checked_at) < ttlMs) {
    const fromCache = { ...cached.check, cached: true };
    if (!cached.check.available) return fromCache;
    try {
      const head = await gitOutput(git, ["rev-parse", "HEAD"], {
        cwd: cached.check.repo_root,
        timeoutMs,
      });
      if (head === cached.check.local_sha) return fromCache;
    } catch {
      // Can't confirm the cached verdict still applies — re-check fresh.
    }
  }
  const check = await checkPosseUpdateAvailability({ ...checkOpts, git, timeoutMs });
  writeUpdateCheckCache(cachePath, { checked_at: now(), check });
  return check;
}

export function formatPosseUpdateAvailableWarning(check = {}) {
  const from = shortSha(check.local_sha);
  const to = shortSha(check.remote_sha);
  const range = from && to ? ` (${from} -> ${to})` : "";
  return `Posse update available${range}. Run posse update.`;
}

// Step keys emitted to the ui: checkout → fetch → apply → deps.
function safeUi(ui) {
  const call = (fn, ...args) => {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch {
      // Presentation must never break the update itself.
    }
  };
  return {
    start: (key, text) => call(ui?.start, key, text),
    note: (key, text) => call(ui?.note, key, text),
    done: (key, status, text) => call(ui?.done, key, status, text),
  };
}

export async function updatePosseClient({
  posseRoot = DEFAULT_POSSE_ROOT,
  projectDir = process.cwd(),
  remote = DEFAULT_REMOTE,
  branch = DEFAULT_BRANCH,
  dryRun = false,
  git = runGitCommand,
  runDoctor = doctorRepoDependencies,
  ui = null,
} = {}) {
  const resolvedPosseRoot = path.resolve(posseRoot || DEFAULT_POSSE_ROOT);
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());
  const targetBranch = normalizeBranch(branch);
  const u = safeUi(ui);

  let repoRoot = "";
  let phase = "checkout";
  try {
    u.start("checkout", "inspecting the Posse checkout");
    try {
      repoRoot = path.resolve(await gitOutput(git, ["rev-parse", "--show-toplevel"], {
        cwd: resolvedPosseRoot,
      }));
    } catch (err) {
      const update = blockedUpdate("Posse is not installed from a git checkout", {
        error: err?.message || String(err),
        posse_root: resolvedPosseRoot,
      });
      u.done("checkout", "fail", update.message);
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
      u.done("checkout", "fail", update.message);
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
      u.done("checkout", "fail", update.message);
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
      u.done("checkout", "fail", update.message);
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
      u.done("checkout", "fail", update.message);
      return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
    }

    const before = await gitOutput(git, ["rev-parse", "HEAD"], { cwd: repoRoot });
    u.done("checkout", "ok", `${targetBranch} @ ${shortSha(before)} · clean`);

    phase = "fetch";
    u.start("fetch", dryRun
      ? `checking ${remote}/${targetBranch} (ls-remote)`
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
      u.done("fetch", "fail", update.message);
      return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
    }
    u.done("fetch", "ok", `${remote}/${targetBranch} @ ${shortSha(remoteSha)}`);

    phase = "apply";
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
        u.done("apply", "fail", update.message);
        return { ok: false, dry_run: dryRun, posse_root: resolvedPosseRoot, repo_root: repoRoot, update, dependencies: null };
      }
    }

    let update;
    if (upToDate) {
      u.done("apply", "ok", `already at ${shortSha(before)}`);
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
      u.done("apply", "info", `would fast-forward ${shortSha(before)} → ${shortSha(remoteSha)}`);
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
      // The changelog is cosmetic — never let it block the update.
      let commitCount = null;
      let commits = [];
      try {
        const countText = await gitOutput(git, ["rev-list", "--count", `${before}..${remoteSha}`], {
          cwd: repoRoot,
        });
        const parsed = Number.parseInt(countText, 10);
        if (Number.isFinite(parsed)) commitCount = parsed;
        const logText = await gitOutput(git, [
          "log", "--no-decorate", "--pretty=format:%h%x09%s", "-n", String(CHANGELOG_LIMIT),
          `${before}..${remoteSha}`,
        ], { cwd: repoRoot });
        commits = logText.split(/\r?\n/u).filter(Boolean).map((line) => {
          const [sha, ...rest] = line.split("\t");
          return { sha, subject: rest.join("\t") };
        });
      } catch {
        commitCount = null;
        commits = [];
      }

      u.start("apply", `fast-forwarding to ${shortSha(remoteSha)}`);
      // Merge the resolved sha, not FETCH_HEAD — a concurrent fetch in the
      // same checkout (live posse runs do this) can repoint FETCH_HEAD
      // between our fetch and the merge.
      await callGit(git, ["merge", "--ff-only", remoteSha], {
        cwd: repoRoot,
        timeoutMs: MERGE_TIMEOUT_MS,
      });
      const after = await gitOutput(git, ["rev-parse", "HEAD"], { cwd: repoRoot });
      const countText = commitCount != null ? ` · ${commitCount} commit${commitCount === 1 ? "" : "s"}` : "";
      u.done("apply", "ok", `${shortSha(before)} → ${shortSha(after)}${countText}`);
      for (const commit of commits) {
        u.note("apply", `${commit.sha} ${firstLine(commit.subject)}`);
      }
      if (commitCount != null && commitCount > commits.length) {
        u.note("apply", `… +${commitCount - commits.length} more`);
      }
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
        ...(commitCount != null ? { commit_count: commitCount } : {}),
        ...(commits.length ? { commits } : {}),
      };
    }

    phase = "deps";
    u.start("deps", dryRun
      ? "checking the dependency plan (posse doctor --dry-run)"
      : "refreshing dependencies (posse doctor)");
    const dependencies = await runDoctor({
      projectDir: resolvedProjectDir,
      posseRoot: resolvedPosseRoot,
      dryRun,
      timeoutMs: null,
      onProgress: (message) => u.note("deps", firstLine(message)),
    });
    const depsOk = dependencies?.ok !== false;
    const depsSummary = firstLine(dependencies?.doctor?.summary || (dependencies ? formatBootDependencySync(dependencies) : ""))
      || (depsOk ? "ready" : "needs attention");
    u.done("deps", depsOk ? "ok" : "warn", depsSummary);

    return {
      ok: update.ok !== false && depsOk,
      dry_run: dryRun,
      posse_root: resolvedPosseRoot,
      project_dir: resolvedProjectDir,
      repo_root: repoRoot,
      update,
      dependencies,
    };
  } catch (err) {
    const message = firstLine(err?.message || err) || "update failed";
    u.done(phase, "fail", message);
    return {
      ok: false,
      dry_run: dryRun,
      posse_root: resolvedPosseRoot,
      project_dir: resolvedProjectDir,
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      update: { ok: false, status: "failed", changed: false, message },
      dependencies: null,
    };
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

const STEP_LABELS = {
  checkout: "checkout",
  fetch: "fetch",
  apply: "fast-forward",
  deps: "dependencies",
};
const STEP_LABEL_W = 12;
// Same pulse as the boot panel: a dot that blooms open and contracts back.
const SPINNER_FRAMES = ["·", "✢", "✺", "✢"];
const SPINNER_FRAME_MS = 130;

function formatElapsed(ms) {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function createUpdateRenderer({ colors, log, stream = process.stdout }) {
  const live = Boolean(stream?.isTTY && colors?.reset);
  const glyphs = {
    ok: `${colors.green}✓${colors.reset}`,
    warn: `${colors.yellow}!${colors.reset}`,
    fail: `${colors.red}✗${colors.reset}`,
    info: `${colors.dim}·${colors.reset}`,
  };
  const labelFor = (key) => (STEP_LABELS[key] || key).padEnd(STEP_LABEL_W);
  const startedAt = new Map();
  let spin = null;

  const clearSpinLine = () => {
    if (live) stream.write("\r\x1b[2K");
  };
  const stopSpin = () => {
    if (spin?.timer) clearInterval(spin.timer);
    if (spin) clearSpinLine();
    spin = null;
  };
  const renderSpin = () => {
    if (!spin) return;
    const frame = SPINNER_FRAMES[Math.floor((Date.now() - spin.since) / SPINNER_FRAME_MS) % SPINNER_FRAMES.length];
    const elapsed = formatElapsed(Date.now() - spin.since);
    const cols = Number(stream.columns) || 100;
    const budget = Math.max(8, cols - (STEP_LABEL_W + elapsed.length + 12));
    const text = spin.text.length > budget ? `${spin.text.slice(0, budget - 1)}…` : spin.text;
    stream.write(`\r\x1b[2K  ${colors.cyan}${frame}${colors.reset} ${labelFor(spin.key)} ${text} ${colors.dim}(${elapsed})${colors.reset}`);
  };

  return {
    start(key, text) {
      startedAt.set(key, Date.now());
      if (!live) {
        log(`  ${glyphs.info} ${labelFor(key)} ${colors.dim}${text}${colors.reset}`);
        return;
      }
      stopSpin();
      spin = { key, text: String(text || ""), since: Date.now() };
      spin.timer = setInterval(renderSpin, SPINNER_FRAME_MS);
      spin.timer.unref?.();
      renderSpin();
    },
    note(key, text) {
      const line = firstLine(text);
      if (!line) return;
      if (live && spin?.key === key) {
        spin.text = line;
        renderSpin();
        return;
      }
      log(`      ${colors.dim}${line}${colors.reset}`);
    },
    done(key, status, text) {
      stopSpin();
      const since = startedAt.get(key);
      const elapsed = Number.isFinite(since) && Date.now() - since >= 1_000
        ? ` ${colors.dim}(${formatElapsed(Date.now() - since)})${colors.reset}`
        : "";
      log(`  ${glyphs[status] || glyphs.info} ${labelFor(key)} ${text}${elapsed}`);
    },
    stop: stopSpin,
  };
}

function renderDependencySections({ log, colors, dependencies }) {
  const report = dependencies?.doctor || {};
  const sections = [
    ["Repaired", report.repaired, colors.green, `${colors.green}✓${colors.reset}`],
    ["Pending", report.pending, colors.yellow, `${colors.yellow}!${colors.reset}`],
    ["Failed", report.failed, colors.red, `${colors.red}✗${colors.reset}`],
  ];
  for (const [title, entries, color, glyph] of sections) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    log(`\n  ${color}${title}${colors.reset}`);
    for (const entry of entries) {
      const label = entry.label || entry.language || "dependency";
      const status = entry.status || (entry.ok ? "ok" : "failed");
      const message = firstLine(entry.message || entry.reason || "");
      log(`    ${glyph} ${label}: ${status}${message ? ` ${colors.dim}- ${message}${colors.reset}` : ""}`);
    }
  }
}

function renderUpdateSummary({ log, colors, result }) {
  const update = result?.update || {};
  const depsOk = result?.dependencies == null || result.dependencies?.ok !== false;
  log("");
  if (update.status === "updated") {
    log(`  ${colors.green}✓ Posse updated to ${shortSha(update.after)}${colors.reset}`);
    log(`    ${colors.dim}restart any running posse sessions to pick up the new code${colors.reset}`);
  } else if (update.status === "up-to-date") {
    log(`  ${colors.green}✓ Posse is up to date at ${shortSha(update.after)}${colors.reset}`);
  } else if (update.status === "would-update") {
    log(`  ${colors.yellow}! Update available: ${shortSha(update.before)} → ${shortSha(update.remote_sha)}${colors.reset} ${colors.dim}— run posse update to apply${colors.reset}`);
  } else if (update.status === "blocked") {
    log(`  ${colors.red}✗ Update blocked: ${update.message || "update blocked"}${colors.reset}`);
  } else {
    log(`  ${colors.red}✗ Update failed: ${update.message || "update failed"}${colors.reset}`);
  }
  if (update.dirty) {
    const dirtyLines = String(update.dirty).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    for (const line of dirtyLines.slice(0, 6)) {
      log(`    ${colors.dim}${line}${colors.reset}`);
    }
    if (dirtyLines.length > 6) {
      log(`    ${colors.dim}… +${dirtyLines.length - 6} more${colors.reset}`);
    }
  }
  if (update.ok !== false && !depsOk) {
    log(`  ${colors.yellow}! some dependencies need attention — run posse doctor after fixing the tools it names${colors.reset}`);
  }
  log(`  ${colors.dim}install: ${result.posse_root}${colors.reset}`);
  if (update.remote_url) {
    log(`  ${colors.dim}source:  ${update.remote}/${update.branch} (${update.remote_url})${colors.reset}`);
  }
  log("");
}

function renderUpdateHelp({ log, colors }) {
  log(`
  ${colors.bold}posse update${colors.reset}

  Fast-forward the local Posse client checkout, show what came in, and refresh
  runtime dependencies (posse doctor).

  Usage:
    posse update
    posse update --dry-run     check for updates without touching the checkout
    posse update --json        machine-readable result
    posse update --branch main

  The update is fast-forward only and refuses local tracked edits.
`);
}

export async function cmdUpdate({
  argv = process.argv.slice(3),
  posseRoot = DEFAULT_POSSE_ROOT,
  projectDir = process.cwd(),
  colors = C,
  log = console.log,
  stream = process.stdout,
  git = runGitCommand,
  runDoctor = doctorRepoDependencies,
} = {}) {
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    renderUpdateHelp({ log, colors });
    return null;
  }

  const json = hasArg(argv, "--json");
  const dryRun = hasArg(argv, "--dry-run");
  let branch;
  try {
    branch = normalizeBranch(flagValue(argv, "--branch") || DEFAULT_BRANCH);
  } catch (err) {
    log(`  ${colors.red}✗ ${firstLine(err?.message || err)}${colors.reset}`);
    process.exitCode = 1;
    return null;
  }

  const renderer = json ? null : createUpdateRenderer({ colors, log, stream });
  if (!json) {
    log("");
    log(`  ${colors.bold}${colors.cyan}posse${colors.reset}${colors.bold} update${colors.reset}${colors.dim} · ${DEFAULT_REMOTE}/${branch}${dryRun ? " · dry run" : ""}${colors.reset}`);
    log("");
  }

  let result;
  try {
    result = await updatePosseClient({
      posseRoot,
      projectDir,
      branch,
      dryRun,
      git,
      runDoctor,
      ui: renderer,
    });
  } finally {
    renderer?.stop();
  }

  if (json) {
    log(JSON.stringify(result, null, 2));
  } else {
    renderDependencySections({ log, colors, dependencies: result.dependencies });
    renderUpdateSummary({ log, colors, result });
  }

  if (!result.ok) process.exitCode = 1;
  return result;
}
