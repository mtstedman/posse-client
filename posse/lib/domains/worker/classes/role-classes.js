import { ArtificerRole } from "./roles/artificer.js";
import { AssessorRole } from "./roles/assessor.js";
import { DelegateRole } from "./roles/delegate.js";
import { DeveloperRole } from "./roles/developer.js";
import { FixRole } from "./roles/fix.js";
import { PlannerRole } from "./roles/planner.js";
import { PreflightRole } from "./roles/preflight.js";
import { ResearcherRole } from "./roles/researcher.js";
import { AtlasWarmRole } from "./roles/atlas-warm.js";
import { SummaryRole } from "./roles/summary.js";
import { JOB_TYPES, NON_PROVIDER_JOB_TYPES } from "../../../catalog/job.js";

export const ROLE_CLASSES_BY_JOB_TYPE = Object.freeze({
  research: ResearcherRole,
  preflight: PreflightRole,
  delegate: DelegateRole,
  summarize: SummaryRole,
  dev: DeveloperRole,
  fix: FixRole,
  artificer: ArtificerRole,
  plan: PlannerRole,
  assess: AssessorRole,
  atlas_warm: AtlasWarmRole,
});

const EMPTY_ROLE_CLASSES = Object.freeze([]);

function normalizeRoleName(roleName) {
  return String(roleName || "")
    .trim()
    .toLowerCase()
    .replace(/role$/, "")
    .replace(/^.*\./, "");
}

function readOnlyRoleClassMap(map) {
  const view = {
    get(roleName) {
      return map.get(roleName);
    },
    has(roleName) {
      return map.has(roleName);
    },
    entries() {
      return map.entries();
    },
    keys() {
      return map.keys();
    },
    values() {
      return map.values();
    },
    forEach(callback, thisArg = undefined) {
      return map.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    get size() {
      return map.size;
    },
    [Symbol.iterator]() {
      return map[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
}

function buildRoleClassesByRoleName() {
  const map = new Map();
  for (const RoleClass of Object.values(ROLE_CLASSES_BY_JOB_TYPE)) {
    const roleName = normalizeRoleName(RoleClass.role);
    if (!roleName) continue;
    const existing = map.get(roleName) || [];
    existing.push(RoleClass);
    map.set(roleName, existing);
  }
  const collisions = [];
  for (const [roleName, classes] of map.entries()) {
    const frozenClasses = Object.freeze(classes.slice());
    if (frozenClasses.length > 1) {
      collisions.push(Object.freeze({
        roleName,
        classNames: Object.freeze(frozenClasses.map((RoleClass) => RoleClass.name)),
      }));
    }
    map.set(roleName, frozenClasses);
  }
  return {
    collisions: Object.freeze(collisions),
    registry: readOnlyRoleClassMap(map),
  };
}

const ROLE_CLASS_REGISTRY = buildRoleClassesByRoleName();

export const ROLE_CLASSES_BY_ROLE_NAME = ROLE_CLASS_REGISTRY.registry;
export const ROLE_CLASS_ROLE_NAME_COLLISIONS = ROLE_CLASS_REGISTRY.collisions;

export function getRoleClassForJobType(jobType) {
  return ROLE_CLASSES_BY_JOB_TYPE[jobType] || null;
}

export function missingRoleClassJobTypes({
  jobTypes = JOB_TYPES,
  nonProviderJobTypes = NON_PROVIDER_JOB_TYPES,
} = {}) {
  return Array.from(jobTypes || []).filter((jobType) => (
    !ROLE_CLASSES_BY_JOB_TYPE[jobType]
    && !nonProviderJobTypes.has(jobType)
  ));
}

export function assertRoleClassRegistryExhaustive(opts = {}) {
  const missing = missingRoleClassJobTypes(opts);
  if (missing.length > 0) {
    throw new Error(`Missing worker role class for provider job type(s): ${missing.join(", ")}`);
  }
  return true;
}

export function getRoleClassesForRoleName(roleName) {
  return ROLE_CLASSES_BY_ROLE_NAME.get(normalizeRoleName(roleName)) || EMPTY_ROLE_CLASSES;
}

/**
 * Resolve a unique worker role class by static role name.
 *
 * @throws {Error} When more than one job type shares the role name; use
 * getRoleClassForJobType() or getRoleClassesForRoleName() to disambiguate.
 */
export function getRoleClassForRoleName(roleName) {
  const normalized = normalizeRoleName(roleName);
  const matches = ROLE_CLASSES_BY_ROLE_NAME.get(normalized) || [];
  if (matches.length > 1) {
    throw new Error(`Role name "${normalized}" matches multiple job role classes; use getRoleClassForJobType for disambiguation`);
  }
  return matches[0] || null;
}

assertRoleClassRegistryExhaustive();
