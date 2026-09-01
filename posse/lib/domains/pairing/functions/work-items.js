import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { getBridgeLabel } from "../../bridge/functions/auth.js";
import { listJobs, listWorkItems } from "../../queue/functions/index.js";

export const PAIRING_WORK_ITEM_LIMIT = 50;
export const PAIRING_JOB_LIMIT = 100;

const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);

function boundedText(value, maxLength) {
  return String(value ?? "")
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
    .filter((job) => !TERMINAL_JOB_STATUS_SET.has(job.status))
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
