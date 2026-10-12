// Authoritative cross-instance job delegation through the session Git remote.
// Rendezvous presence carries only capability names. Work packets and the
// one-winner claim live in separate Git ref namespaces and never touch the
// advisory path-claim mirror.

import crypto from "node:crypto";

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { SESSION_COMPUTE_POLICIES, SESSION_JOB_PROTOCOL, SESSION_PACKET_PROTOCOL, SESSION_JOB_OFFER_TTL_MS, SESSION_JOB_CLAIM_TTL_MS, SESSION_ROUTABLE_JOB_TYPES } from "../../../catalog/session-sync.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import { adminGitExecAsync } from "../../git/functions/admin-git.js";
import { casPushSharedTrunkClaimNative } from "../../git/functions/shared-trunk-native.js";
import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { getSetting } from "../../settings/functions/repository-settings.js";
import { getLivePairingState } from "../../pairing/functions/state.js";
import { readPairingPeerSnapshot } from "../../pairing/functions/work-items.js";
import { createJob, createWorkItem, getWorkItem, logEvent, refreshWorkItemStatus, updateJobProvider, updateJobStatus, updateWorkItemStatus } from "./queue-store.js";
import { now, runImmediateTransaction } from "./common.js";

// These names were already exported from this module; preserve that API while
// the catalog owns their canonical values.
export {
  SESSION_JOB_PROTOCOL,
  SESSION_PACKET_PROTOCOL,
  SESSION_JOB_OFFER_TTL_MS,
  SESSION_JOB_CLAIM_TTL_MS,
};
const REF_KEY_RE = /^[0-9a-f]{64}$/u;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ROUTABLE_JOB_TYPES = new Set(SESSION_ROUTABLE_JOB_TYPES);

function resultValue(result) {
  return result && typeof result.result === "object" ? result.result : result;
}

export function resultOutcome(result) {
  const value = resultValue(result);
  return String(value?.outcome || value?.status || "");
}

