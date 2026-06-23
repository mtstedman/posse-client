// admin-atlas-report.js — read-only ATLAS A/B report builder for the admin TUI.
//
// Extracted from AdminTUI.js. These functions only query the runtime DB and
// format the result into display lines; they hold no instance state, mutate no
// selection/scroll, and schedule no renders. The AdminTUI methods
// `_buildAtlasReport` / `_queryAtlasReportRows` delegate here, passing a `ctx`
// that carries the few values the report needs (currently just `projectDir`).

import { C } from "../../../../shared/format/functions/colors.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import {
  foldAtlasRetention,
  foldAtlasTokenSavings,
  foldAtlasToolReliability,
} from "./admin-atlas-rollups.js";
import {
  loadAtlasV2ProcessIndicators,
  renderAtlasV2ProcessIndicators,
} from "../../../atlas/functions/v2/process-indicators.js";
import {
  formatDuration as fmtDuration,
  formatSignedTokens as fmtSignedTokens,
  formatTokens as fmtTokens,
  formatUsd as fmtUsd,
} from "../../../../shared/format/functions/units.js";

export function queryAtlasReportRows() {
  const db = getDb();
  const byMethod = db.prepare(`
    SELECT
      COALESCE(ac.atlas_method, 'baseline') as atlas_method,
      COUNT(*) as call_count,
      SUM(CASE WHEN ac.status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN ac.status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN ac.status = 'timeout' THEN 1 ELSE 0 END) as timed_out,
      SUM(COALESCE(ac.input_tokens, 0)) as input_tokens,
      SUM(COALESCE(ac.output_tokens, 0)) as output_tokens,
      SUM(COALESCE(ac.cost_estimate_usd, 0)) as total_cost_usd,
      SUM(COALESCE(ac.duration_ms, 0)) as total_duration_ms,
      CAST(AVG(COALESCE(ac.duration_ms, 0)) AS INTEGER) as avg_duration_ms,
      SUM(CASE WHEN COALESCE(ja.attempt_number, 1) > 1 THEN 1 ELSE 0 END) as retry_calls,
      COUNT(DISTINCT ac.work_item_id) as work_items,
      COUNT(DISTINCT ac.job_id) as jobs,
      COUNT(DISTINCT CASE WHEN j.assessor_verdict IS NOT NULL AND j.assessor_verdict != 'not_assessed' THEN ac.job_id END) as assessed_jobs,
      COUNT(DISTINCT CASE WHEN j.assessor_verdict = 'pass' THEN ac.job_id END) as passed_jobs,
      COUNT(DISTINCT CASE WHEN j.assessor_verdict = 'fail' THEN ac.job_id END) as failed_jobs,
      COUNT(DISTINCT CASE WHEN j.assessor_verdict = 'needs_replan' THEN ac.job_id END) as replan_jobs,
      COUNT(DISTINCT CASE WHEN j.assessor_verdict = 'blocked' THEN ac.job_id END) as blocked_jobs
    FROM agent_calls ac
    LEFT JOIN job_attempts ja ON ja.id = ac.attempt_id
    LEFT JOIN jobs j ON j.id = ac.job_id
    WHERE ac.atlas_method IS NOT NULL
       OR ac.atlas_prefetch_status IS NOT NULL
    GROUP BY COALESCE(ac.atlas_method, 'baseline')
    ORDER BY call_count DESC, atlas_method ASC
  `).all();

  const byProviderMethod = db.prepare(`
    SELECT
      COALESCE(ac.provider, 'unknown') as provider,
      COALESCE(ac.atlas_method, 'baseline') as atlas_method,
      COUNT(*) as call_count,
      SUM(CASE WHEN ac.status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(COALESCE(ac.input_tokens, 0) + COALESCE(ac.output_tokens, 0)) as total_tokens,
      SUM(COALESCE(ac.cost_estimate_usd, 0)) as total_cost_usd,
      CAST(AVG(COALESCE(ac.duration_ms, 0)) AS INTEGER) as avg_duration_ms,
      SUM(CASE WHEN COALESCE(ja.attempt_number, 1) > 1 THEN 1 ELSE 0 END) as retry_calls
    FROM agent_calls ac
    LEFT JOIN job_attempts ja ON ja.id = ac.attempt_id
    WHERE ac.atlas_method IS NOT NULL
       OR ac.atlas_prefetch_status IS NOT NULL
    GROUP BY COALESCE(ac.provider, 'unknown'), COALESCE(ac.atlas_method, 'baseline')
    ORDER BY provider ASC, call_count DESC, atlas_method ASC
  `).all();

  const byWorkItemMethod = db.prepare(`
    SELECT
      ac.work_item_id as work_item_id,
      COALESCE(wi.title, '(untitled)') as work_item_title,
      COALESCE(ac.atlas_method, 'baseline') as atlas_method,
      COUNT(*) as call_count,
      SUM(CASE WHEN ac.status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(COALESCE(ac.input_tokens, 0) + COALESCE(ac.output_tokens, 0)) as total_tokens,
      SUM(COALESCE(ac.cost_estimate_usd, 0)) as total_cost_usd,
      CAST(AVG(COALESCE(ac.duration_ms, 0)) AS INTEGER) as avg_duration_ms,
      SUM(CASE WHEN COALESCE(ja.attempt_number, 1) > 1 THEN 1 ELSE 0 END) as retry_calls
    FROM agent_calls ac
    LEFT JOIN job_attempts ja ON ja.id = ac.attempt_id
    LEFT JOIN work_items wi ON wi.id = ac.work_item_id
    WHERE ac.atlas_method IS NOT NULL
       OR ac.atlas_prefetch_status IS NOT NULL
    GROUP BY ac.work_item_id, COALESCE(wi.title, '(untitled)'), COALESCE(ac.atlas_method, 'baseline')
    ORDER BY ac.work_item_id DESC, call_count DESC, atlas_method ASC
    LIMIT 60
  `).all();

  const savingsRows = db.prepare(`
    SELECT
      o.observation_type,
      o.detail_json,
      COALESCE((
        SELECT ac.atlas_method
        FROM agent_calls ac
        WHERE ac.job_id = o.job_id
          AND o.attempt_id IS NOT NULL
          AND ac.attempt_id = o.attempt_id
        ORDER BY ac.id DESC
        LIMIT 1
      ), (
        SELECT ac.atlas_method
        FROM agent_calls ac
        WHERE ac.job_id = o.job_id
          AND o.created_at >= ac.started_at
          AND (ac.finished_at IS NULL OR o.created_at <= ac.finished_at)
        ORDER BY ac.id DESC
        LIMIT 1
      ), CASE WHEN o.observation_type = 'tool.atlas.prefetch' THEN 'prefetch' ELSE '' END) as atlas_method
    FROM job_observations o
    WHERE o.observation_type IN ('tool.atlas', 'tool.atlas.prefetch')
      AND (o.detail_json LIKE '%token_usage%' OR o.detail_json LIKE '%tokenUsage%')
    ORDER BY o.id DESC
  `).all();

  const reliabilityRows = db.prepare(`
    SELECT
      o.observation_type,
      o.summary,
      o.detail_json
    FROM job_observations o
    WHERE o.observation_type IN ('tool.atlas', 'tool.atlas.prefetch')
      AND o.detail_json IS NOT NULL
    ORDER BY o.id DESC
  `).all();

  const retentionRows = db.prepare(`
    SELECT
      o.id,
      o.work_item_id,
      o.job_id,
      o.attempt_id,
      o.observation_type,
      o.detail_json
    FROM job_observations o
    WHERE o.observation_type IN ('tool.atlas.prefetch', 'tool.atlas', 'tool.search', 'tool.read', 'tool.list', 'tool.chain_read', 'tool.inspect', 'tool.git_history', 'tool.bash')
      AND o.job_id IS NOT NULL
    ORDER BY o.id ASC
  `).all();

  return {
    byMethod,
    byProviderMethod,
    byWorkItemMethod,
    tokenSavings: foldAtlasTokenSavings(savingsRows),
    toolReliability: foldAtlasToolReliability(reliabilityRows),
    atlasRetention: foldAtlasRetention(retentionRows),
  };
}

