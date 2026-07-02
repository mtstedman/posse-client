// @ts-check
//
// Shared merge-target branch resolution. Settings and work-item branches are
// gathered in Node, while Git branch detection is owned by the native binary.

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting, listWorkItems } from "../../queue/functions/index.js";
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
