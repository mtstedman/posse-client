import { C } from "../../../../shared/format/functions/colors.js";
import {
  formatDuration as fmtDuration,
  formatTokens as fmtTokens,
  formatUsd as fmtUsd,
} from "../../../../shared/format/functions/units.js";
import { fit } from "../../functions/admin/shared-helpers.js";

const SPARKS = "▁▂▃▄▅▆▇█";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function addGroup(map, key, values) {
  const name = String(key || "unknown");
  const current = map.get(name) || { calls: 0, ok: 0, tokens: 0, duration: 0, cost: 0 };
  current.calls += number(values.calls);
  current.ok += number(values.ok);
  current.tokens += number(values.tokens);
  current.duration += number(values.duration);
  current.cost += number(values.cost);
  map.set(name, current);
}

function sparkline(values) {
  const nums = values.map(number);
  const max = Math.max(...nums, 0);
  if (max <= 0) return "·".repeat(Math.max(1, nums.length));
  return nums.map((value) => SPARKS[Math.min(SPARKS.length - 1, Math.round((value / max) * (SPARKS.length - 1)))]).join("");
}

function bar(value, max, width = 18) {
  const safeWidth = Math.max(4, width | 0);
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * safeWidth)) : 0;
  return `${"█".repeat(Math.min(safeWidth, filled))}${C.dim}${"░".repeat(Math.max(0, safeWidth - filled))}${C.reset}`;
}

function reportRun(report) {
  const items = Array.isArray(report?.data) ? report.data : [];
  const out = {
    timestamp: String(report?.timestamp || "unknown"),
    items: items.length,
    calls: 0,
    successfulCalls: 0,
    tokens: 0,
    duration: 0,
    cost: 0,
    toolCalls: 0,
    merged: 0,
  };
  for (const item of items) {
    const totals = item?.totals || {};
    out.tokens += number(totals.inputTokens) + number(totals.outputTokens);
    out.duration += number(totals.durationMs);
    out.cost += number(totals.knownCostUsd ?? totals.costUsd);
    out.toolCalls += number(totals.toolCalls);
    if (item?.delivery?.localState === "merged" || item?.workItem?.mergeState === "merged") out.merged += 1;
    for (const call of Array.isArray(item?.agentCalls) ? item.agentCalls : []) {
      out.calls += 1;
      if (call?.status === "succeeded") out.successfulCalls += 1;
    }
  }
  return out;
}

export function buildAdminReportAnalytics(reports = []) {
  const valid = (Array.isArray(reports) ? reports : []).filter((report) => Array.isArray(report?.data));
  const runs = valid.map(reportRun);
  const items = valid.flatMap((report) => report.data.map((item) => ({ ...item, reportTimestamp: report.timestamp })));
  const providers = new Map();
  const roles = new Map();
  const models = new Map();
  const tools = new Map();
  let calls = 0;
  let successfulCalls = 0;
  let tokens = 0;
  let duration = 0;
  let cost = 0;
  let toolCalls = 0;
  let merged = 0;
  let failedItems = 0;

  for (const item of items) {
    const totals = item?.totals || {};
    tokens += number(totals.inputTokens) + number(totals.outputTokens);
    duration += number(totals.durationMs);
    cost += number(totals.knownCostUsd ?? totals.costUsd);
    toolCalls += number(totals.toolCalls);
    if (item?.delivery?.localState === "merged" || item?.workItem?.mergeState === "merged") merged += 1;
    if (["failed", "rejected"].includes(String(item?.workItem?.status || item?.decision || "").toLowerCase())) failedItems += 1;

    for (const call of Array.isArray(item?.agentCalls) ? item.agentCalls : []) {
      const callTokens = number(call?.inputTokens) + number(call?.outputTokens);
      const ok = call?.status === "succeeded" ? 1 : 0;
      const values = { calls: 1, ok, tokens: callTokens, duration: call?.durationMs, cost: call?.costUsd };
      calls += 1;
      successfulCalls += ok;
      addGroup(providers, call?.provider, values);
      addGroup(roles, call?.role, values);
      addGroup(models, call?.model, values);
    }

    for (const tool of Array.isArray(item?.toolUsageSummary) ? item.toolUsageSummary : []) {
      const name = String(tool?.type || "unknown").replace(/^tool\./u, "");
      const current = tools.get(name) || { calls: 0, succeeded: 0, failed: 0, rejected: 0 };
      current.calls += number(tool?.count);
      current.succeeded += number(tool?.succeeded);
      current.failed += number(tool?.failed);
      current.rejected += number(tool?.rejected);
      tools.set(name, current);
    }
  }

  return {
    reports: valid.length,
    items: items.length,
    calls,
    successfulCalls,
    tokens,
    duration,
    cost,
    toolCalls,
    merged,
    failedItems,
    runs,
    providers,
    roles,
    models,
    tools,
    latest: runs[0] || null,
  };
}

