// Authoritative cross-instance job delegation through the session Git remote.
// Rendezvous presence carries only capability names. Work packets and the
// one-winner claim live in separate Git ref namespaces and never touch the
// advisory path-claim mirror.

import crypto from "node:crypto";

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { SESSION_COMPUTE_OWNERS, SESSION_COMPUTE_POLICIES, SESSION_JOB_HOLD_REASONS, SESSION_JOB_PROTOCOL, SESSION_PACKET_PROTOCOL, SESSION_JOB_OFFER_TTL_MS, SESSION_JOB_CLAIM_TTL_MS, SESSION_ROUTABLE_JOB_TYPES, defaultSessionComputeOwner } from "../../../catalog/session-sync.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { adminGitExecAsync } from "../../git/functions/admin-git.js";
import { casPushSharedTrunkClaimNative } from "../../git/functions/shared-trunk-native.js";
import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { getSetting } from "../../settings/functions/repository-settings.js";
import { getLivePairingState, sessionInstanceId } from "../../pairing/functions/state.js";
import { leasedToSessionHost, normalizeComputeOwner, offersSessionWorkTo, ownComputeOwner } from "../../pairing/functions/compute-lease.js";
import { readPairingPeerSnapshot } from "../../pairing/functions/work-items.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { completionBlockersForWorkItem, createJob, createWorkItem, getWorkItem, logEvent, refreshWorkItemStatus, setMergeState, updateJobProvider, updateJobStatus, updateWorkItemStatus } from "./queue-store.js";
import { now, runImmediateTransaction } from "./common.js";
import { logDurableEvent } from "./events.js";
import { PIPELINE_BOOTSTRAP_JOB_TYPES } from "./work-item-execution-contract.js";

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

/**
 * The peers that may claim this job, in preference order; empty runs it here.
 * Only peers whose own lease lets them claim from this clone are listed
 * (compute-lease.js offersSessionWorkTo), so an offer is never parked on peers
 * that will all refuse it: the host offers to nobody and a host-leased member
 * is never a balancing target. The lease the host issued this clone then
 * decides: a host lease sends every routable job to the host alone. Otherwise
 * the clone pays its own way and only offers work it cannot run, and only
 * when the host has turned on capability routing for the session.
 */
export function sessionJobExecutors(state, job, peers, { localCanRun = localProviderCanRun(job) } = {}) {
  if (!state || state.phase !== "active" || !ROUTABLE_JOB_TYPES.has(job?.job_type)) return [];
  // Work this clone imported runs here. Offering it again would bill a third
  // party under this clone's lease and strand the originator's reconciliation.
  if (parseJson(job.payload_json).session_delegation) return [];
  if (!Array.isArray(peers) || peers.length === 0) return [];
  const eligible = peers.filter((peer) => peerCanExecuteSessionJob(peer, job) && offersSessionWorkTo(state, peer));
  if (eligible.length === 0) return [];
  // On a host lease only the host accepts, so `eligible` holds the host alone.
  if (ownComputeOwner(state) === SESSION_COMPUTE_OWNERS.HOST) return eligible.slice(0, 1);
  if (state.compute_policy !== SESSION_COMPUTE_POLICIES.CAPABILITY_ROUTING || localCanRun) return [];
  return eligible;
}

export function shouldOfferSessionJob(state, job, peers, options = {}) {
  return sessionJobExecutors(state, job, peers, options)[0] || null;
}

/**
 * The host runs work on its own bill for members whose lease names it, so it
 * caps each such originator to `limit` active jobs. Work accepted through
 * capability routing is not on a host lease and is not capped here.
 */
