// Session recycling key helpers.
//
// These functions are intentionally pure so the queue/session layer can depend
// on canonical lane and skill keys without importing provider or skill modules.

import { providerRoleForJobType } from "../../providers/functions/roles.js";
import { slugify } from "../../../shared/format/functions/slug.js";
import { parseJsonObject } from "../../queue/functions/payload.js";
export { providerRoleForJobType };

const RECYCLABLE_LANES = new Set(["dev", "planner"]);

function normalizeId(value) {
  return slugify(value, { alphabet: "id", fallback: "" });
}

export function sessionLaneForJob(jobOrType = "dev") {
  const jobType = typeof jobOrType === "string"
    ? jobOrType
    : (jobOrType?.job_type || jobOrType?.role || "dev");
  return providerRoleForJobType(jobType);
}

export function isRecyclableLane(lane) {
  return RECYCLABLE_LANES.has(String(lane || "").trim().toLowerCase());
}

export function parseSkillIds(value) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) raw = [];
    else if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        raw = Array.isArray(parsed) ? parsed : [];
      } catch {
        raw = trimmed.split(",");
      }
    } else {
      raw = trimmed.split(",");
    }
  }

  return [...new Set(raw.map(normalizeId).filter(Boolean))].sort();
}

export function canonicalSkillKey(value) {
  const ids = parseSkillIds(value);
  return ids.length > 0 ? JSON.stringify(ids) : "";
}

export function parsePayloadJson(value) {
  return parseJsonObject(value);
}

export function deriveSessionKey(job, { provider = null, role = null, lane = null, skillKey = null } = {}) {
  const payload = parsePayloadJson(job?.payload_json);
  const resolvedLane = String(lane || providerRoleForJobType(role || job?.job_type || "dev")).trim().toLowerCase();
  return {
    workItemId: Number(job?.work_item_id),
    lane: resolvedLane,
    provider: String(provider || job?.provider || "").trim().toLowerCase(),
    skillKey: skillKey == null
      ? canonicalSkillKey(job?.skills || payload.skills)
      : String(skillKey || ""),
  };
}
