import fs from "node:fs";
import { AUTOMATION_OWNER_ENTRY } from "./paths.js";
import {
  AUTOMATION_OWNER_ENV_DROP_KEYS,
  AUTOMATION_OWNER_ENV_DROP_PREFIXES,
  AUTOMATION_OWNER_LAUNCH,
} from "../../../catalog/custom-tools.js";

let processBuild = null;

// Build identity of the code this process runs (or would spawn) as the
// per-user automation owner. Computed once per process: the owner reports the
// identity it started with, a client compares it with its own. Provenance is
// imported lazily so the supervisor's small module graph stays unchanged.
export function automationBuildIdentity() {
  processBuild ||= (async () => {
    let provenance = {};
    try {
      const { resolveClientProvenance } = await import("../../runtime/functions/client-provenance.js");
      provenance = resolveClientProvenance() || {};
    } catch {}
    let entry = AUTOMATION_OWNER_ENTRY;
    try { entry = fs.realpathSync(entry); } catch {}
    return Object.freeze({
      package_version: provenance.package_version || null,
      commit: provenance.client_commit || null,
      entry,
    });
  })();
  return processBuild;
}

export function sameAutomationBuild(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return ["package_version", "commit", "entry"].every(field => (left[field] ?? null) === (right[field] ?? null));
}

export function automationOwnerLaunch(env = process.env) {
  const value = String(env.POSSE_AUTOMATION_LAUNCH || "");
  return value === AUTOMATION_OWNER_LAUNCH.AD_HOC || value === AUTOMATION_OWNER_LAUNCH.SERVICE
    ? value
    : AUTOMATION_OWNER_LAUNCH.FOREGROUND;
}

// What a client does with a ready owner. Owners that predate build identity
// are treated as mismatched ad-hoc owners unless a Posse service definition
// is installed: such an owner may be the service's, and a service manager
// does not restart an owner that exited cleanly. Service-managed and foreground
// owners are never replaced from a client; an owner labelled "service" while
// no Posse service definition is installed was started by a client that
// predates the ad-hoc marker and counts as ad hoc. A busy owner is left to
// finish.
// A live owner of another build is replaced at most once per client process
// (liveReplacementAttempted) so two concurrently running builds cannot trade
// the single per-user owner back and forth; an owner whose entry file is gone
// is stale and always replaced.
export function automationOwnerDecision(health, build, { entryExists = true, liveReplacementAttempted = false, serviceInstalled = true } = {}) {
  const owner = health?.build;
  if (!owner || typeof owner !== "object") {
    return serviceInstalled !== false ? { action: "keep", reason: "legacy_service_owner" } : { action: "replace", reason: "legacy_owner" };
  }
  if (sameAutomationBuild(owner, build)) return { action: "use", reason: "same_build" };
  if (health.launch === AUTOMATION_OWNER_LAUNCH.SERVICE && serviceInstalled !== false) return { action: "keep", reason: "service_managed" };
  if (health.launch !== AUTOMATION_OWNER_LAUNCH.AD_HOC && health.launch !== AUTOMATION_OWNER_LAUNCH.SERVICE) {
    return { action: "keep", reason: "not_ad_hoc" };
  }
  if (Number(health.active_runs) > 0) return { action: "keep", reason: "owner_busy" };
  if (entryExists === false) return { action: "replace", reason: "stale_owner" };
  if (liveReplacementAttempted) return { action: "keep", reason: "replacement_already_attempted" };
  return { action: "replace", reason: "build_mismatch", consumesReplacement: true };
}

// Environment for an ad-hoc supervisor/owner: the caller's environment minus
// per-run/per-project state, with the automation data directory pinned so the
// owner resolves the same socket and database as the caller.
export function automationOwnerEnv(env = process.env, { dataDir, platform = process.platform } = {}) {
  const pinned = new Set(["POSSE_AUTOMATION_DATA_DIR", ...AUTOMATION_OWNER_ENV_DROP_KEYS]);
  const result = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined) continue;
    const name = platform === "win32" ? key.toUpperCase() : key;
    if (pinned.has(name) || AUTOMATION_OWNER_ENV_DROP_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
    result[key] = value;
  }
  if (dataDir) {
    result.POSSE_AUTOMATION_DATA_DIR = dataDir;
    if (platform !== "win32") result.PWD = dataDir;
  }
  return result;
}