export function sessionOriginatorConcurrencyBlocked(state, job, activeJobs, limit = 1) {
  if (state?.role !== "host") return false;
  const row = getDb().prepare(`
    SELECT originator_instance_id, compute_owner FROM work_item_delegations WHERE local_job_id = ?
  `).get(job?.id);
  if (!row?.originator_instance_id) return false;
  const owner = row.compute_owner || defaultSessionComputeOwner(state.compute_policy);
  if (owner !== SESSION_COMPUTE_OWNERS.HOST) return false;
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

/**
 * A member whose lease names the session host never runs routable work itself:
 * the host runs it on the host's machine and provider account, and when the
 * host is unavailable the job waits. Only an active session carries a lease,
 * and a job that was itself delegated to this clone is the executor's, not
 * the originator's.
 *
 * @param {any} state the live pairing state
 * @param {any} job
 */
export function sessionMustWaitForHost(state, job) {
  return leasedToSessionHost(state)
    && ROUTABLE_JOB_TYPES.has(job?.job_type)
    && !parseJson(job?.payload_json).session_delegation;
}

/**
 * The session host when it is in the session, advertises that it runs this
 * job type, and lists the providers it runs without this job's provider: it
 * will never take the job. An absent host, one with no advert yet, or one out
 * of headroom may still take it, so those return null.
 */
function presentHostLackingProvider(peers, job) {
  if (!job?.provider) return null;
  const host = (Array.isArray(peers) ? peers : []).find((peer) => peer?.role === "host");
  const capabilities = host?.capabilities || {};
  if (!Array.isArray(capabilities.job_types) || !capabilities.job_types.includes(job.job_type)) return null;
  if (!Array.isArray(capabilities.providers) || capabilities.providers.includes(job.provider)) return null;
  return host;
}

/**
 * A provider that can stand in for the one the present host lacks: any the
 * host advertises with headroom (preferring one in this job's role pool on
 * this clone), meeting the job's hard needs (an image job needs an
 * image-capable chat provider). The host re-resolves against its own pool. A provider the
 * planner pinned is substituted too: no job field marks a pin as required,
 * and the one hard capability provider selection checks, image generation,
 * is required of the substitute. Null when none fits.
 */
async function hostSubstituteProvider(host, job) {
  // Provider policy imports the queue, so it loads on first use (as
  // commit-message-policy.js does); a module-level import deadlocks the cycle.
  const [
    { delegationRoleForJobType, selectFallbackProvider },
    { needsImageGeneration, shouldPreservePinnedProvider },
    { getAvailableProviders },
  ] = await Promise.all([
    import("../../providers/functions/delegation-routing.js"),
    import("../../providers/functions/execution-routing.js"),
    import("../../providers/functions/provider.js"),
  ]);
  const role = delegationRoleForJobType(job.job_type);
  const pool = getAvailableProviders(role);
  const needsImages = role === "artificer" && needsImageGeneration(parseJson(job.payload_json));
  // The host runs the job on its own machine and account, so what this
  // clone's pool allows does not limit the choice (Mason, 2026-11-19): any
  // provider the host advertises with headroom will do. One this clone also
  // runs for the role is preferred, as the closest to what was planned.
  const advertised = (host?.capabilities?.providers || []).filter((name) => peerHeadroomAllows(host, name));
  const candidates = [...pool.filter((name) => advertised.includes(name)), ...advertised.filter((name) => !pool.includes(name))];
  const provider = selectFallbackProvider(candidates, job.provider, needsImages);
  return provider
    ? { provider, role, pool, inPool: pool.includes(provider), pinned: shouldPreservePinnedProvider(job, role, pool) }
    : null;
}

/**
 * Move a held job onto its substitute provider and say so once; returns the
 * job as it now stands. The host runs work within its own pool for the job's
 * role, and its advert lists only the providers it runs for any role (the
 * Remote keeps job_types, providers, tier and headroom), so this clone cannot
 * know whether the substitute is in that pool: the host selects the provider.
 */
function substituteHostProvider(job, host, substitute) {
  const from = job.provider;
  const to = substitute.provider;
  updateJobProvider(job.id, to, null);
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_PROVIDER_REROUTED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    message: `Job #${job.id} needs ${from}, which the session host does not run; offered to the host on ${to}, `
      + (substitute.inPool
        ? `which the host advertises and this clone's ${substitute.role} providers allow`
        : `which the host advertises (the host runs the job, so this clone's ${substitute.role} providers do not limit it)`)
      + (substitute.pinned ? ` (in place of the ${from} the job was assigned; it needs no capability only ${from} has)` : "")
      + `. The host runs it on its own ${substitute.role} provider if ${to} is not in that pool.`,
    event_json: JSON.stringify({
      reason: SESSION_JOB_HOLD_REASONS.HOST_LACKS_PROVIDER,
      from,
      to,
      provider_pool: substitute.pool,
      host_instance_id: host.instance_id || null,
      pinned: substitute.pinned,
      host_selects_provider: true,
    }),
  });
  return { ...job, provider: to, model_name: null };
}