export function renderAdminReportDashboardSummary(reports, width) {
  const data = buildAdminReportAnalytics(reports);
  const inner = Math.max(30, width - 2);
  const lines = [
    ` ${C.bold}${C.cyan}REPORT SUMMARY${C.reset}  ${C.dim}saved review reports${C.reset}`,
    ` ${C.dim}${"─".repeat(Math.min(inner, 72))}${C.reset}`,
  ];
  if (data.reports === 0) {
    lines.push(` ${C.dim}No saved review reports yet. Detailed analytics appear in Reports after a review.${C.reset}`, "");
    return lines;
  }
  const success = data.calls > 0 ? `${Math.round((data.successfulCalls / data.calls) * 100)}% call success` : "no calls";
  lines.push(fit(` ${C.brightWhite}${data.reports} reports${C.reset}  ·  ${data.items} work items  ·  ${fmtTokens(data.tokens)} tokens  ·  ${fmtUsd(data.cost)} known cost`, inner));
  lines.push(fit(` ${C.green}${data.merged} merged${C.reset}  ·  ${success}  ·  ${fmtDuration(data.duration)} agent time  ·  ${data.toolCalls} tool calls`, inner));
  const recent = data.runs.slice(0, 10).reverse();
  lines.push(fit(` ${C.dim}Recent token trend${C.reset}  ${C.cyan}${sparkline(recent.map((run) => run.tokens))}${C.reset}  ${C.dim}latest ${data.latest?.timestamp || "unknown"}  ·  [5] Reports for detail${C.reset}`, inner));
  lines.push("");
  return lines;
}

function renderGroupChart(lines, title, groups, width, valueKey = "tokens", limit = 8) {
  const sorted = [...groups.entries()].sort((a, b) => number(b[1]?.[valueKey]) - number(a[1]?.[valueKey])).slice(0, limit);
  if (sorted.length === 0) return;
  const max = Math.max(...sorted.map(([, entry]) => number(entry?.[valueKey])), 0);
  lines.push(` ${C.bold}${title}${C.reset}`);
  for (const [name, entry] of sorted) {
    const success = entry.calls > 0 ? `${Math.round((entry.ok / entry.calls) * 100)}% ok` : "—";
    const value = valueKey === "cost" ? fmtUsd(entry.cost) : fmtTokens(entry.tokens);
    lines.push(fit(`  ${String(name).slice(0, 16).padEnd(16)} ${C.cyan}${bar(number(entry[valueKey]), max, 16)}${C.reset} ${value.padStart(9)}  ${C.dim}${entry.calls} calls · ${success}${C.reset}`, width));
  }
  lines.push("");
}

export function renderAdminReports(reports, width) {
  const data = buildAdminReportAnalytics(reports);
  const inner = Math.max(36, width - 2);
  const lines = [
    "",
    ` ${C.bold}${C.cyan}REPORTS${C.reset}  ${C.dim}delivery, cost, quality, and tool evidence${C.reset}`,
    ` ${C.dim}${"─".repeat(Math.min(inner, 78))}${C.reset}`,
  ];
  if (data.reports === 0) {
    lines.push(` ${C.dim}No saved review reports yet.${C.reset}`);
    lines.push(` ${C.dim}Complete a review to populate delivery and performance analytics here.${C.reset}`, "");
    return lines;
  }

  const successRate = data.calls > 0 ? Math.round((data.successfulCalls / data.calls) * 100) : 0;
  lines.push(` ${C.bold}Portfolio${C.reset}`);
  lines.push(fit(`  ${data.reports} reports  ·  ${data.items} work items  ·  ${data.calls} agent calls  ·  ${data.toolCalls} tools`, inner));
  lines.push(fit(`  ${fmtTokens(data.tokens)} tokens  ·  ${fmtDuration(data.duration)} agent time  ·  ${fmtUsd(data.cost)} known cost`, inner));
  lines.push(fit(`  ${C.green}${data.merged} merged${C.reset}  ·  ${successRate}% call success${data.failedItems > 0 ? `  ·  ${C.red}${data.failedItems} failed/rejected${C.reset}` : ""}`, inner));
  lines.push("");

  const recent = data.runs.slice(0, 12).reverse();
  const maxTokens = Math.max(...recent.map((run) => run.tokens), 0);
  lines.push(` ${C.bold}Recent report volume${C.reset}  ${C.cyan}${sparkline(recent.map((run) => run.tokens))}${C.reset}`);
  for (const run of recent) {
    const date = run.timestamp.slice(0, 16);
    lines.push(fit(`  ${C.dim}${date}${C.reset} ${C.cyan}${bar(run.tokens, maxTokens, 20)}${C.reset} ${fmtTokens(run.tokens).padStart(9)}  ${fmtUsd(run.cost).padStart(8)}  ${run.items} WI`, inner));
  }
  lines.push("");

  renderGroupChart(lines, "Providers · token volume", data.providers, inner, "tokens");
  renderGroupChart(lines, "Roles · token volume", data.roles, inner, "tokens");
  renderGroupChart(lines, "Models · known cost", data.models, inner, "cost");

  const topTools = [...data.tools.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 12);
  if (topTools.length > 0) {
    const maxToolCalls = Math.max(...topTools.map(([, entry]) => entry.calls), 0);
    lines.push(` ${C.bold}Tool reliability${C.reset}`);
    for (const [name, entry] of topTools) {
      const problems = entry.failed + entry.rejected;
      lines.push(fit(`  ${name.slice(0, 20).padEnd(20)} ${C.magenta}${bar(entry.calls, maxToolCalls, 14)}${C.reset} ${String(entry.calls).padStart(5)}  ${C.green}${entry.succeeded} ok${C.reset}${problems > 0 ? `  ${C.yellow}${entry.failed} fail · ${entry.rejected} reject${C.reset}` : ""}`, inner));
    }
    lines.push("");
  }

  lines.push(` ${C.bold}Saved reports${C.reset}`);
  for (const run of data.runs.slice(0, 20)) {
    lines.push(fit(`  ${C.dim}${run.timestamp}${C.reset}  ${run.items} WI  ${fmtTokens(run.tokens)}  ${fmtUsd(run.cost)}  ${run.merged} merged`, inner));
  }
  if (data.runs.length > 20) lines.push(`  ${C.dim}+${data.runs.length - 20} older reports${C.reset}`);
  lines.push("");
  return lines;
}
