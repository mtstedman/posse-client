import fs from 'node:fs';
import { EXPERIMENT_SKILLS, EXPERIMENT_SKILLS_SCHEMA, EXPERIMENT_SKILL_ROLES, IMAGE_TOOLS } from '../../../catalog/experiment-skills.js';
import { validateToolArguments } from '../../../shared/tools/functions/schema-validation.js';
import { ExperimentImageTools } from '../classes/ExperimentImageTools.js';

export function validateExperimentSkills(skills = {}) {
  const checked = validateToolArguments({ name: 'skills', parameters: { type: 'object', properties: { skills: EXPERIMENT_SKILLS_SCHEMA }, required: ['skills'], additionalProperties: false } }, { skills });
  if (!checked.ok) throw Error(`Invalid experiment skills: ${checked.message}`);
  return skills;
}
export function experimentSkillInventory(skills = {}, role = "setup") {
  validateExperimentSkills(skills);
  return EXPERIMENT_SKILLS.map(({ id, version, description }) => ({ id, version, description, attached: (skills[role] || []).includes(id), attached_roles: EXPERIMENT_SKILL_ROLES.filter(role => (skills[role] || []).includes(id)) }));
}
export function experimentSkillContext(skills = {}, role) {
  return skillIdsForRole(skills, role).map(id => {
    const skill = EXPERIMENT_SKILLS.find(skill => skill.id === id);
    return { id, version: skill.version, instructions: fs.readFileSync(new URL(`../../../../skills/${skill.skill}`, import.meta.url), 'utf8') };
  });
}
export function experimentSkillTools(skills = {}, role) {
  return skillIdsForRole(skills, role).includes('image-manipulation') ? IMAGE_TOOLS : [];
}
export function experimentSkillSession(skills, evaluation, role) {
  return skillIdsForRole(skills, role).includes('image-manipulation') ? new ExperimentImageTools(evaluation) : null;
}

function skillIdsForRole(skills = {}, role) {
  validateExperimentSkills(skills);
  if (!EXPERIMENT_SKILL_ROLES.includes(role)) return [];
  return skills[role] || [];
}
