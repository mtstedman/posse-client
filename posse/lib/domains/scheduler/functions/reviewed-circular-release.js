import { findWorkItemOrderConflict, getJobWriteScope, loadWorkItemOrder } from "../../queue/functions/file-locks.js";
import { reviewedHandoffsEnabled, supportsReviewedAdmission } from "../../queue/functions/reviewed-handoff-admission.js";
import { prepareCrossWiFileSyncHandoff } from "./cross-wi-file-sync.js";

// Reviewed content admission may find an existing-order cycle before the
// ordinary held-lock scan. Preserve the established bare-release resolver;
// it independently refuses live writers and never copies content. Rebuild
// admission after each release. Reviewed transfers still occur only at lease.
export function resolveReviewedCircularOwnership(job, ownerId, order = null) {
  let conflict = findWorkItemOrderConflict(job, order);
  let released = false;
  const scope = reviewedHandoffsEnabled() ? getJobWriteScope(job) : null;
  if (scope && supportsReviewedAdmission(job, scope)) {
    for (let remaining = scope.files.length; conflict && remaining > 0; remaining--) {
      if (!conflict.lock?.id || !prepareCrossWiFileSyncHandoff(job, conflict, ownerId, { recordWait: false })) break;
      released = true;
      order = loadWorkItemOrder();
      conflict = findWorkItemOrderConflict(job, order);
    }
  }
  return { conflict, released, order };
}
