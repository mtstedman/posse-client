import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import { BACKGROUND_JOB_TYPES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { stripAnsi } from "../../../shared/format/functions/ansi.js";
import { getBridgeLabel } from "../../bridge/functions/auth.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { adminGitExec } from "../../git/functions/admin-git.js";
import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { getSetting } from "../../settings/functions/repository-settings.js";
import { getLivePairingState } from "./state.js";
import { listJobs, listWorkItems } from "../../queue/functions/index.js";
import {
  clearRuntimeStatus,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";

export const PAIRING_WORK_ITEM_LIMIT = 50;
export const PAIRING_JOB_LIMIT = 100;
export const PAIRING_PEER_SNAPSHOT_MAX_AGE_MS = 20_000;
const PAIRING_PEER_SNAPSHOT_PROTOCOL = "posse.pairing_peers.v1";

const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const SESSION_JOB_TYPES = Object.freeze([
  "research", "plan", "delegate", "dev", "assess", "fix", "summarize", "artificer",
]);

function configuredSessionProviders() {
  const providers = new Set();
  for (const role of PROVIDER_ROLE_NAMES) {
    const configured = String(getSetting(`provider_${role}`) || "claude");
    for (const provider of configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
      providers.add(provider);
    }
  }
  return [...providers].slice(0, 32);
}

function providerHeadroom(provider) {
  try {
    const state = JSON.parse(String(getSetting(`${provider}_rate_limit_state`) || "{}"));
    const untilMs = Number(state?.untilMs);
    if (Number.isFinite(untilMs) && untilMs > Date.now()) {
      return { provider, available: false, retry_after_sec: Math.min(86_400, Math.ceil((untilMs - Date.now()) / 1000)) };
    }
  } catch { /* missing/malformed telemetry means no known throttle */ }
  return { provider, available: true, retry_after_sec: 0 };
}

function boundedText(value, maxLength) {
  return stripAnsi(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function collectPairingWorkItems({ limit = PAIRING_WORK_ITEM_LIMIT } = {}) {
  const capped = Math.max(1, Math.min(PAIRING_WORK_ITEM_LIMIT, Number(limit) || PAIRING_WORK_ITEM_LIMIT));
  return listWorkItems()
    .filter((workItem) => !TERMINAL_WORK_ITEM_STATUS_SET.has(workItem.status))
    .slice(-capped)
    .map((workItem) => ({
      id: Number(workItem.id),
      title: boundedText(workItem.title, 240),
      status: boundedText(workItem.status, 40),
      priority: boundedText(workItem.priority || "normal", 20),
    }));
}

export function collectPairingJobs({ limit = PAIRING_JOB_LIMIT } = {}) {
  const capped = Math.max(1, Math.min(PAIRING_JOB_LIMIT, Number(limit) || PAIRING_JOB_LIMIT));
  return listJobs()
    .filter((job) => (
      !TERMINAL_JOB_STATUS_SET.has(job.status)
      && !BACKGROUND_JOB_TYPES.has(job.job_type)
    ))
    .slice(-capped)
    .map((job) => ({
      id: Number(job.id),
      work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
      title: boundedText(job.title, 240),
      status: boundedText(job.status, 40),
      job_type: boundedText(job.job_type, 40),
    }));
}

export function collectPairingPresence(projectDir = process.cwd()) {
  let gitIdentities = [];
  try {
    const email = adminGitExec(["config", "--get", "user.email"], projectDir, { timeoutMs: 5_000 }).trim();
    if (email) gitIdentities = [email];
  } catch { /* a missing identity remains an empty advert */ }
  let capabilities = { job_types: [], providers: [], tier: "standard", headroom: [] };
  try {
    const providers = configuredSessionProviders();
    capabilities = {
      job_types: [...SESSION_JOB_TYPES],
      providers,
      tier: "standard",
      headroom: providers.map(providerHeadroom),
    };
  } catch { /* capability absence is explicit and routes work locally */ }
  return {
    label: boundedText(getBridgeLabel(projectDir), 160),
    work_items: collectPairingWorkItems(),
    jobs: collectPairingJobs(),
    git_identities: gitIdentities,
    capabilities,
  };
}

function boundedPeer(peer) {
  const workItems = (Array.isArray(peer?.work_items) ? peer.work_items : [])
    .slice(0, PAIRING_WORK_ITEM_LIMIT)
    .map((workItem) => ({
      id: Number(workItem.id),
      title: boundedText(workItem.title, 240),
      status: boundedText(workItem.status, 40),
      priority: boundedText(workItem.priority || "normal", 20),
    }))
    .filter((workItem) => Number.isSafeInteger(workItem.id) && workItem.id > 0);
  const jobs = (Array.isArray(peer?.jobs) ? peer.jobs : [])
    .filter((job) => !BACKGROUND_JOB_TYPES.has(job?.job_type))
    .slice(0, PAIRING_JOB_LIMIT)
    .map((job) => ({
      id: Number(job.id),
      work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
      title: boundedText(job.title, 240),
      status: boundedText(job.status, 40),
      job_type: boundedText(job.job_type, 40),
    }))
    .filter((job) => Number.isSafeInteger(job.id) && job.id > 0);
  return {
    instance_id: boundedText(peer?.instance_id, 160),
    label: boundedText(peer?.label, 160) || "paired user",
    role: boundedText(peer?.role, 20),
    updated_at: boundedText(peer?.updated_at, 40),
    work_items: workItems,
    jobs,
    git_identities: (Array.isArray(peer?.git_identities) ? peer.git_identities : [])
      .slice(0, 16)
      .map((value) => boundedText(value, 320))
      .filter(Boolean),
    capabilities: peer?.capabilities && typeof peer.capabilities === "object"
      ? peer.capabilities
      : {},
  };
}

export function writePairingPeerSnapshot(status, { at = new Date().toISOString() } = {}) {
  const snapshot = {
    protocol: PAIRING_PEER_SNAPSHOT_PROTOCOL,
    session_id: boundedText(status?.session_id, 160),
    at: boundedText(at, 40),
    status: boundedText(status?.status, 40),
    enrollment_open: status?.enrollment_open === true,
    compute_policy: boundedText(status?.compute_policy, 40),
    integration_policy: boundedText(status?.integration_policy, 40),
    members: (Array.isArray(status?.members) ? status.members : [])
      .slice(0, 100)
      .map((member) => ({
        id: boundedText(member?.id, 160),
        instance_id: boundedText(member?.instance_id, 160),
        state: boundedText(member?.state, 40),
        role: boundedText(member?.role, 40),
      }))
      .filter((member) => member.id && member.instance_id),
    peers: (Array.isArray(status?.peers) ? status.peers : [])
      .slice(0, 50)
      .map(boundedPeer)
      .filter((peer) => peer.instance_id),
  };
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PEERS, snapshot);
  return snapshot;
}

export function readPairingPeerSnapshot({
  nowMs = Date.now(),
  maxAgeMs = PAIRING_PEER_SNAPSHOT_MAX_AGE_MS,
} = {}) {
  const snapshot = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PEERS);
  if (snapshot?.protocol !== PAIRING_PEER_SNAPSHOT_PROTOCOL || !Array.isArray(snapshot.peers)) return null;
  const writtenAt = Date.parse(snapshot.at || "");
  if (!Number.isFinite(writtenAt) || nowMs - writtenAt > maxAgeMs || writtenAt - nowMs > 5_000) return null;
  return snapshot;
}

export function clearPairingPeerSnapshot() {
  return clearRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PEERS);
}

export function pairingSessionSummary(snapshot = readPairingPeerSnapshot()) {
  const state = getLivePairingState();
  if (!state) return null;
  const members = Array.isArray(snapshot?.members) ? snapshot.members : [];
  const trunk = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK) || {};
  let delegations = [];
  try {
    delegations = getDb().prepare(`
      SELECT offer_key, originator_instance_id, executor_instance_id,
             origin_work_item_id, local_work_item_id, job_type, state, updated_at
      FROM work_item_delegations
      WHERE state NOT IN ('merged','failed','recalled')
      ORDER BY updated_at DESC
      LIMIT 50
    `).all().map((row) => ({
      offer_key: boundedText(row.offer_key, 64),
      originator_instance_id: boundedText(row.originator_instance_id, 160),
      executor_instance_id: boundedText(row.executor_instance_id, 160),
      origin_work_item_id: Number(row.origin_work_item_id),
      local_work_item_id: row.local_work_item_id == null ? null : Number(row.local_work_item_id),
      job_type: boundedText(row.job_type, 40),
      state: boundedText(row.state, 40),
      updated_at: boundedText(row.updated_at, 40),
    }));
  } catch { /* session summaries remain available before the delegation migration */ }
  return {
    session_id: state.remote_session_id,
    role: state.role,
    phase: snapshot?.status || state.phase,
    branch: state.shared_branch,
    enrollment_open: snapshot?.enrollment_open ?? Boolean(state.enrollment_open),
    compute_policy: snapshot?.compute_policy || state.compute_policy,
    integration_policy: snapshot?.integration_policy || state.integration_policy,
    roster: members,
    pending_count: members.filter((member) => member.state === "pending").length,
    peer_count: snapshot?.peers?.length || 0,
    delegations,
    trunk_health: {
      status: trunk.provenance_blocked === true
        ? "provenance-review"
        : trunk.diverged === true
          ? "diverged"
          : trunk.publication_unresolved === true
            ? "publication-blocked"
            : trunk.last_success_at
              ? "healthy"
              : "pending",
      ahead_count: Math.max(0, Number(trunk.ahead_count) || 0),
      behind_count: Math.max(0, Number(trunk.behind_count) || 0),
      last_success_at: boundedText(trunk.last_success_at, 40) || null,
      provenance_gate_job_id: Number.isSafeInteger(Number(trunk.provenance_gate_job_id))
        ? Number(trunk.provenance_gate_job_id)
        : null,
    },
  };
}

