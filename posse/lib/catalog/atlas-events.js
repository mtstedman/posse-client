


// @ts-check
//
// Frozen event-name constants for the ATLAS v2 pipeline. These are the wire
// between the pipeline-integration workstream (emits) and the warmer
// workstream (consumes). They live here so neither side can drift.
//
// The string values are stable identifiers — once published they may be
// observed by other tooling (logs, metrics, future external subscribers),
// so never change a value, only add new ones.

/**
 * @typedef {(
 *   "atlas.research_complete"
 *   | "atlas.dev_leased"
 *   | "atlas.dev_committed"
 *   | "atlas.merged_to_main"
 *   | "atlas.main_advanced"
 *   | "atlas.scip_restage_requested"
 *   | "atlas.scip_staged"
 *   | "atlas.wi_cleanup"
 *   | "atlas.embeddings_resume"
 *   | "atlas.self_repair"
 * )} AtlasEventName
 */

export const ATLAS_EVENTS = Object.freeze({
  /** Emitted when a researcher job succeeds. Payload: { wi_id, files: string[] }. Hint for view warming. */
  RESEARCH_COMPLETE: "atlas.research_complete",

  /** Emitted when a dev/fix/promote job is leased and a worktree is about to spawn. Payload: { wi_id, branch }. Triggers view mount. */
  DEV_LEASED: "atlas.dev_leased",

  /** Emitted after a dev/fix/promote job commits to the WI branch. Payload: { wi_id, branch, paths: string[] }. Triggers incremental reindex. */
  DEV_COMMITTED: "atlas.dev_committed",

  /** Emitted when a WI branch merges back into main. Payload: { wi_id, branch, target_branch }. Triggers ledger partition replay. */
  MERGED_TO_MAIN: "atlas.merged_to_main",

  /** Emitted when main advances (post-commit hook, external git pull, etc). Payload: { from_sha, to_sha, paths: string[] }. Triggers incremental main reindex. */
  MAIN_ADVANCED: "atlas.main_advanced",

  /** Emitted when staged SCIP artifacts should be refreshed. Payload: { to_sha, target_branch, reason }. Triggers a scip-restage warm job. */
  SCIP_RESTAGE_REQUESTED: "atlas.scip_restage_requested",

  /** Emitted when a standalone scip-restage staged FRESH artifacts. Staging alone never ingests (WI warms are hot-view-only and readiness reports staged as ready), so this triggers the main-incremental warm whose SCIP phase consumes the staged index — otherwise the symbols wait for the next unrelated main warm. Payload: { target_branch, reason }. */
  SCIP_STAGED: "atlas.scip_staged",

  /** Emitted when a WI is being purged. Payload: { wi_id, branch }. Triggers view file deletion; ledger partition is retained for audit. */
  WI_CLEANUP: "atlas.wi_cleanup",

  /** Emitted when the embedding index is below parity and its owner is gone (boot backgrounded/failed, crash). Payload: { target_branch, reason, remaining }. Triggers a budget-sliced embeddings warm that re-enqueues itself until coverage reaches parity. */
  EMBEDDINGS_RESUME: "atlas.embeddings_resume",

  /** Emitted when readiness inspection finds a non-ready layer with no live owner. Payload: { reason, layers }. The emitter supplies an explicit warm payload for the repair (e.g. main-full). */
  SELF_REPAIR: "atlas.self_repair",
});