export function resultOid(result) {
  const value = resultValue(result);
  return value?.newOid || value?.new_oid || null;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function sessionJobOfferKey(sessionId, originatorInstanceId, originJobId) {
  const input = `${String(sessionId || "").trim()}\0${String(originatorInstanceId || "").trim()}\0${Number(originJobId)}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

function peerHeadroomAllows(peer, provider) {
  const capabilities = peer?.capabilities || {};
  if (!Array.isArray(capabilities.job_types) || !Array.isArray(capabilities.providers)) return false;
  if (provider && !capabilities.providers.includes(provider)) return false;
  if (!provider) return true;
  const row = Array.isArray(capabilities.headroom)
    ? capabilities.headroom.find((entry) => entry?.provider === provider)
    : null;
  return row?.available !== false;
}

export function peerCanExecuteSessionJob(peer, job) {
  const capabilities = peer?.capabilities || {};
  return Array.isArray(capabilities.job_types)
    && capabilities.job_types.includes(job?.job_type)
    && peerHeadroomAllows(peer, job?.provider || null);
}

function localProviderCanRun(job) {
  if (!job?.provider) return true;
  try {
    const providers = new Set();
    for (const role of PROVIDER_ROLE_NAMES) {
      const configured = String(getSetting(`provider_${role}`) || "claude");
      for (const provider of configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
        providers.add(provider);
      }
    }
    if (!providers.has(job.provider)) return false;
    const state = parseJson(getSetting(`${job.provider}_rate_limit_state`));
    return !Number.isFinite(Number(state?.untilMs)) || Number(state.untilMs) <= Date.now();
  } catch {
    return true;
  }
}

export function shouldOfferSessionJob(state, job, peers, { localCanRun = localProviderCanRun(job) } = {}) {
  if (!state || state.phase !== "active" || !ROUTABLE_JOB_TYPES.has(job?.job_type)) return null;
  if (!Array.isArray(peers) || peers.length === 0) return null;
  const eligible = peers.filter((peer) => peerCanExecuteSessionJob(peer, job));
  if (eligible.length === 0) return null;
  if (state.compute_policy === SESSION_COMPUTE_POLICIES.HOST_ONLY) {
    if (state.role === "host") return null;
    return eligible.find((peer) => peer.role === "host") || null;
  }
  if (state.compute_policy !== SESSION_COMPUTE_POLICIES.CAPABILITY_ROUTING || localCanRun) return null;
  return eligible[0];
}

export function sessionOriginatorConcurrencyBlocked(state, job, activeJobs, limit = 1) {
  if (state?.compute_policy !== SESSION_COMPUTE_POLICIES.HOST_ONLY || state.role !== "host") return false;
  const row = getDb().prepare(`
    SELECT originator_instance_id FROM work_item_delegations WHERE local_job_id = ?
  `).get(job?.id);
  if (!row?.originator_instance_id) return false;
  const activeIds = (Array.isArray(activeJobs) ? activeJobs : [])
    .map((entry) => Number(entry?.id ?? entry?.job?.id))
    .filter(Number.isSafeInteger);
  if (activeIds.length === 0) return false;
  const placeholders = activeIds.map(() => "?").join(",");
  const count = getDb().prepare(`
    SELECT COUNT(*) AS count FROM work_item_delegations
    WHERE originator_instance_id=? AND local_job_id IN (${placeholders})
  `).get(row.originator_instance_id, ...activeIds)?.count || 0;
  return Number(count) >= Math.max(1, Number(limit) || 1);
}

function packetFor(state, instanceId, workItem, job, eligibleInstanceIds) {
  return {
    protocol: SESSION_PACKET_PROTOCOL,
    session_id: state.remote_session_id,
    originator_instance_id: instanceId,
    origin_work_item_id: Number(workItem.id),
    origin_job_id: Number(job.id),
    eligible_instance_ids: eligibleInstanceIds,
    work_item: {
      title: String(workItem.title || "").slice(0, 4_000),
      description: String(workItem.description || "").slice(0, 500_000),
      priority: workItem.priority,
      mode: workItem.mode,
      governance_tier: workItem.governance_tier,
      metadata: parseJson(workItem.metadata_json),
    },
    job: {
      job_type: job.job_type,
      title: String(job.title || "").slice(0, 4_000),
      priority: job.priority,
      model_tier: job.model_tier,
      model_name: job.model_name,
      provider: job.provider,
      reasoning_effort: job.reasoning_effort,
      token_budget_input: job.token_budget_input,
      token_budget_output: job.token_budget_output,
      context_budget_chars: job.context_budget_chars,
      max_attempts: job.max_attempts,
      payload: parseJson(job.payload_json),
      context_text: String(job.context_text || "").slice(0, 500_000),
      skills: job.skills || null,
    },
    created_at: now(),
  };
}

export async function casRef({ projectDir, remote, namespace, key, expectedOldOid = null, payload = null, casPush }) {
  const result = await casPush({
    cwd: projectDir,
    remote,
    refNamespace: namespace,
    claimKey: key,
    expectedOldOid,
    payload,
  });
  if (result?.available === false) throw new Error(`session ref capability unavailable: ${result.reason || "unknown"}`);
  return result;
}

export async function offerSessionJob(job, {
  projectDir = process.cwd(),
  state = getLivePairingState(),
  snapshot = readPairingPeerSnapshot(),
  instanceId = ensureBridgeInstanceId(projectDir),
  casPush = casPushSharedTrunkClaimNative,
  localCanRun = localProviderCanRun(job),
} = {}) {
  const peers = (snapshot?.peers || []).filter((peer) => peer.instance_id !== instanceId);
  const target = shouldOfferSessionJob(state, job, peers, { localCanRun });
  if (!target) return { delegated: false, reason: "local_execution" };
  const workItem = getWorkItem(job.work_item_id);
  if (!workItem) return { delegated: false, reason: "missing_work_item" };
  const eligible = peers
    .filter((peer) => peerCanExecuteSessionJob(peer, job))
    .map((peer) => peer.instance_id);
  const key = sessionJobOfferKey(state.remote_session_id, instanceId, job.id);
  const packet = packetFor(state, instanceId, workItem, job, eligible);
  let packetResult;
  let offerResult;
  try {
    packetResult = await casRef({
      projectDir, remote: state.remote_name, namespace: "handoff", key,
      payload: packet, casPush,
    });
    if (resultOutcome(packetResult) !== "applied") return { delegated: false, reason: "packet_race" };
    const packetOid = resultOid(packetResult);
    const offer = {
      protocol: SESSION_JOB_PROTOCOL,
      state: "offered",
      session_id: state.remote_session_id,
      offer_key: key,
      packet_oid: packetOid,
      originator_instance_id: instanceId,
      origin_work_item_id: Number(workItem.id),
      origin_job_id: Number(job.id),
      job_type: job.job_type,
      provider: job.provider || null,
      eligible_instance_ids: eligible,
      created_at: now(),
    };
    offerResult = await casRef({
      projectDir, remote: state.remote_name, namespace: "jobs", key,
      payload: offer, casPush,
    });
    if (resultOutcome(offerResult) !== "applied") {
      throw Object.assign(new Error("session job offer CAS lost"), { code: "session_offer_race" });
    }
    const claimOid = resultOid(offerResult);
    runImmediateTransaction(getDb(), () => {
      getDb().prepare(`
        INSERT INTO work_item_delegations (
          id, session_id, originator_instance_id, origin_work_item_id, origin_job_id,
          offer_key, packet_oid, claim_oid, job_type, provider, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered')
        ON CONFLICT(offer_key) DO UPDATE SET
          packet_oid=excluded.packet_oid, claim_oid=excluded.claim_oid,
          state='offered', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(key, state.remote_session_id, instanceId, workItem.id, job.id, key, packetOid, claimOid, job.job_type, job.provider || null);
      if (!updateJobStatus(job.id, "blocked", { expectedStatuses: ["queued"] })) {
        throw new Error(`Session job #${job.id} is no longer queued`);
      }
      if (!updateWorkItemStatus(workItem.id, "blocked")) {
        throw new Error(`Session work item #${workItem.id} can no longer be blocked`);
      }
    });
    logEvent({
      work_item_id: workItem.id,
      job_id: job.id,
      event_type: EVENT_TYPES.SESSION_JOB_OFFERED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: `Offered job #${job.id} to ${eligible.length} session peer(s)`,
      event_json: JSON.stringify({ offer_key: key, eligible_instance_ids: eligible }),
    });
    return { delegated: true, offerKey: key, target: target.instance_id };
  } catch (error) {
    // The delegation decision is fail-closed to local execution. A transport
    // or capability error never parks the local job.
    if (offerResult && resultOid(offerResult)) {
      try {
        await casRef({
          projectDir, remote: state.remote_name, namespace: "jobs", key,
          expectedOldOid: resultOid(offerResult), payload: null, casPush,
        });
      } catch { /* best-effort dangling-offer cleanup */ }
    }
    if (packetResult && resultOid(packetResult)) {
      try {
        await casRef({
          projectDir, remote: state.remote_name, namespace: "handoff", key,
          expectedOldOid: resultOid(packetResult), payload: null, casPush,
        });
      } catch { /* best-effort dangling-packet cleanup */ }
    }
    return { delegated: false, reason: "unavailable", error };
  }
}

