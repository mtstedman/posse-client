import {
  normalizeSpawnRoleName,
  spawnPolicyForRoleName,
} from "../functions/spawn-policy.js";

export class SpawnPolicy {
  static for(roleName) {
    const normalized = normalizeSpawnRoleName(roleName);
    const policy = spawnPolicyForRoleName(normalized);
    return new SpawnPolicy({
      role: normalized || "unknown",
      succeeds: policy.succeeds,
      fails: policy.fails,
    });
  }

  constructor({
    role = "unknown",
    succeeds = [],
    fails = [],
  } = {}) {
    this.role = role || "unknown";
    this.succeeds = Object.freeze([...new Set((Array.isArray(succeeds) ? succeeds : []).filter(Boolean))]);
    this.fails = Object.freeze([...new Set((Array.isArray(fails) ? fails : []).filter(Boolean))]);
    Object.freeze(this);
  }

  canSpawn(jobType, outcome = "succeeded") {
    const type = String(jobType || "").trim();
    if (!type) return false;
    if (outcome === "succeeded") return this.succeeds.includes(type);
    if (outcome === "failed") return this.fails.includes(type);
    return false;
  }

  describe() {
    return `${this.role}: success -> [${this.succeeds.join(", ")}], fail -> [${this.fails.join(", ")}]`;
  }
}
