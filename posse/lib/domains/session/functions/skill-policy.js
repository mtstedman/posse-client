import {
  getDisabledSkillIdSet,
  getSkillById,
  isSkillsEnabled,
} from "../../../shared/skills/functions/registry.js";
import {
  parsePayloadJson,
  parseSkillIds,
} from "./keys.js";

export function skillIdsForSessionPolicy(job) {
  const payload = parsePayloadJson(job?.payload_json);
  return parseSkillIds(job?.skills || payload.skills);
}

export function skillRecyclePolicyForJob(job, opts = {}) {
  const skillIds = skillIdsForSessionPolicy(job);
  if (skillIds.length === 0) {
    return { ok: true, reason: "no_skills", skillIds };
  }

  const skillsEnabled = opts.skillsEnabled ?? isSkillsEnabled();
  if (!skillsEnabled) {
    return { ok: false, reason: "skills_disabled", skillIds, deniedSkills: skillIds };
  }

  const disabled = opts.disabledIds instanceof Set ? opts.disabledIds : getDisabledSkillIdSet();
  const missingSkills = [];
  const deniedSkills = [];

  for (const skillId of skillIds) {
    const manifest = getSkillById(skillId, opts);
    if (!manifest) {
      missingSkills.push(skillId);
      continue;
    }
    if (disabled.has(skillId) || manifest.recycle_session !== true) {
      deniedSkills.push(skillId);
    }
  }

  if (missingSkills.length > 0) {
    return { ok: false, reason: "skill_missing", skillIds, missingSkills, deniedSkills };
  }
  if (deniedSkills.length > 0) {
    return { ok: false, reason: "skill_recycle_disabled", skillIds, deniedSkills };
  }

  return { ok: true, reason: "skills_recycle_allowed", skillIds };
}
