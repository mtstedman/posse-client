// @ts-check
//
// Shared merge-target branch resolution. Settings and work-item branches are
// gathered in Node, while Git branch detection is owned by the native binary.

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting, listWorkItems } from "../../queue/functions/index.js";
import { runGitNativeMethod } from "./native/invoke.js";

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

/**
 * Resolve the merge target branch from the persisted target_branch setting,
 * known work-item branches, and native Git branch state.
 */
export function resolveTargetBranch(projectDir, nativeParity = {}) {
  const result = runGitNativeMethod(
    "git.resolveTargetBranch",
    {
      projectDir,
      configuredTarget: configuredTargetBranch(projectDir) || null,
      knownWorkItemBranches: knownWorkItemBranches(),
    },
    nativeParity,
  );

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const resolved = /** @type {{ branch?: unknown, warnings?: unknown }} */ (result);
    warnNativeTargetBranchMessages(projectDir, resolved.warnings);
    return String(resolved.branch || "").trim() || "main";
  }
  return String(result || "").trim() || "main";
}