export function packetMatchesOffer(packet, offer, executorInstanceId) {
  return packet?.protocol === SESSION_PACKET_PROTOCOL
    && packet.session_id === offer.session_id
    && packet.originator_instance_id === offer.originator_instance_id
    && Number(packet.origin_work_item_id) === Number(offer.origin_work_item_id)
    && Number(packet.origin_job_id) === Number(offer.origin_job_id)
    && packet.job?.job_type === offer.job_type
    && (packet.job?.provider || null) === (offer.provider || null)
    && ROUTABLE_JOB_TYPES.has(packet.job?.job_type)
    && Array.isArray(packet.eligible_instance_ids)
    && packet.eligible_instance_ids.includes(executorInstanceId);
}

export async function fetchNamespace(projectDir, remote, namespace, execGit = adminGitExecAsync) {
  const prefix = `refs/posse/${namespace}/`;
  await execGit([
    "fetch", "--atomic", "--prune", "--no-tags", remote, `+${prefix}*:${prefix}*`,
  ], projectDir, { timeoutMs: 30_000 });
  const rows = await execGit([
    "for-each-ref", "--format=%(objectname) %(refname)", `${prefix}*`,
  ], projectDir, { timeoutMs: 10_000 });
  const result = [];
  for (const line of String(rows || "").split("\n").filter(Boolean).slice(0, 256)) {
    const [oid, refName] = line.trim().split(/\s+/u);
    const key = refName?.startsWith(prefix) ? refName.slice(prefix.length) : "";
    if (!OID_RE.test(oid || "") || !REF_KEY_RE.test(key)) continue;
    let payload;
    try {
      const text = await execGit(["cat-file", "blob", oid], projectDir, {
        timeoutMs: 10_000,
        maxBuffer: namespace === "handoff" ? 2 * 1024 * 1024 : 64 * 1024,
      });
      payload = parseJson(text, null);
    } catch {
      payload = null;
    }
    if (payload) result.push({ key, oid, refName, payload });
  }
  return result;
}

