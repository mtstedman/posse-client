// Per-instance pairing access preflight. The exact shared branch is fetched and
// dry-run pushed by the native Git boundary. When advisory claims are enabled,
// a unique claim ref is also created and CAS-deleted to prove that namespace.

import { randomBytes } from "node:crypto";

import { resolveSharedTrunkConfigRuntime } from "../../git/functions/shared-trunk-config.js";
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
  const remoteOid = String(remoteCheck.remoteOid || remoteCheck.remote_oid || "").trim();
  const checkedRemote = String(remoteCheck.remote || "").trim();
  const checkedBranch = String(remoteCheck.branch || "").trim();
  const writeCheck = String(remoteCheck.writeCheck || remoteCheck.write_check || "").trim();
  if (remoteCheck.readAccess !== true
    || remoteCheck.writeTransportAccess !== true
    || !OID_RE.test(remoteOid)
    || checkedRemote !== config.remote
    || checkedBranch !== config.branch
    || writeCheck !== "dry_run_exact_branch_lease") {
    return preflightFailure("remote_access_unproven", "Native preflight did not prove exact-branch remote read/write transport access", {
      remote: config.remote,
      branch: config.branch,
    });
  }

  let claimProbe = { attempted: false, skipped: "claims_disabled" };
  if (config.claimsEnabled === true) {
    try {
      claimProbe = await roundTripClaimProbe({ projectDir, config, casPush, randomKey });
    } catch (error) {
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
