// Waiting-lane preparation catalogue.
//
// This module freezes the persisted vocabulary shared by the queue, scheduler,
// Git adapter, and ATLAS integration.  It is deliberately pure: no database,
// filesystem, or process access belongs in a catalogue module.

import { SETTING_KEYS } from "./settings.js";

const sqlList = (values) => values.map((value) => `'${value}'`).join(", ");

export const WAITING_LANE_JOB_TYPE = "waiting_lane_prepare";

export const WAITING_LANE_ATLAS_PURPOSES = Object.freeze({
  SNAPSHOT: "wi-snapshot",
  CATCHUP: "wi-catchup",
  PREFETCH: "wi-prefetch",
});
export const WAITING_LANE_ATLAS_PURPOSE_VALUES = Object.freeze(
  Object.values(WAITING_LANE_ATLAS_PURPOSES),
);

export const WAITING_LANE_STATES = Object.freeze([
  "requested",
  "preparing_git",
  "waiting_atlas",
  "ready",
  "stale",
  "activating",
  "active",
  "poisoned",
  "retired",
]);
export const WAITING_LANE_STATE_LIST_SQL = sqlList(WAITING_LANE_STATES);

export const WAITING_LANE_PREPARATORY_STATES = new Set([
  "requested",
  "preparing_git",
  "waiting_atlas",
  "ready",
  "stale",
]);
export const WAITING_LANE_NONTERMINAL_STATES = new Set([
  ...WAITING_LANE_PREPARATORY_STATES,
  "activating",
  "active",
]);
export const WAITING_LANE_TERMINAL_STATES = new Set(["poisoned", "retired"]);

export const WAITING_LANE_DEMAND_REASONS = Object.freeze([
  "research",
  "planner",
  "dev",
  "operator",
]);
export const WAITING_LANE_DEMAND_REASON_LIST_SQL = sqlList(WAITING_LANE_DEMAND_REASONS);

export const WAITING_LANE_TRANSITION_OUTCOMES = Object.freeze([
  "requested_new",
  "coalesced_queued",
  "promoted",
  "running_successor_marked",
  "already_current",
  "activation_claimed",
  "retired",
  "poisoned",
  "version_conflict",
  "ineligible",
]);

export const WAITING_LANE_GENERATION_FIELDS = Object.freeze([
  "target_branch",
  "git_oid",
  "atlas_ledger_seq",
  "atlas_layer_revision",
  "view_fingerprint",
]);

/**
 * @typedef {Object} WaitingLaneGeneration
 * @property {string} target_branch
 * @property {string} git_oid
 * @property {number} atlas_ledger_seq
 * @property {number} atlas_layer_revision
 * @property {string} view_fingerprint
 */

export const WAITING_LANE_NATIVE_METHODS = Object.freeze({
  PREPARE: "git.worktree.prepareDetached",
  REFRESH: "git.worktree.refreshPrepared",
  ACTIVATE: "git.worktree.activatePrepared",
  INSPECT: "git.worktree.inspectPrepared",
});

export const WAITING_LANE_OWNERSHIP_FORMAT_VERSION = 1;
export const WAITING_LANE_OWNERSHIP_PHASES = Object.freeze([
  "intent",
  "prepared",
  "attached",
  "retired",
]);

// Independent rollout controls.  Creation/consumption stays disabled unless a
// later integration wave explicitly reads and enables these settings.
export const WAITING_LANE_SETTING_KEYS = Object.freeze({
  SHADOW_MODE: SETTING_KEYS.WAITING_LANE_SHADOW_MODE,
  GIT_PREPARATION_ENABLED: SETTING_KEYS.WAITING_LANE_GIT_PREPARATION_ENABLED,
  ATLAS_SNAPSHOT_ENABLED: SETTING_KEYS.WAITING_LANE_ATLAS_SNAPSHOT_ENABLED,
  ATLAS_CATCHUP_ENABLED: SETTING_KEYS.WAITING_LANE_ATLAS_CATCHUP_ENABLED,
  ACTIVATION_ENABLED: SETTING_KEYS.WAITING_LANE_ACTIVATION_ENABLED,
  PREPARATION_CONCURRENCY: SETTING_KEYS.WAITING_LANE_PREPARATION_CONCURRENCY,
  MAX_PREPARED_LANES: SETTING_KEYS.WAITING_LANE_MAX_PREPARED_LANES,
  PREPARED_TTL_MS: SETTING_KEYS.WAITING_LANE_PREPARED_TTL_MS,
  MAX_HOT_PATHS: SETTING_KEYS.WAITING_LANE_MAX_HOT_PATHS,
});

export function isWaitingLaneGeneration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    typeof value.target_branch === "string"
    && value.target_branch.trim().length > 0
    && typeof value.git_oid === "string"
    && /^[0-9a-f]{40,64}$/iu.test(value.git_oid.trim())
    && Number.isSafeInteger(value.atlas_ledger_seq)
    && value.atlas_ledger_seq >= 0
    && Number.isSafeInteger(value.atlas_layer_revision)
    && value.atlas_layer_revision >= 0
    && typeof value.view_fingerprint === "string"
    && value.view_fingerprint.trim().length > 0
  );
}

export function normalizeWaitingLaneGeneration(value) {
  if (!isWaitingLaneGeneration(value)) return null;
  return Object.freeze({
    target_branch: value.target_branch.trim(),
    git_oid: value.git_oid.trim().toLowerCase(),
    atlas_ledger_seq: value.atlas_ledger_seq,
    atlas_layer_revision: value.atlas_layer_revision,
    view_fingerprint: value.view_fingerprint.trim(),
  });
}

export function waitingLaneGenerationsEqual(left, right) {
  const a = normalizeWaitingLaneGeneration(left);
  const b = normalizeWaitingLaneGeneration(right);
  return !!a && !!b && WAITING_LANE_GENERATION_FIELDS.every((field) => a[field] === b[field]);
}
