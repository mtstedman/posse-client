import { getDb } from "../../../shared/storage/functions/index.js";
import { TERMINAL_WORK_ITEM_STATUSES_SQL } from "../../../catalog/work-item.js";

// Report the basis recorded when a call was billed. Resolving today's price
// book for historical calls would hide missing provenance and old fallbacks.
export function collectPricingCoverage({ db = getDb(), active = false } = {}) {
  const rows = db.prepare(`
    SELECT ac.provider, ac.model_name, ac.pricing_basis,
           COUNT(*) AS call_count, SUM(ac.cost_estimate_usd) AS cost_estimate_usd
    FROM agent_calls ac
    ${active ? `JOIN work_items wi ON wi.id = ac.work_item_id
      WHERE (wi.status NOT IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
        OR wi.merge_state IN ('pending_review', 'merge_failed')) AND` : "WHERE"}
      ac.finished_at IS NOT NULL
    GROUP BY ac.provider, ac.model_name, ac.pricing_basis
    ORDER BY ac.provider, ac.model_name, ac.pricing_basis
  `).all();
  const nonExact = rows.filter(row => !String(row.pricing_basis || "").startsWith("exact:"));
  const totalCalls = rows.reduce((sum, row) => sum + row.call_count, 0);
  const nonExactCalls = nonExact.reduce((sum, row) => sum + row.call_count, 0);
  return {
    total_calls: totalCalls,
    exact_calls: totalCalls - nonExactCalls,
    non_exact_calls: nonExactCalls,
    non_exact: nonExact,
  };
}
