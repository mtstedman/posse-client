// lib/timeline-render.js
//
// Text and JSON renderers for the timeline structure produced by
// `lib/timeline.js`. Kept separate so the data builder stays pure and
// testable, and so the admin TUI can render without pulling in CLI-only
// concerns like ANSI color tables.

import { C } from "../../../../shared/format/functions/colors.js";
import { statusColor } from "../../../ui/functions/display/status-palette.js";
import {
  formatDuration as formatDurationMs,
  formatTokens,
  formatUsdOrNull as formatCost,
} from "../../../../shared/format/functions/units.js";

function shortTime(iso) {
  if (!iso) return "";
  const m = String(iso).match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : String(iso).slice(0, 19);
}

function truncate(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function renderHeader(data) {
  const wi = data.workItem;
  const sum = data.summary;
  const lines = [];
  const bar = "═".repeat(72);
  lines.push("");
  lines.push(`${C.bold}${bar}${C.reset}`);
  lines.push(`${C.bold}WI#${wi.id}  ${wi.title}${C.reset}`);
  lines.push(`${C.bold}${bar}${C.reset}`);
  const statusLine = `${statusColor(wi.status)}${wi.status}${C.reset}`
    + (wi.durationMs != null ? `  ${C.dim}(${formatDurationMs(wi.durationMs)})${C.reset}` : "");
  lines.push(`  ${C.dim}Status:${C.reset}   ${statusLine}`);
  if (wi.branchName) lines.push(`  ${C.dim}Branch:${C.reset}   ${wi.branchName}${wi.mergeState ? `  ${C.dim}merge=${wi.mergeState}${C.reset}` : ""}`);
  lines.push(`  ${C.dim}Mode:${C.reset}     ${wi.mode || "build"}  ${C.dim}priority=${wi.priority || "normal"}${C.reset}`);
  if (wi.createdAt) lines.push(`  ${C.dim}Created:${C.reset}  ${wi.createdAt}${wi.completedAt ? `   ${C.dim}Completed:${C.reset} ${wi.completedAt}` : ""}`);

  const totals = [];
  totals.push(`${sum.jobCount} jobs`);
  totals.push(`${sum.attemptCount} attempts`);
  totals.push(`${sum.agentCallCount} agent calls`);
  if (sum.totalInputTokens || sum.totalOutputTokens) {
    totals.push(`~${formatTokens(sum.totalInputTokens)} in / ~${formatTokens(sum.totalOutputTokens)} out`);
  }
  const cost = formatCost(sum.totalCostUsd);
  if (cost) totals.push(cost);
  lines.push(`  ${C.dim}Totals:${C.reset}   ${totals.join("  |  ")}`);
  return lines.join("\n");
}

function renderAttempts(attempts, { verbose = false } = {}) {
  const lines = [];
  for (const att of attempts) {
    const color = statusColor(att.status);
    const bits = [];
    if (att.durationMs != null) bits.push(formatDurationMs(att.durationMs));
    if (att.modelName) bits.push(att.modelName);
    if (att.inputTokens || att.outputTokens) {
      bits.push(`tok=${formatTokens(att.inputTokens)}/${formatTokens(att.outputTokens)}`);
    }
    const cost = formatCost(att.costUsd);
    if (cost) bits.push(cost);
    if (att.commitHash) bits.push(`commit=${String(att.commitHash).slice(0, 8)}`);
    lines.push(`    ${C.dim}├─${C.reset} attempt ${att.attemptNumber}: ${color}${att.status}${C.reset}  ${C.dim}${bits.join("  ")}${C.reset}`);
    if (att.errorText) {
      lines.push(`    ${C.dim}│${C.reset}   ${C.red}error:${C.reset} ${truncate(att.errorText, 160)}`);
    }
    if (verbose) {
      for (const call of att.agentCalls || []) {
        const atlas = call.atlasMethod ? ` atlas=${call.atlasMethod}` : "";
        const callCost = formatCost(call.costUsd);
        const costBit = callCost ? `  ${callCost}` : "";
        lines.push(`    ${C.dim}│${C.reset}   ${C.cyan}${call.role}${C.reset} ${C.dim}${call.provider || "?"}/${call.modelTier || "?"}${atlas}${C.reset}  ${formatDurationMs(call.durationMs)}  tok=${formatTokens(call.inputTokens)}/${formatTokens(call.outputTokens)}${costBit}`);
      }
    }
  }
  return lines.join("\n");
}

function renderScopeViolations(events) {
  const violations = (events || []).filter((ev) =>
    ev.eventType === "job.scope_compat_untracked_out_of_scope"
    || ev.eventType === "worktree.reset_incomplete"
  );
  if (violations.length === 0) return null;
  const out = [];
  for (const ev of violations) {
    const files = ev.eventJson?.files || ev.eventJson?.remaining_paths || [];
    const label = ev.eventType === "job.scope_compat_untracked_out_of_scope" ? "scope-compat" : "reset-incomplete";
    out.push(`    ${C.yellow}⚠${C.reset}  ${label}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5})` : ""}`);
  }
  return out.join("\n");
}

function renderJob(job, { verbose = false } = {}) {
  const lines = [];
  const color = statusColor(job.status);
  const provider = job.provider || "?";
  const tier = job.modelTier || "?";
  const headerBits = [];
  if (job.durationMs != null) headerBits.push(formatDurationMs(job.durationMs));
  headerBits.push(`${job.attemptCount || job.attempts?.length || 0} attempt${(job.attemptCount || 0) === 1 ? "" : "s"}`);
  if (job.parentJobId) headerBits.push(`from #${job.parentJobId}`);
  const verdict = job.assessorVerdict && job.assessorVerdict !== "not_assessed"
    ? `  ${statusColor(job.assessorVerdict)}${job.assessorVerdict}${C.reset}${job.assessorConfidence ? `(${job.assessorConfidence})` : ""}`
    : "";
  lines.push(`${C.dim}─────${C.reset} ${C.bold}Job #${job.id}${C.reset}  ${C.cyan}${job.jobType}${C.reset}  ${color}${job.status}${C.reset}${verdict}  ${C.dim}[${headerBits.join(", ")}]  ${provider}/${tier}${C.reset}`);
  const title = truncate(job.title, 96);
  if (title) lines.push(`    ${C.dim}${title}${C.reset}`);
  if (job.attempts && job.attempts.length > 0) {
    lines.push(renderAttempts(job.attempts, { verbose }));
  }
  const scope = renderScopeViolations(job.events);
  if (scope) lines.push(scope);
  if (job.lastError) {
    lines.push(`    ${C.red}last_error:${C.reset} ${truncate(job.lastError, 160)}`);
  }
  return lines.join("\n");
}

function renderWiEvents(events, { verbose = false } = {}) {
  if (!events || events.length === 0) return null;
  const limit = verbose ? events.length : 20;
  const chosen = events.slice(-limit);
  const lines = [`\n  ${C.bold}WI Events${C.reset} ${C.dim}(${chosen.length}/${events.length})${C.reset}`];
  for (const ev of chosen) {
    lines.push(`    ${C.dim}${shortTime(ev.createdAt)}${C.reset}  ${C.cyan}${ev.eventType}${C.reset}  ${truncate(ev.message, 120)}`);
  }
  return lines.join("\n");
}

/**
 * Render a timeline as ANSI-colored text suitable for a terminal.
 * Accepts the shape returned by buildTimeline().
 */
export function renderTimelineText(data, { verbose = false } = {}) {
  if (!data) return `No timeline data.`;
  const lines = [renderHeader(data), ""];
  for (const job of data.jobs || []) {
    lines.push(renderJob(job, { verbose }));
    lines.push("");
  }
  const evBlock = renderWiEvents(data.wiEvents, { verbose });
  if (evBlock) lines.push(evBlock);
  lines.push("");
  return lines.join("\n");
}

/**
 * Render a timeline as a pretty-printed JSON string.
 */
export function renderTimelineJson(data) {
  return `${JSON.stringify(data ?? null, null, 2)}\n`;
}
