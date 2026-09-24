// Per-instance pairing access preflight. The exact shared branch is fetched and
// dry-run pushed by the native Git boundary. When advisory claims are enabled,
// a unique claim ref is also created and CAS-deleted to prove that namespace.

import { randomBytes } from "node:crypto";

import { SHARED_TRUNK_REMOTE_HEAD_FAILURES } from "../../../catalog/shared-trunk.js";
import {
  cacheSharedTrunkRemoteDefaultBranch,
  resolveSharedTrunkConfigRuntime,
  sharedTrunkRemoteHeadError,
} from "../../git/functions/shared-trunk-config.js";
import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import {
  gitHubCliAuthRemediation,
  isGitPushAuthenticationFailure,
} from "../../git/functions/git-push-auth.js";
import {
  casPushSharedTrunkClaimNative,
  getSharedTrunkNativeCapabilities,
  preflightSharedTrunkNative,
} from "../../git/functions/shared-trunk-native.js";

const OID_RE = /^[0-9a-f]{40,64}$/u;

function nativeResult(envelope) {
  return envelope && Object.prototype.hasOwnProperty.call(envelope, "result")
    ? envelope.result
    : envelope;
}

function resultStatus(result) {
  return String(result?.outcome || result?.status || result?.result || "").trim().toLowerCase();
}

function unavailableReason(envelope) {
  return envelope?.available === true
    ? null
    : String(envelope?.reason || "native_capability_unavailable");
}

function preflightFailure(code, message, detail = {}) {
  return {
    ok: false,
    code,
    message,
    ...detail,
  };
}

/** The fail-closed failure for a native preflight error that reports a remote
 * HEAD naming no default branch (posse-git's code-prefixed message), or null. */
function remoteHeadFailure(error, remote, branch) {
  const detail = [error?.message, error?.stderr].filter(Boolean).map(String).join("\n");
  const prefix = Object.keys(SHARED_TRUNK_REMOTE_HEAD_FAILURES)
    .find((key) => new RegExp(`\\b${key}:`, "u").test(detail));
  if (!prefix) return null;
  const headError = sharedTrunkRemoteHeadError(SHARED_TRUNK_REMOTE_HEAD_FAILURES[prefix], remote);
  return preflightFailure(headError.code, headError.message, { remote, branch });
}

function authFailure(projectDir, remote, failure, gitExec = adminGitExec) {
  const status = resultStatus(failure);
  const detail = {
    stderr: failure?.stderr,
    stdout: failure?.stdout,
    message: [failure?.message, failure?.error, failure?.reason, status]
      .filter(Boolean)
      .map(String)
      .join("\n"),
  };
  if (!["auth_failed", "authentication_failed", "unauthorized"].includes(status)
    && !isGitPushAuthenticationFailure(detail)) return null;
  let remoteUrl = null;
  try {
    remoteUrl = gitExec(["remote", "get-url", "--push", remote], projectDir, { timeoutMs: 5_000 }).trim();
  } catch { /* retain host-neutral commands */ }
  const remediation = gitHubCliAuthRemediation(remoteUrl);
  return preflightFailure(remediation.reason, remediation.message, {
    remote,
    remediation_commands: remediation.commands,
  });
}

async function roundTripClaimProbe({ projectDir, config, casPush, randomKey }) {
  const claimKey = randomKey();
  if (!/^[0-9a-f]{64}$/u.test(claimKey)) {
    throw new Error("Pairing preflight claim key generator returned an invalid key");
  }
  const payload = {
    protocol: "posse.shared_trunk_preflight.v1",
    instance_id: `preflight-${process.pid}`,
    nonce: claimKey,
    created_at: new Date().toISOString(),
  };
  const createdEnvelope = await casPush({
    cwd: projectDir,
    remote: config.remote,
    claimKey,
    expectedOldOid: null,
    payload,
  });
  const unavailable = unavailableReason(createdEnvelope);
  if (unavailable) throw new Error(`Pairing claim-ref preflight unavailable: ${unavailable}`);
  const created = nativeResult(createdEnvelope) || {};
  const createdStatus = resultStatus(created);
  const objectOid = String(created.newOid || created.new_oid || "").trim();
  if (createdStatus !== "applied" || !OID_RE.test(objectOid)) {
    throw new Error(`Pairing claim-ref create failed: ${createdStatus || "unexpected_outcome"}`);
  }

  let deleted = null;
  try {
    const deletedEnvelope = await casPush({
      cwd: projectDir,
      remote: config.remote,
      claimKey,
      expectedOldOid: objectOid,
      payload: null,
    });
    const deleteUnavailable = unavailableReason(deletedEnvelope);
    if (deleteUnavailable) throw new Error(`Pairing claim-ref cleanup unavailable: ${deleteUnavailable}`);
    deleted = nativeResult(deletedEnvelope) || {};
    const deletedStatus = resultStatus(deleted);
    const deletedOid = deleted.newOid ?? deleted.new_oid ?? null;
    if (deletedStatus !== "applied" || deletedOid != null) {
      throw new Error(`Pairing claim-ref cleanup failed: ${deletedStatus || "unexpected_outcome"}`);
    }
  } catch (error) {
    error.probeRef = `refs/posse/claims/${claimKey}`;
    throw error;
  }

  return {
    attempted: true,
    created: true,
    deleted: true,
    outcome: resultStatus(deleted),
  };
}

