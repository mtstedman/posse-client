import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import { BACKGROUND_JOB_TYPES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { stripAnsi } from "../../../shared/format/functions/ansi.js";
import { getBridgeLabel } from "../../bridge/functions/auth.js";
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
  return {
    label: boundedText(getBridgeLabel(projectDir), 160),
    work_items: collectPairingWorkItems(),
    jobs: collectPairingJobs(),
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
  };
}

export function writePairingPeerSnapshot(status, { at = new Date().toISOString() } = {}) {
  const snapshot = {
    protocol: PAIRING_PEER_SNAPSHOT_PROTOCOL,
    session_id: boundedText(status?.session_id, 160),
    at: boundedText(at, 40),
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