/** Why a host-leased job cannot start while the host lacks its provider, and the two ways out. */
export function sessionHostLacksProviderText(job, provider = job?.provider) {
  return `Job #${job?.id} needs provider ${provider}, which the session host does not run, `
    + "and this clone's lease sends its work to the host, so it never runs here. "
    + "The host can run `posse session lease <member-id> member` to let this clone run its own work, "
    + `or configure ${provider} on the host.`;
}

export async function offerSessionJob(job, {
  projectDir = process.cwd(),
  state = getLivePairingState(),
  snapshot = readPairingPeerSnapshot(),
  instanceId = sessionInstanceId(projectDir, state),
  casPush = casPushSharedTrunkClaimNative,
  localCanRun = localProviderCanRun(job),
} = {}) {
  const peers = (snapshot?.peers || []).filter((peer) => peer.instance_id !== instanceId);
  let executors = sessionJobExecutors(state, job, peers, { localCanRun });
  // A present host without the job's provider runs it on a viable substitute.
  if (executors.length === 0 && sessionMustWaitForHost(state, job)) {
    const host = presentHostLackingProvider(peers, job);
    const substitute = host ? await hostSubstituteProvider(host, job) : null;
    if (substitute) {
      job = substituteHostProvider(job, host, substitute);
      executors = sessionJobExecutors(state, job, peers, { localCanRun });
    }
  }
  const target = executors[0];
  if (!target) {
    // A host lease whose host cannot take this job right now does NOT run it
    // here: the caller holds the job until the host can (see
    // sessionMustWaitForHost). Say so to the caller, and say when the host is
    // here but does not run the job's provider, which waiting cannot fix.
    if (!sessionMustWaitForHost(state, job)) return { delegated: false, reason: "local_execution" };
    const host = presentHostLackingProvider(peers, job);
    return host
      ? { delegated: false, reason: SESSION_JOB_HOLD_REASONS.HOST_LACKS_PROVIDER, provider: job.provider, hostInstanceId: host.instance_id }
      : { delegated: false, reason: SESSION_JOB_HOLD_REASONS.HOST_UNAVAILABLE };
  }
  const workItem = getWorkItem(job.work_item_id);
  if (!workItem) return { delegated: false, reason: "missing_work_item" };
  // Only the executors this clone's lease allows may claim: a host lease
  // never lets another member pick up (and pay for) the work.
  const eligible = executors.map((peer) => peer.instance_id);
  const computeOwner = ownComputeOwner(state);
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
          offer_key, packet_oid, claim_oid, job_type, provider, compute_owner, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered')
        ON CONFLICT(offer_key) DO UPDATE SET
          packet_oid=excluded.packet_oid, claim_oid=excluded.claim_oid,
          compute_owner=excluded.compute_owner,
          state='offered', created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(key, state.remote_session_id, instanceId, workItem.id, job.id, key, packetOid, claimOid,
        job.job_type, job.provider || null, computeOwner);
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
      event_json: JSON.stringify({ offer_key: key, eligible_instance_ids: eligible, compute_owner: computeOwner }),
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

// A fetched view this long may be truncated: absence from it proves nothing.
export const SESSION_REF_FETCH_LIMIT = 256;

export async function fetchNamespace(projectDir, remote, namespace, execGit = adminGitExecAsync) {
  const prefix = `refs/posse/${namespace}/`;
  await execGit([
    "fetch", "--atomic", "--prune", "--no-tags", remote, `+${prefix}*:${prefix}*`,
  ], projectDir, { timeoutMs: 30_000 });
  const rows = await execGit([
    "for-each-ref", "--format=%(objectname) %(refname)", `${prefix}*`,
  ], projectDir, { timeoutMs: 10_000 });
  const result = [];
  for (const line of String(rows || "").split("\n").filter(Boolean).slice(0, SESSION_REF_FETCH_LIMIT)) {
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

export function importPacket(packet, executorInstanceId, offerKey, claimOid, { computeOwner = null } = {}) {
  // One transaction: a failure part-way must not leave a work item or job
  // without the delegation row that ties it to the claim.
  return runImmediateTransaction(getDb(), () => importPacketRows(packet, executorInstanceId, offerKey, claimOid, { computeOwner }));
}

function importPacketRows(packet, executorInstanceId, offerKey, claimOid, { computeOwner = null } = {}) {
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
      packet_oid, claim_oid, job_type, provider, compute_owner, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported')
  `).run(
    offerKey, packet.session_id, packet.originator_instance_id,
    packet.origin_work_item_id, packet.origin_job_id, executorInstanceId,
    wi.id, job.id, offerKey, null, claimOid, job.job_type, job.provider || null,
    normalizeComputeOwner(computeOwner),
  );
  return getDb().prepare("SELECT * FROM work_item_delegations WHERE offer_key = ?").get(offerKey);
}

export async function reconcileSessionDelegationCommits(projectDir = process.cwd(), {
  execGit = adminGitExecAsync,
  casPush = casPushSharedTrunkClaimNative,
} = {}) {
  const state = getLivePairingState();
  // The delegations this clone originated (an executor's import always has a
  // local job), each matched under the identity it was offered with: once its
  // session has ended, a phone pairing may have replaced the bridge identity.
  const rows = getDb().prepare(`
    SELECT * FROM work_item_delegations
    WHERE local_job_id IS NULL AND state IN ('offered','claimed','running')
    ORDER BY created_at
  `).all();
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
  const commits = String(output || "").split("\x1e").map((entry) => {
    const separator = entry.indexOf("\x1f");
    return { hash: separator >= 0 ? entry.slice(0, separator).trim() || null : null, message: entry.slice(separator + 1) };
  });
  const terminal = new Set(TERMINAL_JOB_STATUSES);
  let merged = 0;
  for (const row of rows) {
    const trailer = `Posse-Origin-Work-Item: ${row.originator_instance_id}:${row.origin_work_item_id}`;
    const commit = commits.find(({ message }) => message.split(/\r?\n/u).includes(trailer));
    if (!commit) continue;
    // One transaction: the work item is never refreshed with the job settled
    // but without the merge evidence that job's delegation carries.
    const settled = runImmediateTransaction(getDb(), () => {
      if (!updateJobStatus(row.origin_job_id, "succeeded", { expectedStatuses: ["blocked"] })) return false;
      getDb().prepare(`
        UPDATE work_item_delegations
        SET state='merged', completed_at=COALESCE(completed_at, ?), updated_at=?
        WHERE offer_key=?
      `).run(now(), now(), row.offer_key);
      // A delegated plan or research job handed the executor this work item's
      // whole pipeline, and the trailer proves that work is on trunk: the
      // executor's merge is this work item's merge. Local work still to run
      // keeps the work item's own merge, as does a delegated dev job, which is
      // one step of a pipeline whose other steps may be on a local branch.
      if (PIPELINE_BOOTSTRAP_JOB_TYPES.has(row.job_type)
        && !completionBlockersForWorkItem(row.origin_work_item_id).some((job) => !terminal.has(job.status))) {
        const alreadyMerged = getWorkItem(row.origin_work_item_id)?.merge_state === "merged";
        setMergeState(row.origin_work_item_id, "merged");
        // The merge record every other merge path writes (merge evidence,
        // the work item's outcome and the run monitor read it), once.
        if (!alreadyMerged) logDurableEvent({
          work_item_id: row.origin_work_item_id,
          job_id: row.origin_job_id,
          event_type: EVENT_TYPES.WORK_ITEM_MERGED,
          actor_type: EVENT_ACTORS.SCHEDULER,
          message: `Merged on trunk by session executor ${row.executor_instance_id || "(unknown)"} at ${commit.hash || "(unknown)"}`,
          event_json: JSON.stringify({
            merge_hash: commit.hash,
            offer_key: row.offer_key,
            executor_instance_id: row.executor_instance_id || null,
            trailer,
          }),
        });
      }
      refreshWorkItemStatus(row.origin_work_item_id);
      return true;
    });
    if (!settled) continue;
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
