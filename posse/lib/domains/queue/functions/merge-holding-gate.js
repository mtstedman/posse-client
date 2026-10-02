// The gate that holds a completed work item out of automatic merge.
//
// Two callers must agree on it: authorizeWorkItemAutoMerge (queue-store.js)
// refuses the merge, and workItemMergeParking (file-locks.js) takes the work
// item out of the work-item order as "parked until an operator acts". Each
// used to carry its own copy of the query, and only the authorize copy knew
// that a merge verification review answered "fail" is spent once its
// rejection requeue ran: a work item reworked after that answer was
// authorized and merged automatically, yet reported as parked, so it left the
// order and could end a run as needs-action for nothing (run 1250b red team
// 2, finding 10).

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  MERGE_RELEASING_RETRY_REVIEW_TYPES,
  MERGE_VERIFICATION_REVIEW_TYPE,
  canonicalHumanGateAction,
} from "../../../catalog/human-input.js";
import { MERGE_VERIFICATION_REJECTION_KEY } from "./merge-verification-review.js";

// Gate answers after which automatic merge stays refused.
export const MERGE_HOLDING_GATE_ACTIONS = Object.freeze([
  "fail", "replan", "retry_assessment", "retry_with_changes",
  "reject", "deny", "revert", "extend",
]);
const RECOVERY_RETRY_ACTION = canonicalHumanGateAction("retry");

/**
 * The gate that holds `workItemId` out of automatic merge, or null: an open
 * or resolving gate on it, or a resolved one whose answer refuses automatic
 * merge (MERGE_HOLDING_GATE_ACTIONS). A merge verification review answered
 * "fail" whose rejection requeue already ran (MERGE_VERIFICATION_REJECTION_KEY
 * on the gate) is spent, like a work-item review rejection: the reworked work
 * item is reviewed again by a new gate, so the old answer no longer holds it.
 * A retry answered on a recovery gate (MERGE_RELEASING_RETRY_REVIEW_TYPES)
 * never holds: the retried work is assessed like any other.
 * Open gates come first, then the newest.
 *
 * @returns {{ gate_job_id: number, gate_state: string, resolution_action: string|null, review_type: string|null } | null}
 */
export function findMergeHoldingGate(workItemId, db = getDb()) {
  const row = db.prepare(`
    SELECT
      hg.gate_job_id,
      hg.gate_state,
      hg.resolution_action,
      CASE WHEN json_valid(gate_job.payload_json)
        THEN json_extract(gate_job.payload_json, '$.review_type')
        ELSE NULL END AS review_type
    FROM human_gates hg
    JOIN jobs gate_job ON gate_job.id = hg.gate_job_id
    WHERE gate_job.work_item_id = ?
      AND (
        hg.gate_state IN ('open', 'resolving')
        OR (
          hg.gate_state = 'resolved'
          AND hg.resolution_action IN (${MERGE_HOLDING_GATE_ACTIONS.map(() => "?").join(",")})
          AND NOT (CASE WHEN json_valid(gate_job.payload_json)
            THEN json_extract(gate_job.payload_json, '$.review_type') = ?
              AND json_extract(gate_job.payload_json, '$.${MERGE_VERIFICATION_REJECTION_KEY}') IS NOT NULL
            ELSE 0 END)
          AND NOT (hg.resolution_action = ? AND (CASE WHEN json_valid(gate_job.payload_json)
            THEN json_extract(gate_job.payload_json, '$.review_type')
              IN (${MERGE_RELEASING_RETRY_REVIEW_TYPES.map(() => "?").join(",")})
            ELSE 0 END))
        )
      )
    ORDER BY CASE WHEN hg.gate_state IN ('open', 'resolving') THEN 0 ELSE 1 END, hg.gate_job_id DESC
    LIMIT 1
  `).get(
    Number(workItemId),
    ...MERGE_HOLDING_GATE_ACTIONS,
    MERGE_VERIFICATION_REVIEW_TYPE,
    RECOVERY_RETRY_ACTION,
    ...MERGE_RELEASING_RETRY_REVIEW_TYPES,
  );
  if (!row) return null;
  return {
    gate_job_id: Number(row.gate_job_id),
    gate_state: row.gate_state,
    resolution_action: row.resolution_action ?? null,
    review_type: row.review_type ?? null,
  };
}