export function pairingPeerPipelineRows(snapshot = readPairingPeerSnapshot()) {
  if (!snapshot) return [];
  return snapshot.peers.flatMap((peer) => {
    const jobsByWorkItem = new Map();
    for (const job of peer.jobs) {
      if (!Number.isSafeInteger(job.work_item_id) || job.work_item_id <= 0) continue;
      const jobs = jobsByWorkItem.get(job.work_item_id) || [];
      jobs.push({ ...job, handoff: [], peer_read_only: true });
      jobsByWorkItem.set(job.work_item_id, jobs);
    }
    return peer.work_items.map((workItem) => ({
      id: `peer:${peer.instance_id}:${workItem.id}`,
      peer_work_item_id: workItem.id,
      title: workItem.title,
      status: workItem.status,
      priority: workItem.priority,
      jobs: jobsByWorkItem.get(workItem.id) || [],
      peer_read_only: true,
      peer_instance_id: peer.instance_id,
      peer_label: peer.label,
    }));
  });
}

function activityKey(peer, entityType, entity) {
  return `${peer.instance_id}:${entityType}:${entity.id}`;
}

function activitySignature(peer, entityType, entity) {
  return JSON.stringify([
    peer.label,
    peer.role,
    entityType,
    entity.title,
    entity.status,
    entity.priority ?? null,
    entity.job_type ?? null,
    entity.work_item_id ?? null,
  ]);
}

// Peer activity is an ephemeral display projection only. It is intentionally
// compared in memory and never written into this clone's work_items/jobs.
export function diffPairingPeerActivity(peers = [], seen = new Map()) {
  const next = new Map();
  const changes = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    for (const [entityType, entities] of [
      ["work_item", peer?.work_items],
      ["job", peer?.jobs],
    ]) {
      for (const entity of Array.isArray(entities) ? entities : []) {
        const key = activityKey(peer, entityType, entity);
        const signature = activitySignature(peer, entityType, entity);
        next.set(key, signature);
        if (seen.get(key) !== signature) {
          changes.push({
            kind: seen.has(key) ? "updated" : "spawned",
            entity_type: entityType,
            peer: {
              instance_id: peer.instance_id,
              label: peer.label,
              role: peer.role,
            },
            [entityType]: { ...entity },
          });
        }
      }
    }
  }
  seen.clear();
  for (const [key, signature] of next) seen.set(key, signature);
  return changes;
}
