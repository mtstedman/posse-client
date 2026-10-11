import { C } from "../../../../shared/format/functions/colors.js";
import { _sanitizeDisplayLine } from "./helpers/formatters.js";
import { canonicalAtlasActionName } from "../../../../shared/tools/functions/mcp-surface.js";

// Glyph for a COMPLETED tool row. In-flight rows are detected separately by the
// caller (they pulse \u25cf \u25cb in cyan), so this only decides done-vs-failed.
// The recorded outcome (row.ok, lifted from finishToolInvocation's detail.ok by
// getRecentToolInvocations) is authoritative: a real boolean settles it with no
// string-sniffing. That fixes both failure modes of the old keyword scan \u2014 a
// successful `grep "error" file` (the word is the search term, not a failure) no
// longer reads as a false \u2717, and a genuine failure whose summary carries no
// failure keyword no longer reads as a false \u2713. The keyword scan survives only
// as a fallback for rows that never recorded an outcome (ok == null): legacy
// observation logs and replay rows, where the summary text is the only signal.
function monitorToolMeta(row = {}) {
  const outcome = String(row.outcome || "").trim().toLowerCase();
  if (outcome === "rejected") return { glyph: "\u2298", color: C.yellow, label: "rejected", outcome };
  if (outcome === "failed") return { glyph: "\u2715", color: C.red, label: "failed", outcome };
  if (outcome === "succeeded") return { glyph: "\u2713", color: C.green, label: "done", outcome };
  if (row.ok === false) return { glyph: "\u2715", color: C.red, label: "failed", outcome: "failed" };
  if (row.ok === true) return { glyph: "\u2713", color: C.green, label: "done", outcome: "succeeded" };
  const text = `${row.observation_type || ""} ${row.summary || ""}`.toLowerCase();
  if (/\b(rejected|denied|cancelled|canceled|blocked)\b/.test(text)) {
    return { glyph: "\u2298", color: C.yellow, label: "rejected", outcome: "rejected" };
  }
  if (/\b(error|failed|fail)\b/.test(text)) {
    return { glyph: "\u2715", color: C.red, label: "failed", outcome: "failed" };
  }
  return { glyph: "\u2713", color: C.green, label: "done", outcome: "succeeded" };
}



function stripToolPrefix(value) {
  return String(value || "tool.?").replace(/^tool\./, "");
}




const TOOL_SUMMARY_LABEL_ALIASES = new Map([
  ["chainverdict", ["chainreview"]],
  ["editfile", ["edit"]],
  ["hashfile", ["hash"]],
  ["inspectfile", ["inspect"]],
  ["listfiles", ["list"]],
  ["pruneartifactoutput", ["pruneartifact"]],
  ["readfile", ["read"]],
  ["searchfiles", ["search"]],
  ["validateartifactoutput", ["validateartifact"]],
  ["webfetch", ["fetch", "webfetch"]],
  ["websearch", ["search", "websearch"]],
  ["writefile", ["write"]],
]);



function normalizeToolSummaryLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}



function stripAtlasSummaryActionPrefix(summary) {
  const text = String(summary || "").trimStart();
  const match = text.match(/^((?:(?:atlas)\s+|(?:atlas)[._-]){0,4}[A-Za-z][A-Za-z0-9_.-]*)(.*)$/i);
  if (!match) return text;
  const action = canonicalAtlasActionName(match[1]);
  return action ? `${action}${match[2] || ""}` : text;
}



function stripRedundantToolSummaryLabel(tool, summary) {
  const text = String(summary || "").trimStart();
  if (!text) return "";
  const normalizedTool = normalizeToolSummaryLabel(tool);
  const isAtlasTool = normalizedTool === "atlas" || normalizedTool.startsWith("atlas");
  const aliases = new Set([
    normalizedTool,
    ...(isAtlasTool ? ["atlas"] : []),
    ...(TOOL_SUMMARY_LABEL_ALIASES.get(normalizedTool) || []),
  ].map(normalizeToolSummaryLabel).filter(Boolean));

  const colonLabel = text.match(/^([A-Za-z][A-Za-z0-9_. -]{0,40}):\s*/);
  if (colonLabel && aliases.has(normalizeToolSummaryLabel(colonLabel[1]))) {
    const stripped = text.slice(colonLabel[0].length);
    return isAtlasTool ? stripAtlasSummaryActionPrefix(stripped) : stripped;
  }

  const leadingToken = text.match(/^([A-Za-z][A-Za-z0-9_.-]{0,20})\s+/);
  if (
    leadingToken
    && normalizeToolSummaryLabel(leadingToken[1]) === "atlas"
    && aliases.has("atlas")
  ) {
    return stripAtlasSummaryActionPrefix(text.slice(leadingToken[0].length));
  }

  return isAtlasTool ? stripAtlasSummaryActionPrefix(text) : text;
}



function splitAtlasActionFromSummary(summary) {
  const text = String(summary || "").trimStart();
  const match = text.match(/^((?:atlas\s+|atlas[._-]){0,4}[A-Za-z][A-Za-z0-9_.-]*)(.*)$/i);
  if (!match) return { action: null, rest: text };
  const action = canonicalAtlasActionName(match[1]);
  if (!action) return { action: null, rest: text };
  return { action, rest: String(match[2] || "").trim() };
}



// Split a tool observation into the three columns the monitor log renders:
//   module  — "atlas" or "tool" (which subsystem ran the call)
//   command — the action/tool name (memory.get, read_file, …)
//   info    — the remaining call detail (anchors, path, query, …)
// ATLAS rows carry the action inside the summary ("atlas memory.get (…)"), so
// the action is peeled off into its own command column; deterministic rows put
// the tool name in observation_type and the detail in the summary.
function monitorToolRowParts(row = {}) {
  const tool = stripToolPrefix(row.observation_type);
  const normalizedTool = normalizeToolSummaryLabel(tool);
  const isAtlas = normalizedTool === "atlas" || normalizedTool.startsWith("atlas");
  const summary = _sanitizeDisplayLine(stripRedundantToolSummaryLabel(tool, row.summary));
  if (isAtlas) {
    const { action, rest } = splitAtlasActionFromSummary(summary);
    if (action) return { module: "atlas", command: action, info: rest };
    return { module: "atlas", command: "", info: summary };
  }
  return { module: "tool", command: tool, info: summary };
}

export { monitorToolMeta, stripRedundantToolSummaryLabel, monitorToolRowParts };
