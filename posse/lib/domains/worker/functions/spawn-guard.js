// lib/worker/spawn-guard.js
//
// Enforces role-declared spawn pools for role-driven job creation.

import { createJob } from "../../queue/functions/index.js";
import { SpawnPolicy } from "../../../shared/policies/classes/SpawnPolicy.js";

function roleLabel(role) {
  if (!role) return "unknown role";
  if (typeof role.getRole === "function") {
    try { return role.getRole(); } catch { /* fall through */ }
  }
  if (typeof role.role === "string" && role.role) return role.role;
  return role.constructor?.name || "unknown role";
}

function assertValidOutcome(outcome) {
  if (outcome !== "succeeded" && outcome !== "failed") {
    throw new Error(`spawn guard outcome must be "succeeded" or "failed", got ${outcome}`);
  }
}

export function canSpawnFromRole(role, outcome, jobType) {
  assertValidOutcome(outcome);
  if (role && typeof role.canSpawn === "function") {
    return role.canSpawn(jobType, outcome);
  }
  const policy = SpawnPolicy.for(roleLabel(role));
  if (policy.canSpawn(jobType, outcome)) return true;
  const pool = outcome === "succeeded" ? role?.spawnsOnSuccess : role?.spawnsOnFailure;
  return Array.isArray(pool) && pool.includes(jobType);
}

export function assertCanSpawnFromRole(role, outcome, jobType) {
  if (!jobType) throw new Error("spawn guard requires jobType");
  if (!canSpawnFromRole(role, outcome, jobType)) {
    throw new Error(`${roleLabel(role)} cannot spawn ${jobType} after ${outcome}`);
  }
}

export function spawnFromRole(role, outcome, jobType, payload, createJobFn = createJob) {
  assertCanSpawnFromRole(role, outcome, jobType);
  const jobPayload = { ...(payload || {}) };
  if (jobPayload.job_type && jobPayload.job_type !== jobType) {
    throw new Error(`spawn guard job_type mismatch: expected ${jobType}, got ${jobPayload.job_type}`);
  }
  return createJobFn({
    ...jobPayload,
    job_type: jobType,
  });
}
