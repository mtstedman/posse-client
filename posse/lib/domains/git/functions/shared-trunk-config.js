// @ts-check

// Pure shared-trunk enrollment resolution. This module intentionally performs
// no Git or network calls: callers inject already-resolved repository facts and
// an optional native-capability preflight. Disabled repositories return before
// any of those injections are consulted.

import path from "node:path";

import {
  SETTING_KEYS,
  SHARED_TRUNK_DEFAULTS,
  SHARED_TRUNK_LIMITS,
} from "../../../catalog/settings.js";
import { getAccountRepoSetting } from "../../settings/functions/account-settings.js";

export class SharedTrunkConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SharedTrunkConfigError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SharedTrunkConfigError(code, message);
}

function readBoolean(value, fallback, key) {
  if (value == null || String(value).trim() === "") return fallback;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fail("invalid_boolean", `${key} must be true or false.`);
}

function readInteger(value, fallback, key, limits) {
  const normalized = value == null || String(value).trim() === ""
    ? String(fallback)
    : String(value).trim();
  if (!/^-?\d+$/.test(normalized)) {
    return fail("invalid_integer", `${key} must be an integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    return fail("invalid_integer", `${key} must be a safe integer.`);
  }
  if (parsed < limits.min || parsed > limits.max) {
    return fail(
      "out_of_range",
      `${key} must be between ${limits.min} and ${limits.max}.`,
    );
  }
  return parsed;
}

function safeBranchName(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.length > 240 || branch === "@" || branch.startsWith("-")) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) return false;
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{")) return false;
  if (/[\x00-\x20\x7f~^:?*[\]\\]/.test(branch)) return false;
  return branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

function safeRemoteName(value) {
  const remote = String(value || "").trim();
  return remote !== "."
    && remote !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote);
}

function normalizeDetectedDefaultBranch(value, remote) {
  if (value == null) return "";
  let branch = String(value).trim();
  for (const prefix of [`refs/remotes/${remote}/`, `${remote}/`, "refs/heads/"]) {
    if (branch.startsWith(prefix)) {
      branch = branch.slice(prefix.length);
      break;
    }
  }
  return branch;
}

function resolveInjectedValue(value, resolver, projectDir, context, label) {
  const resolved = typeof resolver === "function"
    ? resolver(projectDir, context)
    : value;
  if (resolved && typeof resolved.then === "function") {
    return fail("async_preflight", `${label} must be resolved before shared-trunk config is evaluated.`);
  }
  return resolved;
}

function verifyNativeCapabilityPreflight(preflight, config, projectDir) {
  if (preflight == null) return false;
  const result = typeof preflight === "function" ? preflight(config, projectDir) : preflight;
  if (result && typeof result.then === "function") {
    return fail("async_preflight", "Native capability preflight must return a synchronous result.");
  }
  const supported = result === true
    || result?.ok === true
    || result?.available === true
    || result?.supported === true;
  if (!supported) {
    const detail = typeof result?.error === "string"
      ? result.error
      : typeof result?.reason === "string"
        ? result.reason
        : "required native Git capabilities are unavailable";
    return fail("native_capability_unavailable", `Shared trunk cannot be enabled: ${detail}.`);
  }
  return true;
}

/**
 * Resolve and validate the repo-scoped shared-trunk settings.
 *
 * Enabled callers must inject the already-resolved target branch and an
 * explicit remote-default-branch result. `null` means the remote was checked
 * and has no detectable default; `undefined` means no check occurred and fails
 * closed. The optional native preflight may be a synchronous callback or a
 * precomputed result. Nothing except the enable setting is consulted while the
 * feature is disabled.
 */
export function resolveSharedTrunkConfig(projectDir = process.cwd(), options = {}) {
  const repoPath = path.resolve(String(projectDir || process.cwd()));
  const readSetting = typeof options.readSetting === "function"
    ? options.readSetting
    : (key) => getAccountRepoSetting(key, repoPath);
  const read = (key) => readSetting(key, { projectDir: repoPath });

  const enabled = readBoolean(
    read(SETTING_KEYS.SHARED_TRUNK_ENABLED),
    SHARED_TRUNK_DEFAULTS.enabled,
    SETTING_KEYS.SHARED_TRUNK_ENABLED,
  );
  if (!enabled) return Object.freeze({ enabled: false });

  const branch = String(read(SETTING_KEYS.SHARED_TRUNK_BRANCH) ?? SHARED_TRUNK_DEFAULTS.branch).trim();
  const remote = String(read(SETTING_KEYS.SHARED_TRUNK_REMOTE) ?? SHARED_TRUNK_DEFAULTS.remote).trim()
    || SHARED_TRUNK_DEFAULTS.remote;
  if (!safeBranchName(branch)) {
    fail("invalid_branch", `${SETTING_KEYS.SHARED_TRUNK_BRANCH} must be a non-empty safe Git branch name.`);
  }
  if (!safeRemoteName(remote)) {
    fail("invalid_remote", `${SETTING_KEYS.SHARED_TRUNK_REMOTE} must be a safe configured remote name.`);
  }
  if (branch === "main" || branch === "master") {
    fail("protected_default_branch", "Shared trunk must be a side branch; main and master are not allowed.");
  }

  const resolvedTargetBranch = String(resolveInjectedValue(
    options.resolvedTargetBranch,
    options.resolveTargetBranch,
    projectDir,
    Object.freeze({ branch, remote }),
    "Target branch",
  ) || "").trim();
  if (!resolvedTargetBranch) {
    fail("target_branch_unresolved", "Shared trunk requires an explicitly resolved target branch.");
  }
  if (branch !== resolvedTargetBranch) {
    fail(
      "target_branch_mismatch",
      `${SETTING_KEYS.SHARED_TRUNK_BRANCH} (${branch}) must equal resolved ${SETTING_KEYS.TARGET_BRANCH} (${resolvedTargetBranch}).`,
    );
  }

  const hasDefaultBranchValue = Object.prototype.hasOwnProperty.call(options, "detectedRemoteDefaultBranch");
  if (!hasDefaultBranchValue && typeof options.detectRemoteDefaultBranch !== "function") {
    fail("remote_default_unchecked", "Shared trunk requires an explicit remote default-branch preflight.");
  }
  const detectedRemoteDefaultBranch = normalizeDetectedDefaultBranch(resolveInjectedValue(
    options.detectedRemoteDefaultBranch,
    options.detectRemoteDefaultBranch,
    projectDir,
    Object.freeze({ branch, remote }),
    "Remote default branch",
  ), remote);
  if (detectedRemoteDefaultBranch === branch) {
    fail(
      "remote_default_branch",
      `Shared trunk branch ${branch} is the detected default branch of remote ${remote}.`,
    );
  }

  const fetchIntervalSec = readInteger(
    read(SETTING_KEYS.SHARED_TRUNK_FETCH_INTERVAL_SEC),
    SHARED_TRUNK_DEFAULTS.fetchIntervalSec,
    SETTING_KEYS.SHARED_TRUNK_FETCH_INTERVAL_SEC,
    SHARED_TRUNK_LIMITS.fetchIntervalSec,
  );
  const fetchIntervalIdleSec = readInteger(
    read(SETTING_KEYS.SHARED_TRUNK_FETCH_INTERVAL_IDLE_SEC),
    SHARED_TRUNK_DEFAULTS.fetchIntervalIdleSec,
    SETTING_KEYS.SHARED_TRUNK_FETCH_INTERVAL_IDLE_SEC,
    SHARED_TRUNK_LIMITS.fetchIntervalIdleSec,
  );
  if (fetchIntervalIdleSec < fetchIntervalSec) {
    fail(
      "invalid_fetch_intervals",
      `${SETTING_KEYS.SHARED_TRUNK_FETCH_INTERVAL_IDLE_SEC} must be at least ${SETTING_KEYS.SHARED_TRUNK_FETCH_INTERVAL_SEC}.`,
    );
  }

  const pushRetryMax = readInteger(
    read(SETTING_KEYS.SHARED_TRUNK_PUSH_RETRY_MAX),
    SHARED_TRUNK_DEFAULTS.pushRetryMax,
    SETTING_KEYS.SHARED_TRUNK_PUSH_RETRY_MAX,
    SHARED_TRUNK_LIMITS.pushRetryMax,
  );
  const claimsEnabled = readBoolean(
    read(SETTING_KEYS.SHARED_TRUNK_CLAIMS_ENABLED),
    SHARED_TRUNK_DEFAULTS.claimsEnabled,
    SETTING_KEYS.SHARED_TRUNK_CLAIMS_ENABLED,
  );
  const claimsTtlMin = readInteger(
    read(SETTING_KEYS.SHARED_TRUNK_CLAIMS_TTL_MIN),
    SHARED_TRUNK_DEFAULTS.claimsTtlMin,
    SETTING_KEYS.SHARED_TRUNK_CLAIMS_TTL_MIN,
    SHARED_TRUNK_LIMITS.claimsTtlMin,
  );
  const claimDeferMaxMin = readInteger(
    read(SETTING_KEYS.SHARED_TRUNK_CLAIM_DEFER_MAX_MIN),
    SHARED_TRUNK_DEFAULTS.claimDeferMaxMin,
    SETTING_KEYS.SHARED_TRUNK_CLAIM_DEFER_MAX_MIN,
    SHARED_TRUNK_LIMITS.claimDeferMaxMin,
  );
  if (claimDeferMaxMin > claimsTtlMin) {
    fail(
      "invalid_claim_aging",
      `${SETTING_KEYS.SHARED_TRUNK_CLAIM_DEFER_MAX_MIN} must not exceed ${SETTING_KEYS.SHARED_TRUNK_CLAIMS_TTL_MIN}.`,
    );
  }

  const config = {
    enabled: true,
    branch,
    remote,
    resolvedTargetBranch,
    detectedRemoteDefaultBranch: detectedRemoteDefaultBranch || null,
    fetchIntervalSec,
    fetchIntervalIdleSec,
    pushRetryMax,
    claimsEnabled,
    claimsTtlMin,
    claimDeferMaxMin,
  };
  const nativeCapabilitiesVerified = verifyNativeCapabilityPreflight(
    options.nativeCapabilityPreflight,
    Object.freeze({ ...config }),
    projectDir,
  );
  return Object.freeze({ ...config, nativeCapabilitiesVerified });
}

/**
 * Production resolver. The enable flag is read before Git/native modules are
 * dynamically loaded, so a disabled repository performs no repository probe
 * and invokes no capability preflight. When enabled, the optional preflight is
 * called as `await nativeCapabilityPreflight({ projectDir, remote, branch })`.
 */
export async function resolveSharedTrunkConfigRuntime(projectDir = process.cwd(), {
  nativeCapabilityPreflight = null,
} = {}) {
  const repoPath = path.resolve(String(projectDir || process.cwd()));
  const settingCache = new Map();
  const readSetting = (key) => {
    if (!settingCache.has(key)) settingCache.set(key, getAccountRepoSetting(key, repoPath));
    return settingCache.get(key);
  };
  const enabled = readBoolean(
    readSetting(SETTING_KEYS.SHARED_TRUNK_ENABLED),
    SHARED_TRUNK_DEFAULTS.enabled,
    SETTING_KEYS.SHARED_TRUNK_ENABLED,
  );
  if (!enabled) {
    return resolveSharedTrunkConfig(repoPath, { readSetting });
  }

  const branch = String(readSetting(SETTING_KEYS.SHARED_TRUNK_BRANCH) ?? SHARED_TRUNK_DEFAULTS.branch).trim();
  const remote = String(readSetting(SETTING_KEYS.SHARED_TRUNK_REMOTE) ?? SHARED_TRUNK_DEFAULTS.remote).trim()
    || SHARED_TRUNK_DEFAULTS.remote;
  const [targetBranchModule, gitUtilsModule] = await Promise.all([
    import("./target-branch.js"),
    import("./utils.js"),
  ]);
  const [resolvedTargetBranch, detectedRemoteDefaultBranch] = await Promise.all([
    targetBranchModule.resolveTargetBranchAsync(repoPath),
    gitUtilsModule.gitExecSafeAsync(
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
      repoPath,
    ),
  ]);
  const preflightResult = typeof nativeCapabilityPreflight === "function"
    ? await nativeCapabilityPreflight({ projectDir: repoPath, remote, branch })
    : nativeCapabilityPreflight;

  return resolveSharedTrunkConfig(repoPath, {
    readSetting,
    resolvedTargetBranch,
    detectedRemoteDefaultBranch: detectedRemoteDefaultBranch || null,
    nativeCapabilityPreflight: preflightResult,
  });
}
