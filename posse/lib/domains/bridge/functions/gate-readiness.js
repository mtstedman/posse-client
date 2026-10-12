// @ts-check

import { ONESHOT_SCOPE_SELECTION_SUBTYPE } from "../../../catalog/job.js";

export function isReadyOneshotScopeSelection(payload = {}) {
  const isScopeSelection = payload?.subtype === ONESHOT_SCOPE_SELECTION_SUBTYPE
    || payload?.review_type === ONESHOT_SCOPE_SELECTION_SUBTYPE;
  if (!isScopeSelection) return true;
  return payload?.selector?.status === "ready" || payload?.oneshot_scope?.status === "ready";
}
