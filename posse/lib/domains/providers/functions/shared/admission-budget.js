import { reserveBudget, settleBudget } from "../../../queue/functions/admission-budget.js";
import { getObservationContext } from "../../../observability/functions/observations.js";
import { copyProviderOptions } from "./provider-options.js";

/** Auxiliary direct-provider routes also belong to the current work-item budget. */
export async function withProviderAdmission(provider, opts, execute) {
  const { _budgetReservationId } = opts;
  const providerOpts = copyProviderOptions(opts);
  delete providerOpts._budgetReservationId;
  if (_budgetReservationId) return execute(providerOpts); // TrackedProviderClient owns settlement
  const context = getObservationContext() || {};
  const reservation = reserveBudget({ workItemId: context.work_item_id, jobId: context.job_id,
    attemptId: context.attempt_id, parentCallId: context.agent_call_id, provider,
    model: opts.modelName, role: opts.role || context.role });
  try { return await execute(providerOpts); }
  finally { settleBudget(reservation); } // no complete agent-call receipt means unknown, never free
}