export function buildAtlasReport(width, ctx = {}) {
  const projectDir = ctx.projectDir;
  const lines = [];
  const inner = width - 2;
  lines.push("");
  lines.push(` ${C.bold}${C.cyan}═══ ATLAS A/B REPORT ═══${C.reset}`);
  lines.push(` ${C.dim}Project:${C.reset} ${projectDir}`);
  lines.push("");

  try {
    const indicators = loadAtlasV2ProcessIndicators({ projectDir: projectDir, limit: 6 });
    lines.push(...renderAtlasV2ProcessIndicators(indicators, { colors: C, width: Math.max(60, inner), compact: false }));
    lines.push("");
  } catch (err) {
    lines.push(` ${C.yellow}ATLAS v2 process indicators unavailable:${C.reset} ${err?.message || err}`);
    lines.push("");
  }

  let report;
  try {
    report = queryAtlasReportRows();
  } catch (err) {
    lines.push(` ${C.red}Failed to query ATLAS report:${C.reset} ${err?.message || err}`);
    lines.push("");
    return lines;
  }

  const rows = report.byMethod || [];
  if (rows.length === 0) {
    lines.push(` ${C.dim}No ATLAS telemetry has been recorded yet. Run ATLAS-enabled work items, then reopen this tab.${C.reset}`);
    lines.push("");
    return lines;
  }

  const totalCalls = rows.reduce((sum, row) => sum + (row.call_count || 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + (row.input_tokens || 0) + (row.output_tokens || 0), 0);
  const totalRetries = rows.reduce((sum, row) => sum + (row.retry_calls || 0), 0);
  const totalDuration = rows.reduce((sum, row) => sum + (row.total_duration_ms || 0), 0);
  const totalCostUsd = rows.reduce((sum, row) => sum + (Number(row.total_cost_usd) || 0), 0);

  lines.push(` ${C.bold}Method Summary${C.reset}`);
  lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 90))}${C.reset}`);
  const hdr = `  ${"Method".padEnd(12)} ${"Calls".padStart(7)} ${"Share".padStart(7)} ${"Success".padStart(8)} ${"Retries".padStart(8)} ${"Avg Time".padStart(9)} ${"Avg Tok".padStart(9)} ${"Total Tok".padStart(10)} ${"Avg $".padStart(8)} ${"Total $".padStart(9)}`;
  lines.push(` ${C.dim}${hdr}${C.reset}`);
  lines.push(` ${C.dim}${"─".repeat(Math.min(inner, hdr.length + 2))}${C.reset}`);

  for (const row of rows) {
    const calls = row.call_count || 0;
    const succeeded = row.succeeded || 0;
    const successPct = calls > 0 ? `${Math.round((100 * succeeded) / calls)}%` : "—";
    const sharePct = totalCalls > 0 ? `${Math.round((100 * calls) / totalCalls)}%` : "—";
    const retries = row.retry_calls || 0;
    const totalTok = (row.input_tokens || 0) + (row.output_tokens || 0);
    const avgTok = calls > 0 ? Math.round(totalTok / calls) : 0;
    const avgDur = row.avg_duration_ms || 0;
    const totalCost = Number(row.total_cost_usd) || 0;
    const avgCost = calls > 0 ? (totalCost / calls) : 0;
    const method = String(row.atlas_method || "baseline");
    const methodColor = method.includes("atlas") ? C.cyan : C.dim;
    const successColor = succeeded === calls ? C.green : (successPct === "0%" ? C.red : C.yellow);
    lines.push(
      `  ${methodColor}${method.padEnd(12)}${C.reset} ` +
      `${String(calls).padStart(7)} ` +
      `${sharePct.padStart(7)} ` +
      `${successColor}${successPct.padStart(8)}${C.reset} ` +
      `${String(retries).padStart(8)} ` +
      `${fmtDuration(avgDur).padStart(9)} ` +
      `${fmtTokens(avgTok).padStart(9)} ` +
      `${fmtTokens(totalTok).padStart(10)} ` +
      `${fmtUsd(avgCost).padStart(8)} ` +
      `${fmtUsd(totalCost).padStart(9)}`
    );
  }
  lines.push(` ${C.dim}${"─".repeat(Math.min(inner, hdr.length + 2))}${C.reset}`);
  lines.push(
    `  ${C.bold}${"Total".padEnd(12)}${C.reset} ` +
    `${String(totalCalls).padStart(7)} ` +
    `${"100%".padStart(7)} ` +
    `${"".padStart(8)} ` +
    `${String(totalRetries).padStart(8)} ` +
    `${fmtDuration(totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0).padStart(9)} ` +
    `${fmtTokens(totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0).padStart(9)} ` +
    `${fmtTokens(totalTokens).padStart(10)} ` +
    `${fmtUsd(totalCalls > 0 ? totalCostUsd / totalCalls : 0).padStart(8)} ` +
    `${fmtUsd(totalCostUsd).padStart(9)}`
  );
  lines.push("");

  const savingsRows = report.tokenSavings || [];
  if (savingsRows.length > 0) {
    const savingsTotals = savingsRows.reduce((acc, row) => {
      acc.measured_calls += row.measured_calls || 0;
      acc.raw_equivalent += row.raw_equivalent || 0;
      acc.atlas_tokens += row.atlas_tokens || 0;
      acc.saved_tokens += row.saved_tokens || 0;
      acc.negative_calls += row.negative_calls || 0;
      return acc;
    }, { measured_calls: 0, raw_equivalent: 0, atlas_tokens: 0, saved_tokens: 0, negative_calls: 0 });
    lines.push(` ${C.bold}Tool Token Savings${C.reset}  ${C.dim}(from ATLAS token_usage observations)${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 86))}${C.reset}`);
    const sHdr = `  ${"Method".padEnd(12)} ${"Measured".padStart(8)} ${"Raw Eq".padStart(10)} ${"ATLAS Tok".padStart(10)} ${"Saved".padStart(10)} ${"Savings".padStart(8)} ${"Neg".padStart(5)}`;
    lines.push(` ${C.dim}${sHdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, sHdr.length + 2))}${C.reset}`);
    for (const row of savingsRows) {
      const rawEquivalent = Number(row.raw_equivalent || 0);
      const savedTokens = Number(row.saved_tokens || 0);
      const savingsPct = rawEquivalent > 0 ? `${Math.round((100 * savedTokens) / rawEquivalent)}%` : "—";
      const method = String(row.atlas_method || "unknown");
      const methodColor = method.includes("atlas") || method === "prefetch" ? C.cyan : C.dim;
      const savedColor = savedTokens < 0 ? C.red : C.green;
      lines.push(
        `  ${methodColor}${method.padEnd(12)}${C.reset} ` +
        `${String(row.measured_calls || 0).padStart(8)} ` +
        `${fmtTokens(Math.round(rawEquivalent)).padStart(10)} ` +
        `${fmtTokens(Math.round(row.atlas_tokens || 0)).padStart(10)} ` +
        `${savedColor}${fmtSignedTokens(savedTokens).padStart(10)}${C.reset} ` +
        `${savingsPct.padStart(8)} ` +
        `${String(row.negative_calls || 0).padStart(5)}`
      );
    }
    const totalPct = savingsTotals.raw_equivalent > 0
      ? `${Math.round((100 * savingsTotals.saved_tokens) / savingsTotals.raw_equivalent)}%`
      : "—";
    const totalSavedColor = savingsTotals.saved_tokens < 0 ? C.red : C.green;
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, sHdr.length + 2))}${C.reset}`);
    lines.push(
      `  ${C.bold}${"Total".padEnd(12)}${C.reset} ` +
      `${String(savingsTotals.measured_calls).padStart(8)} ` +
      `${fmtTokens(Math.round(savingsTotals.raw_equivalent)).padStart(10)} ` +
      `${fmtTokens(Math.round(savingsTotals.atlas_tokens)).padStart(10)} ` +
      `${totalSavedColor}${fmtSignedTokens(savingsTotals.saved_tokens).padStart(10)}${C.reset} ` +
      `${totalPct.padStart(8)} ` +
      `${String(savingsTotals.negative_calls).padStart(5)}`
    );
    lines.push("");
  }

  const reliabilityRows = report.toolReliability || [];
  if (reliabilityRows.length > 0) {
    const reliabilityTotals = reliabilityRows.reduce((acc, row) => {
      acc.calls += row.calls || 0;
      acc.ok_calls += row.ok_calls || 0;
      acc.failed_calls += row.failed_calls || 0;
      acc.cancelled_calls += row.cancelled_calls || 0;
      acc.empty_calls += row.empty_calls || 0;
      acc.fallback_calls += row.fallback_calls || 0;
      acc.duration_calls += row.duration_calls || 0;
      acc.total_duration_ms += row.total_duration_ms || 0;
      return acc;
    }, { calls: 0, ok_calls: 0, failed_calls: 0, cancelled_calls: 0, empty_calls: 0, fallback_calls: 0, duration_calls: 0, total_duration_ms: 0 });

    lines.push(` ${C.bold}ATLAS Tool Reliability${C.reset}  ${C.dim}(from tool.atlas observations)${C.reset}`);
    lines.push(` ${C.dim}${"-".repeat(Math.min(inner, 102))}${C.reset}`);
    const rHdr = `  ${"Action".padEnd(18)} ${"Origin".padEnd(9)} ${"Calls".padStart(7)} ${"OK".padStart(7)} ${"Fail".padStart(7)} ${"Cancel".padStart(7)} ${"Empty".padStart(7)} ${"Fallback".padStart(8)} ${"Avg Time".padStart(9)} ${"Avg Chars".padStart(9)}`;
    lines.push(` ${C.dim}${rHdr}${C.reset}`);
    lines.push(` ${C.dim}${"-".repeat(Math.min(inner, rHdr.length + 2))}${C.reset}`);
    for (const row of reliabilityRows.slice(0, 16)) {
      const calls = row.calls || 0;
      const okPct = calls > 0 ? `${Math.round((100 * (row.ok_calls || 0)) / calls)}%` : "-";
      const failPct = calls > 0 ? `${Math.round((100 * (row.failed_calls || 0)) / calls)}%` : "-";
      const failColor = (row.cancelled_calls || 0) > 0 || (row.failed_calls || 0) > 0 ? C.red : C.green;
      const emptyColor = (row.empty_calls || 0) > 0 ? C.yellow : C.dim;
      const fallbackColor = (row.fallback_calls || 0) > 0 ? C.yellow : C.dim;
      const action = String(row.action || "unknown").slice(0, 18);
      const origin = String(row.origin || "agent").slice(0, 9);
      const avgChars = row.avg_result_chars == null ? "-" : fmtTokens(row.avg_result_chars);
      lines.push(
        `  ${C.cyan}${action.padEnd(18)}${C.reset} ` +
        `${origin.padEnd(9)} ` +
        `${String(calls).padStart(7)} ` +
        `${okPct.padStart(7)} ` +
        `${failColor}${failPct.padStart(7)}${C.reset} ` +
        `${failColor}${String(row.cancelled_calls || 0).padStart(7)}${C.reset} ` +
        `${emptyColor}${String(row.empty_calls || 0).padStart(7)}${C.reset} ` +
        `${fallbackColor}${String(row.fallback_calls || 0).padStart(8)}${C.reset} ` +
        `${fmtDuration(row.avg_duration_ms || 0).padStart(9)} ` +
        `${avgChars.padStart(9)}`
      );
    }
    if (reliabilityRows.length > 16) {
      lines.push(`  ${C.dim}... (${reliabilityRows.length - 16} more ATLAS action rows)${C.reset}`);
    }
    lines.push(` ${C.dim}${"-".repeat(Math.min(inner, rHdr.length + 2))}${C.reset}`);
    lines.push(
      `  ${C.bold}${"Total".padEnd(18)}${C.reset} ` +
      `${"all".padEnd(9)} ` +
      `${String(reliabilityTotals.calls).padStart(7)} ` +
      `${(reliabilityTotals.calls > 0 ? `${Math.round((100 * reliabilityTotals.ok_calls) / reliabilityTotals.calls)}%` : "-").padStart(7)} ` +
      `${(reliabilityTotals.calls > 0 ? `${Math.round((100 * reliabilityTotals.failed_calls) / reliabilityTotals.calls)}%` : "-").padStart(7)} ` +
      `${String(reliabilityTotals.cancelled_calls).padStart(7)} ` +
      `${String(reliabilityTotals.empty_calls).padStart(7)} ` +
      `${String(reliabilityTotals.fallback_calls).padStart(8)} ` +
      `${fmtDuration(reliabilityTotals.duration_calls > 0 ? Math.round(reliabilityTotals.total_duration_ms / reliabilityTotals.duration_calls) : 0).padStart(9)} ` +
      `${"-".padStart(9)}`
    );
    lines.push("");
  }

  const retention = report.atlasRetention || null;
  if (retention?.total?.measured_calls > 0) {
    const total = retention.total;
    lines.push(` ${C.bold}ATLAS Retention After Prefetch${C.reset}  ${C.dim}(agent ATLAS calls vs native discovery after prefetch)${C.reset}`);
    lines.push(` ${C.dim}${"-".repeat(Math.min(inner, 82))}${C.reset}`);
    const tHdr = `  ${"Scopes".padStart(7)} ${"ATLAS".padStart(7)} ${"Native".padStart(7)} ${"Measured".padStart(8)} ${"Retention".padStart(9)}`;
    lines.push(` ${C.dim}${tHdr}${C.reset}`);
    lines.push(
      `  ${String(total.scopes || 0).padStart(7)} ` +
      `${String(total.atlas_calls_after_prefetch || 0).padStart(7)} ` +
      `${String(total.native_discovery_after_prefetch || 0).padStart(7)} ` +
      `${String(total.measured_calls || 0).padStart(8)} ` +
      `${String(total.retention_pct == null ? "-" : `${total.retention_pct}%`).padStart(9)}`
    );
    const examples = Array.isArray(retention.scopes) ? retention.scopes.slice(0, 6) : [];
    for (const row of examples) {
      const label = row.work_item_id ? `WI#${row.work_item_id}` : `job ${row.job_id || "?"}`;
      const pct = row.retention_pct == null ? "-" : `${row.retention_pct}%`;
      lines.push(
        `  ${C.dim}${label.padEnd(12)}${C.reset} ` +
        `${String(row.atlas_calls_after_prefetch || 0).padStart(5)} atlas  ` +
        `${String(row.native_discovery_after_prefetch || 0).padStart(5)} native  ` +
        `${pct.padStart(6)}`
      );
    }
    if ((retention.scopes || []).length > examples.length) {
      lines.push(`  ${C.dim}... (${retention.scopes.length - examples.length} more prefetched scopes)${C.reset}`);
    }
    lines.push("");
  }

  const outcomeRows = rows.filter((row) => (
    row.assessed_jobs || row.passed_jobs || row.failed_jobs || row.replan_jobs || row.blocked_jobs
  ));
  if (outcomeRows.length > 0) {
    lines.push(` ${C.bold}Assessor Outcome Signals${C.reset}  ${C.dim}(distinct jobs by method)${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 78))}${C.reset}`);
    const oHdr = `  ${"Method".padEnd(12)} ${"Jobs".padStart(6)} ${"Assessed".padStart(8)} ${"Pass".padStart(10)} ${"Fail".padStart(6)} ${"Replan".padStart(8)} ${"Blocked".padStart(8)}`;
    lines.push(` ${C.dim}${oHdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, oHdr.length + 2))}${C.reset}`);
    for (const row of outcomeRows) {
      const method = String(row.atlas_method || "baseline");
      const assessed = row.assessed_jobs || 0;
      const passed = row.passed_jobs || 0;
      const passPct = assessed > 0 ? `${passed}/${assessed} ${Math.round((100 * passed) / assessed)}%` : "—";
      const methodColor = method.includes("atlas") ? C.cyan : C.dim;
      const passColor = assessed > 0 && passed === assessed ? C.green : C.yellow;
      lines.push(
        `  ${methodColor}${method.padEnd(12)}${C.reset} ` +
        `${String(row.jobs || 0).padStart(6)} ` +
        `${String(assessed).padStart(8)} ` +
        `${passColor}${passPct.padStart(10)}${C.reset} ` +
        `${String(row.failed_jobs || 0).padStart(6)} ` +
        `${String(row.replan_jobs || 0).padStart(8)} ` +
        `${String(row.blocked_jobs || 0).padStart(8)}`
      );
    }
    lines.push("");
  }

  const providerRows = report.byProviderMethod || [];
  if (providerRows.length > 0) {
    lines.push(` ${C.bold}Provider Breakdown${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 90))}${C.reset}`);
    const pHdr = `  ${"Provider".padEnd(10)} ${"Method".padEnd(12)} ${"Calls".padStart(7)} ${"Success".padStart(8)} ${"Retries".padStart(8)} ${"Avg Time".padStart(9)} ${"Total Tok".padStart(10)} ${"Total $".padStart(9)}`;
    lines.push(` ${C.dim}${pHdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, pHdr.length + 2))}${C.reset}`);
    for (const row of providerRows) {
      const calls = row.call_count || 0;
      const successPct = calls > 0 ? `${Math.round((100 * (row.succeeded || 0)) / calls)}%` : "—";
      const method = String(row.atlas_method || "baseline");
      const methodColor = method.includes("atlas") ? C.cyan : C.dim;
      lines.push(
        `  ${String(row.provider || "unknown").padEnd(10)} ` +
        `${methodColor}${method.padEnd(12)}${C.reset} ` +
        `${String(calls).padStart(7)} ` +
        `${successPct.padStart(8)} ` +
        `${String(row.retry_calls || 0).padStart(8)} ` +
        `${fmtDuration(row.avg_duration_ms || 0).padStart(9)} ` +
        `${fmtTokens(row.total_tokens || 0).padStart(10)} ` +
        `${fmtUsd(row.total_cost_usd || 0).padStart(9)}`
      );
    }
    lines.push("");
  }

  const wiRows = report.byWorkItemMethod || [];
  if (wiRows.length > 0) {
    lines.push(` ${C.bold}Work Item Breakdown${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 90))}${C.reset}`);
    const wHdr = `  ${"WI".padEnd(7)} ${"Title".padEnd(26)} ${"Method".padEnd(12)} ${"Calls".padStart(7)} ${"Success".padStart(8)} ${"Retries".padStart(8)} ${"Avg Time".padStart(9)} ${"Total Tok".padStart(10)} ${"Total $".padStart(9)}`;
    lines.push(` ${C.dim}${wHdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, wHdr.length + 2))}${C.reset}`);
    for (const row of wiRows) {
      const calls = row.call_count || 0;
      const successPct = calls > 0 ? `${Math.round((100 * (row.succeeded || 0)) / calls)}%` : "—";
      const method = String(row.atlas_method || "baseline");
      const methodColor = method.includes("atlas") ? C.cyan : C.dim;
      const wiLabel = row.work_item_id ? `WI#${row.work_item_id}` : "WI#?";
      const title = String(row.work_item_title || "(untitled)")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 26);
      lines.push(
        `  ${wiLabel.padEnd(7)} ` +
        `${title.padEnd(26)} ` +
        `${methodColor}${method.padEnd(12)}${C.reset} ` +
        `${String(calls).padStart(7)} ` +
        `${successPct.padStart(8)} ` +
        `${String(row.retry_calls || 0).padStart(8)} ` +
        `${fmtDuration(row.avg_duration_ms || 0).padStart(9)} ` +
        `${fmtTokens(row.total_tokens || 0).padStart(10)} ` +
        `${fmtUsd(row.total_cost_usd || 0).padStart(9)}`
      );
    }
    lines.push("");
  }

  lines.push(` ${C.dim}Notes: retries = calls from attempt #2+; timing/token/cost metrics are from agent_calls; tool savings come from ATLAS token_usage and can be negative; reliability comes from tool.atlas observations.${C.reset}`);
  lines.push("");
  return lines;
}
