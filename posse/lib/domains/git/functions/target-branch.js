// @ts-check
//
// Shared merge-target branch resolution. Settings and work-item branches are
// gathered in Node, while Git branch detection is owned by the native binary.

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting, listWorkItems } from "../../queue/functions/index.js";
import { adminGitExec } from "./admin-git.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

const _warnedTargetBranchMessages = new Set();

function configuredTargetBranch(projectDir) {
  try {
    const configured = getSetting(SETTING_KEYS.TARGET_BRANCH, { projectDir });
    return String(configured || "").trim();
  } catch {
    return "";
  }
}

function knownWorkItemBranches() {
  const branches = new Set();
  try {
    for (const wi of listWorkItems()) {
      const branch = String(wi?.branch_name || "").trim();
      if (branch) branches.add(branch);
    }
  } catch {
    // DB may be unavailable in low-level git tests.
  }
  return [...branches].sort();
}

function warnNativeTargetBranchMessages(projectDir, warnings) {
  if (!Array.isArray(warnings)) return;
  for (const warning of warnings) {
    const message = String(warning || "").trim();
    if (!message) continue;
    const key = `${projectDir || "."}\0${message}`;
    if (_warnedTargetBranchMessages.has(key)) continue;
    _warnedTargetBranchMessages.add(key);
    try {
      // eslint-disable-next-line no-console
      console.warn(`[posse] ${message}`);
    } catch { /* ignore */ }
  }
}

function targetBranchRequestPayload(projectDir) {
  return {
    projectDir,
    configuredTarget: configuredTargetBranch(projectDir) || null,
    knownWorkItemBranches: knownWorkItemBranches(),
  };
}

function normalizeResolvedTargetBranch(projectDir, result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const resolved = /** @type {{ branch?: unknown, warnings?: unknown }} */ (result);
    warnNativeTargetBranchMessages(projectDir, resolved.warnings);
    return String(resolved.branch || "").trim() || "main";
  }
  return String(result || "").trim() || "main";
}

function adminGitValue(projectDir, args) {
  try {
    return String(adminGitExec(args, projectDir, { timeoutMs: 5000 }) || "").trim();
  } catch {
    return "";
  }
}

function adminLocalBranchExists(projectDir, branch) {
  const name = String(branch || "").trim();
  if (!name) return false;
  try {
    adminGitExec(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], projectDir, { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function adminStripRemotePrefix(value) {
  const name = String(value || "").trim();
  const separator = name.indexOf("/");
  return separator === -1 ? name : name.slice(separator + 1);
}

function adminIsWorkItemBranch(branch, known) {
  const name = String(branch || "").trim();
  return name.startsWith("posse/")
    || /^wi-\d+(?:$|[-_/.:\s])/.test(name)
    || known.has(name);
}

/**
 * Resolve the target branch for operator/admin surfaces without starting the
 * native daemon. This mirrors the native resolver's ordering while keeping
 * Bossy status/merge independent from agent heartbeat/MCP readiness.
 */
export function resolveTargetBranchForAdmin(projectDir) {
  const warnings = [];
  const known = new Set(knownWorkItemBranches());
  const configured = configuredTargetBranch(projectDir);
  if (configured) {
    if (adminLocalBranchExists(projectDir, configured)) {
      return normalizeResolvedTargetBranch(projectDir, { branch: configured, warnings });
    }
    const remoteBranches = adminGitValue(projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
      .split(/\r?\n/)
      .map(adminStripRemotePrefix);
    const repoAvailable = !!adminGitValue(projectDir, ["rev-parse", "--git-dir"]);
    if (!repoAvailable) return normalizeResolvedTargetBranch(projectDir, { branch: configured, warnings });
    if (!remoteBranches.includes(configured)) {
      warnings.push(`Configured target_branch '${configured}' was not found locally or on a remote; falling back to branch detection.`);
    }
  }

  const remoteDefault = adminStripRemotePrefix(adminGitValue(projectDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]));
  if (remoteDefault && adminLocalBranchExists(projectDir, remoteDefault) && !adminIsWorkItemBranch(remoteDefault, known)) {
    return normalizeResolvedTargetBranch(projectDir, { branch: remoteDefault, warnings });
  }

  // An operator may launch Posse from a terminal feature branch. Prefer the
  // repository's conventional trunk before treating that caller branch as the
  // merge target; otherwise the final WI is squash-merged into itself and the
  // push offer publishes the feature branch instead of trunk.
  const hasMain = adminLocalBranchExists(projectDir, "main");
  const hasMaster = adminLocalBranchExists(projectDir, "master");
  if (hasMain || hasMaster) {
    if (hasMain && hasMaster) warnings.push("Both 'main' and 'master' exist - using 'main'.");
    return normalizeResolvedTargetBranch(projectDir, {
      branch: hasMain ? "main" : "master",
      warnings,
    });
  }

  const current = adminGitValue(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current && current !== "HEAD" && adminLocalBranchExists(projectDir, current) && !adminIsWorkItemBranch(current, known)) {
    return normalizeResolvedTargetBranch(projectDir, { branch: current, warnings });
  }

  const upstream = adminStripRemotePrefix(adminGitValue(projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]));
  if (upstream && adminLocalBranchExists(projectDir, upstream) && !adminIsWorkItemBranch(upstream, known)) {
    return normalizeResolvedTargetBranch(projectDir, { branch: upstream, warnings });
  }

  const localBranches = adminGitValue(projectDir, ["branch", "--format=%(refname:short)"])
    .split(/\r?\n/)
    .map((branch) => branch.trim())
    .filter((branch) => branch && !adminIsWorkItemBranch(branch, known));
  if (localBranches.length === 1) {
    return normalizeResolvedTargetBranch(projectDir, { branch: localBranches[0], warnings });
  }

  return normalizeResolvedTargetBranch(projectDir, {
    branch: "main",
    warnings,
  });
}

/**
 * Resolve the merge target branch from the persisted target_branch setting,
 * known work-item branches, and native Git branch state.
 *
 * The sync form has exactly two legitimate roots (audited 2026-07): the
 * orchestrator-app `getTargetBranch` callback (createGitWorkflowHelpers
 * requires a SYNCHRONOUS getTargetBranch — see workflow-context.js) and
 * `deleteBranchPreservingTip`'s default param (sync CLI cleanup lane). Every
 * other caller must use resolveTargetBranchAsync.
 */
export function resolveTargetBranch(projectDir, nativeParity = {}) {
  return normalizeResolvedTargetBranch(
    projectDir,
    runGitNativeMethod("git.resolveTargetBranch", targetBranchRequestPayload(projectDir), nativeParity),
  );
}

/**
 * Async twin for main-loop call sites (job lifecycle, freshness gate, warm
 * dispatch): the native git call runs off the event loop, so a TUI render
 * frame never blocks on branch resolution.
 */
export async function resolveTargetBranchAsync(projectDir, options = {}) {
  return normalizeResolvedTargetBranch(
    projectDir,
    await runGitNativeMethodAsync("git.resolveTargetBranch", targetBranchRequestPayload(projectDir), options),
  );
}