/**
 * Verify the current clone's access to its configured pairing remote. This is
 * intentionally explicit rather than a recurring startup mutation.
 */
export async function runSharedTrunkAccessPreflight(projectDir = process.cwd(), options = {}) {
  const getCapabilities = options.getCapabilities || getSharedTrunkNativeCapabilities;
  const resolveConfig = options.resolveConfig || resolveSharedTrunkConfigRuntime;
  const preflightNative = options.preflightNative || preflightSharedTrunkNative;
  const casPush = options.casPush || casPushSharedTrunkClaimNative;
  const randomKey = options.randomKey || (() => randomBytes(32).toString("hex"));

  let capabilities;
  try {
    capabilities = await getCapabilities(projectDir);
  } catch (error) {
    return preflightFailure(
      error?.code || "native_capability_error",
      error?.message || String(error),
    );
  }
  const capabilityUnavailable = unavailableReason(capabilities);
  if (capabilityUnavailable) {
    return preflightFailure(capabilityUnavailable, "Shared-trunk native capability is unavailable");
  }
  const capabilityResult = nativeResult(capabilities) || {};
  if (options.requireScopeEnforcement === true && capabilityResult.scopeEnforcement !== true) {
    return preflightFailure(
      "native_scope_enforcement_unavailable",
      "Scoped sessions require a posse-git binary with native scope enforcement",
    );
  }
  if (typeof options.onCapabilities === "function") options.onCapabilities(capabilityResult);

  let config;
  try {
    config = options.config || await resolveConfig(projectDir, {
      nativeCapabilityPreflight: async () => capabilities,
    });
  } catch (error) {
    return preflightFailure(error?.code || "shared_trunk_config_invalid", error?.message || String(error));
  }
  if (!config?.enabled) {
    return preflightFailure("shared_trunk_disabled", "Shared trunk must be configured and enabled before pairing preflight");
  }

  let remoteEnvelope;
  try {
    remoteEnvelope = await preflightNative({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
    });
  } catch (error) {
    const auth = authFailure(projectDir, config.remote, error, options.gitExec);
    if (auth) return auth;
    const remoteHead = remoteHeadFailure(error, config.remote, config.branch);
    if (remoteHead) return remoteHead;
    return preflightFailure(error?.code || "remote_access_failed", error?.message || String(error), {
      remote: config.remote,
      branch: config.branch,
    });
  }
  const remoteUnavailable = unavailableReason(remoteEnvelope);
  if (remoteUnavailable) {
    return preflightFailure(remoteUnavailable, "Shared-trunk remote access preflight is unavailable", {
      remote: config.remote,
      branch: config.branch,
    });
  }
  const remoteCheck = nativeResult(remoteEnvelope) || {};
  const remoteAuth = authFailure(projectDir, config.remote, remoteCheck, options.gitExec);
  if (remoteAuth) return remoteAuth;
  const remoteOid = String(remoteCheck.remoteOid || remoteCheck.remote_oid || "").trim();
  const checkedRemote = String(remoteCheck.remote || "").trim();
  const checkedBranch = String(remoteCheck.branch || "").trim();
  const defaultBranch = String(remoteCheck.defaultBranch || remoteCheck.default_branch || "").trim();
  const writeCheck = String(remoteCheck.writeCheck || remoteCheck.write_check || "").trim();
  if (remoteCheck.readAccess !== true
    || remoteCheck.writeTransportAccess !== true
    || !OID_RE.test(remoteOid)
    || checkedRemote !== config.remote
    || checkedBranch !== config.branch
    || !defaultBranch
    || defaultBranch === config.branch
    || writeCheck !== "dry_run_exact_branch_lease") {
    return preflightFailure("remote_access_unproven", "Native preflight did not prove exact-branch remote read/write transport access", {
      remote: config.remote,
      branch: config.branch,
    });
  }

  let claimProbe = { attempted: false, skipped: "claims_disabled" };
  cacheSharedTrunkRemoteDefaultBranch(projectDir, config.remote, config.branch, defaultBranch);
  if (config.claimsEnabled === true) {
    try {
      claimProbe = await roundTripClaimProbe({ projectDir, config, casPush, randomKey });
    } catch (error) {
      const auth = authFailure(projectDir, config.remote, error, options.gitExec);
      if (auth) return { ...auth, remoteOid };
      return preflightFailure(error?.code || "claim_ref_access_failed", error?.message || String(error), {
        remote: config.remote,
        branch: config.branch,
        remoteOid,
        claimProbe: {
          attempted: true,
          created: Boolean(error?.probeRef),
          deleted: false,
          residualRef: error?.probeRef || null,
        },
      });
    }
  }

  return {
    ok: true,
    remote: config.remote,
    branch: config.branch,
    defaultBranch,
    remoteOid,
    checks: {
      nativeContract: true,
      readAccess: true,
      writeTransportAccess: true,
      claimRefAccess: config.claimsEnabled === true ? true : null,
    },
    writeCheck,
    branchPolicyVerified: remoteCheck.branchPolicyVerified === true,
    claimProbe,
  };
}