export function importPacket(packet, executorInstanceId, offerKey, claimOid) {
  const existing = getDb().prepare("SELECT * FROM work_item_delegations WHERE offer_key = ?").get(offerKey);
  if (existing) return existing;
  const wi = createWorkItem(
    packet.work_item?.title || `Delegated WI ${packet.origin_work_item_id}`,
    packet.work_item?.description || "Delegated session work item",
    packet.work_item?.priority || "normal",
    {
      source: `session:${packet.originator_instance_id}`,
      requested_by: packet.originator_instance_id,
      mode: packet.work_item?.mode || "build",
      governance_tier: packet.work_item?.governance_tier || "mvp",
      metadata: {
        ...(packet.work_item?.metadata || {}),
        session_delegation: {
          session_id: packet.session_id,
          originator_instance_id: packet.originator_instance_id,
          origin_work_item_id: packet.origin_work_item_id,
          origin_job_id: packet.origin_job_id,
          offer_key: offerKey,
        },
      },
    },
  );
  const payload = {
    ...(packet.job?.payload || {}),
    session_delegation: {
      originator_instance_id: packet.originator_instance_id,
      origin_work_item_id: packet.origin_work_item_id,
      origin_job_id: packet.origin_job_id,
      offer_key: offerKey,
    },
  };
  const job = createJob({
    work_item_id: wi.id,
    job_type: packet.job?.job_type,
    title: packet.job?.title || wi.title,
    priority: packet.job?.priority || wi.priority,
    model_tier: packet.job?.model_tier || "standard",
    reasoning_effort: packet.job?.reasoning_effort,
    provider: packet.job?.provider,
    token_budget_input: packet.job?.token_budget_input,
    token_budget_output: packet.job?.token_budget_output,
    context_budget_chars: packet.job?.context_budget_chars,
    max_attempts: packet.job?.max_attempts,
    payload_json: payload,
    skills: packet.job?.skills,
  });
  if (packet.job?.model_name != null) {
    updateJobProvider(job.id, job.provider, String(packet.job.model_name).slice(0, 300));
  }
  if (packet.job?.context_text) {
    getDb().prepare("UPDATE jobs SET context_text=? WHERE id=?")
      .run(String(packet.job.context_text).slice(0, 500_000), job.id);
  }
  getDb().prepare(`
    INSERT INTO work_item_delegations (
      id, session_id, originator_instance_id, origin_work_item_id, origin_job_id,
      executor_instance_id, local_work_item_id, local_job_id, offer_key,
      packet_oid, claim_oid, job_type, provider, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported')
  `).run(
    offerKey, packet.session_id, packet.originator_instance_id,
    packet.origin_work_item_id, packet.origin_job_id, executorInstanceId,
    wi.id, job.id, offerKey, null, claimOid, job.job_type, job.provider || null,
  );
  return getDb().prepare("SELECT * FROM work_item_delegations WHERE offer_key = ?").get(offerKey);
}

export async function reconcileSessionDelegationCommits(projectDir = process.cwd(), {
  instanceId = ensureBridgeInstanceId(projectDir),
  execGit = adminGitExecAsync,
  casPush = casPushSharedTrunkClaimNative,
} = {}) {
  const state = getLivePairingState();
  const rows = getDb().prepare(`
    SELECT * FROM work_item_delegations
    WHERE originator_instance_id=? AND state IN ('offered','claimed','running')
    ORDER BY created_at
  `).all(instanceId);
  if (rows.length === 0) return { inspected: 0, merged: 0 };
  let output;
  try {
    output = await execGit(["log", "-n", "512", "--format=%H%x1f%B%x1e", "HEAD"], projectDir, {
      timeoutMs: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      trim: false,
    });
  } catch {
    return { inspected: rows.length, merged: 0, unavailable: true };
  }
  const messages = String(output || "").split("\x1e").map((entry) => entry.slice(entry.indexOf("\x1f") + 1));
  let merged = 0;
  for (const row of rows) {
    const trailer = `Posse-Origin-Work-Item: ${instanceId}:${row.origin_work_item_id}`;
    if (!messages.some((message) => message.split(/\r?\n/u).includes(trailer))) continue;
    if (!updateJobStatus(row.origin_job_id, "succeeded", { expectedStatuses: ["blocked"] })) continue;
    getDb().prepare(`
      UPDATE work_item_delegations
      SET state='merged', completed_at=COALESCE(completed_at, ?), updated_at=?
      WHERE offer_key=?
    `).run(now(), now(), row.offer_key);
    refreshWorkItemStatus(row.origin_work_item_id);
    logEvent({
      work_item_id: row.origin_work_item_id,
      job_id: row.origin_job_id,
      event_type: EVENT_TYPES.SESSION_JOB_MERGED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: `Delegated work item reconciled from shared-trunk evidence`,
      event_json: JSON.stringify({ offer_key: row.offer_key, trailer }),
    });
    if (state?.phase === "active" && state.remote_name) {
      try {
        await casRef({
          projectDir, remote: state.remote_name, namespace: "jobs", key: row.offer_key,
          expectedOldOid: row.claim_oid, payload: null, casPush,
        });
        await casRef({
          projectDir, remote: state.remote_name, namespace: "handoff", key: row.offer_key,
          expectedOldOid: row.packet_oid, payload: null, casPush,
        });
      } catch { /* merged evidence is durable; stale refs are harmless and bounded by maintenance */ }
    }
    merged += 1;
  }
  return { inspected: rows.length, merged };
}
