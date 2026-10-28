import { TOOL_OBSERVATION_OUTCOMES } from "../../../catalog/observation.js";
import { redactBridgeValue, redactString } from "../../bridge/functions/redaction.js";
import { isPosseMcpGatewaySurfaceName, stripPosseMcpGatewayPrefix } from "../../integrations/functions/mcp-gateway.js";
import { TOOL_CATALOG, TOOL_OBSERVATION_ALIASES } from "../../integrations/functions/deterministic-mcp/tool-descriptors.js";
import { FINAL_REVIEW_TOOL_NAME } from "../../../catalog/final-review.js";
import { getAgentCallById } from "../../queue/functions/agent-calls.js";
import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import { finalReviewLogSummary } from "../../assessment/functions/final-review-log-summary.js";
import { canonicalAtlasToolUseActionName, formatAtlasToolDisplayName } from "../../../shared/tools/functions/mcp-surface.js";
import { stripHashRefSurfaceSuffix } from "../../../shared/tools/functions/ref-surface.js";
import { getObservationContext } from "./observation-context.js";

export function normalizedToolOutcome(value, { ok = null, status = "", error = "" } = {}) {
  const explicit = String(value || "").trim().toLowerCase();
  if (TOOL_OBSERVATION_OUTCOMES.has(explicit)) return explicit;
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (["succeeded", "success", "completed"].includes(normalizedStatus)) return "succeeded";
  if (["rejected", "denied", "cancelled", "canceled"].includes(normalizedStatus)) return "rejected";
  if (["failed", "error"].includes(normalizedStatus) || error) return "failed";
  if (ok === true) return "succeeded";
  if (ok === false) return "failed";
  return null;
}

function _truncate(value, max = 120) {
  const text = redactString(String(value || "")).trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function normalizeToolObservationPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function _normalizePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function normalizeCatalogToolName(toolName = "") {
  const lower = String(toolName || "").trim().toLowerCase();
  let name = stripPosseMcpGatewayPrefix(lower);
  return TOOL_OBSERVATION_ALIASES[name] || name;
}

export const CATALOG_DETERMINISTIC_TOOL_NAMES = new Set(
  Object.values(TOOL_CATALOG)
    .filter((entry) => entry?.schema && entry.gateTier !== "atlas")
    .map((entry) => entry.name)
);

function _firstInputValue(input = {}, keys = []) {
  for (const key of keys || []) {
    const value = input?.[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      const first = value.find((entry) => entry != null && String(entry).trim() !== "");
      if (first != null) return String(first);
      continue;
    }
    if (String(value).trim() !== "") return String(value);
  }
  return "";
}

function _normalizedWebToolKind(toolName = "") {
  const normalized = String(toolName || "")
    .trim()
    .toLowerCase()
    .replace(/^tools[._-]/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["webfetch", "web_fetch", "web_fetch_call"].includes(normalized)) return "fetch";
  if (["websearch", "web_search", "web_search_call", "web_search_preview"].includes(normalized)) return "search";
  return null;
}

export function isWebToolName(toolName = "") {
  return !!_normalizedWebToolKind(toolName);
}

function _pathTarget(input = {}, spec = {}) {
  const direct = _firstInputValue(input, spec.pathKeys || []);
  if (direct) return direct;
  for (const key of spec.arrayPathKeys || []) {
    const values = Array.isArray(input?.[key]) ? input[key].filter(Boolean) : [];
    if (values.length === 0) continue;
    return values.length === 1 ? String(values[0]) : `${values[0]} +${values.length - 1}`;
  }
  return "";
}

function _catalogDetail({ spec, cwdNorm, tool, catalogName, extra = {} }) {
  return {
    cwd: cwdNorm || null,
    tool_name: tool,
    catalog_name: catalogName,
    kind: spec.kind || "deterministic",
    ...extra,
  };
}

export function summarizeCatalogToolUse(tool, input = {}, cwdNorm = null, rel = (value) => normalizeToolObservationPath(value), observationDetail = {}) {
  const catalogName = normalizeCatalogToolName(tool);
  const entry = TOOL_CATALOG[catalogName];
  if (!entry || entry.gateTier === "atlas") return null;
  const spec = entry.observation;
  if (!spec) throw new Error(`Missing observation spec for deterministic tool ${catalogName}`);

  if (catalogName === FINAL_REVIEW_TOOL_NAME) {
    let reviewer = false;
    const callId = observationDetail?.agent_call_id ?? getObservationContext()?.agent_call_id;
    try { if (callId) reviewer = getAgentCallById(callId)?.child_kind === AGENT_CALL_CHILD_KINDS.FINAL_REVIEW; } catch { /* replay may lack a runtime database */ }
    return {
      observation_type: spec.type,
      summary: finalReviewLogSummary({ input, result: observationDetail?.final_review_result, reviewer, lifecycle: true }),
      detail: _catalogDetail({ spec, cwdNorm, tool, catalogName, extra: { input: _summarizeAtlasArgs(input) } }),
    };
  }

  if (spec.format === "command") {
    const command = _truncate(input[spec.commandKey || "command"] || "", 140);
    if (!command) return null;
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${command}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { command: input[spec.commandKey || "command"] || "" } }),
    };
  }

  if (spec.format === "file") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    if (!filePath && spec.requireTarget) return null;
    const offset = spec.includeRange ? _normalizePositiveInt(input.offset, 1) : null;
    const limit = spec.includeRange ? _normalizePositiveInt(input.limit, 2000) : null;
    const rangeHint = spec.includeRange && (offset !== 1 || limit !== 2000) ? ` [${offset}+${limit}]` : "";
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 140)}${rangeHint}`,
      detail: _catalogDetail({
        spec,
        input,
        cwdNorm,
        tool,
        catalogName,
        extra: {
          path: normalizeToolObservationPath(rawPath),
          ...(spec.includeRange ? { offset, limit } : {}),
          ...(spec.pair ? { pair: spec.pair } : {}),
        },
      }),
    };
  }

  if (spec.format === "edit") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    if (!filePath && spec.requireTarget) return null;
    // Provider-owned Edit events and historical logs retain their wire names.
    const changed = _truncate(input.find ?? input.old_string ?? "", 60);
    const editCount = Array.isArray(input.edits) ? input.edits.length : null;
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 140)}${editCount != null ? ` (${editCount} edits)` : changed ? ` (${changed})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: normalizeToolObservationPath(rawPath), ...(editCount != null ? { edit_count: editCount } : {}) } }),
    };
  }

  if (spec.format === "list") {
    const target = rel(_firstInputValue(input, spec.targetKeys || []));
    const pattern = _truncate(input.pattern || "", 80);
    if (!target) return null;
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(target, 100)}${pattern ? ` (${pattern})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: normalizeToolObservationPath(input.path || input.directory || ""), pattern: input.pattern || null } }),
    };
  }

  if (spec.format === "search") {
    const target = rel(_firstInputValue(input, spec.targetKeys || []));
    const pattern = _truncate(input.pattern || "", 60);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(target || ".", 100)}${pattern ? ` (${pattern})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: normalizeToolObservationPath(input.path || input.directory || input.file_path || ""), pattern: input.pattern || null } }),
    };
  }

  if (spec.format === "resize_image") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const width = Number.isFinite(Number(input.width)) ? Number(input.width) : null;
    const height = Number.isFinite(Number(input.height)) ? Number(input.height) : null;
    const dims = width && height ? `${width}x${height}` : width ? `${width}w` : height ? `${height}h` : "";
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 120)}${dims ? ` -> ${dims}` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: normalizeToolObservationPath(rawPath), output_path: normalizeToolObservationPath(input.output_path || ""), width, height } }),
    };
  }

  if (spec.format === "generate_image") {
    const filename = _pathTarget(input, spec);
    const size = _truncate(input.size || "", 20);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filename || ".", 120)}${size ? ` (${size})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { filename: String(filename || ""), size: input.size || null, quality: input.quality || null } }),
    };
  }

  if (spec.format === "artifact_output") {
    const root = input[spec.rootKey || "output_root"] || ".";
    const rootPath = rel(root);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(rootPath || ".", 120)}${spec.includeDryRun && input.dry_run === true ? " (dry-run)" : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { output_root: normalizeToolObservationPath(root), task_mode: input.task_mode || "image", ...(spec.includeDryRun ? { dry_run: input.dry_run === true } : {}) } }),
    };
  }

  if (spec.format === "move_copy") {
    const srcRaw = input[spec.sourceKey || "source"] || "";
    const dstRaw = input[spec.destinationKey || "destination"] || "";
    const src = rel(srcRaw);
    const dst = rel(dstRaw);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(src, 60)} -> ${_truncate(dst, 60)}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { source: normalizeToolObservationPath(srcRaw), destination: normalizeToolObservationPath(dstRaw) } }),
    };
  }

  if (spec.format === "chain_verdict") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const verdict = _truncate(input.verdict || "", 20);
    const summary = _truncate(input.summary || "", 80);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath, 80)} -> ${verdict}${summary ? ` (${summary})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: normalizeToolObservationPath(rawPath), verdict: input.verdict || null, summary: input.summary || null, pair: spec.pair || null } }),
    };
  }

  if (spec.format === "reencode_image") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const outputPath = rel(input.output_path || "");
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath, 120)}${outputPath ? ` -> ${_truncate(outputPath, 80)}` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: normalizeToolObservationPath(rawPath), output_path: normalizeToolObservationPath(input.output_path || ""), output_format: input.output_format || "png" } }),
    };
  }

  if (spec.format === "generic") {
    const firstQuestion = Array.isArray(input.questions) ? input.questions[0] : null;
    const question = typeof firstQuestion === "string" ? firstQuestion : firstQuestion?.question || firstQuestion?.text || firstQuestion?.title;
    const target = catalogName === "request_clarification" ? question : _firstInputValue(input, spec.targetKeys || []);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(target || ".", catalogName === "request_clarification" ? 120 : 140)}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { input: _summarizeAtlasArgs(input) } }),
    };
  }

  throw new Error(`Unknown observation format "${spec.format}" for deterministic tool ${catalogName}`);
}

export function resolveAtlasToolUseAction(toolName = "", input = {}) {
  return canonicalAtlasToolUseActionName(toolName, input);
}

export function isPosseGatewayToolUse(toolName = "") {
  return isPosseMcpGatewaySurfaceName(toolName);
}

function _summarizeAtlasArgs(input = {}) {
  if (!input || typeof input !== "object") return {};
  const redactedInput = redactBridgeValue(input);
  const out = {};
  const symbolRef = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const summarized = {};
    if (typeof value.name === "string") summarized.name = _truncate(value.name, 160);
    if (typeof value.file === "string") summarized.file = _truncate(value.file, 160);
    if (typeof value.kind === "string") summarized.kind = _truncate(value.kind, 80);
    if (typeof value.exportedOnly === "boolean") summarized.exportedOnly = value.exportedOnly;
    return Object.keys(summarized).length > 0 ? summarized : null;
  };
  const compactItem = (item) => {
    if (!item || typeof item !== "object") return item;
    try { return JSON.stringify(item); } catch { return "[object]"; }
  };
  const keys = Object.keys(redactedInput || {}).slice(0, 8);
  for (const key of keys) {
    const value = redactedInput[key];
    if (value == null) out[key] = null;
    else if (typeof value === "string") out[key] = _truncate(value, 160);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && key === "symbolRefs") {
      out[key] = value.slice(0, 8).map((item) => symbolRef(item) || "[object]");
    }
    else if (Array.isArray(value) && key === "items") {
      out[key] = value.slice(0, 4).map((item) => (
        item && typeof item === "object"
          ? {
              ...(item.file ? { file: _truncate(item.file, 160) } : {}),
              ...(item.symbolId ? { symbolId: _truncate(item.symbolId, 80) } : {}),
            }
          : _truncate(item, 80)
      ));
    }
    // Object items (web_research_handoff findings/sources) are serialized;
    // String() logged them as "[object Object]".
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map((item) => _truncate(compactItem(item), 80));
    else if (typeof value === "object" && key === "symbolRef") {
      out[key] = symbolRef(value) || "[object]";
    }
    else if (key === "__unparsedToolInput" && typeof value?.raw === "string") {
      out[key] = _truncate(value.raw, 160);
    }
    else if (typeof value === "object") out[key] = "[object]";
    else out[key] = _truncate(value, 80);
  }
  return out;
}

export function __testSummarizeAtlasArgs(input = {}) {
  return _summarizeAtlasArgs(input);
}

// Per-action hint extractor. The raw args include a lot of metadata; we want
// the log to show whatever best identifies *what ATLAS is working on* for that
// action — e.g. the symbol being searched, the file being skeletonized, the
// identifiers being located. Falling back to taskText is a last resort
// because for slice.build / context the taskText is usually the job's
// own title, which operators already see in the log prefix.
export function atlasSummaryHint(input = {}, action = null) {
  if (!input || typeof input !== "object") return "";
  const args = input;
  const a = String(action || "").toLowerCase().replace(/^atlas\./, "");

  const firstArrayEntry = (arr, max = 2) => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const head = arr.slice(0, max).map((v) => String(v).trim()).filter(Boolean).join(", ");
    const tail = arr.length > max ? ` +${arr.length - max}` : "";
    return head ? `${head}${tail}` : null;
  };

  const identifierEntry = (value, max = 3) => {
    let items = [];
    if (Array.isArray(value)) {
      items = value;
    } else if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      if (text.startsWith("[")) {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) items = parsed;
        } catch {
          // Legacy scalar form falls through to comma/semicolon splitting.
        }
      }
      if (items.length === 0) items = text.split(/[,;]+/u);
    }
    const normalized = items.map((item) => String(item || "").trim()).filter(Boolean);
    if (normalized.length === 0) return null;
    const head = normalized.slice(0, max).join(", ");
    const tail = normalized.length > max ? ` +${normalized.length - max}` : "";
    return `${head}${tail}`;
  };

  if (a === "symbol.search") {
    const q = args.query || args.pattern;
    if (q) return _truncate(q, 80);
  }

  if (a === "symbol.card") {
    const ids = Array.isArray(args.symbolIds) ? args.symbolIds
      : (args.symbolId ? [args.symbolId] : []);
    if (ids.length > 0) {
      return `${ids.length} symbol target${ids.length === 1 ? "" : "s"}`;
    }
    const refs = Array.isArray(args.symbolRefs) ? args.symbolRefs
      : (args.symbolRef ? [args.symbolRef] : []);
    if (refs.length > 0) {
      const first = refs[0] || {};
      const label = first.name || first.file || (first.symbolId ? "symbol target" : "");
      const tail = refs.length > 1 ? ` +${refs.length - 1}` : "";
      return label ? `${_truncate(label, 60)}${tail}` : "";
    }
  }

  if (a === "symbol.get" || a === "symbol.callers") {
    // Name the symbols being pulled, not just the action: a bare "symbol.get"
    // hides which bodies a job actually read.
    const refs = Array.isArray(args.symbolRefs) ? args.symbolRefs
      : (args.symbolRef ? [args.symbolRef] : []);
    const ids = Array.isArray(args.symbolIds) ? args.symbolIds
      : (args.symbolId ? [args.symbolId] : []);
    const labels = refs
      .map((ref) => {
        if (typeof ref === "string") return ref.trim();
        const name = String(ref?.name || "").trim();
        const file = String(ref?.file || ref?.path || "").trim();
        return name && file ? `${name} @ ${file}` : (name || file);
      })
      .filter(Boolean);
    const total = labels.length + ids.length;
    if (labels.length > 0) {
      const tail = total > 1 ? ` +${total - 1}` : "";
      return _truncate(`${labels[0]}${tail}`, 120);
    }
    if (ids.length > 0) return `${ids.length} symbol target${ids.length === 1 ? "" : "s"}`;
  }

  if (a === "traverse_ref" || a === "create_ref") {
    const raw = args.traversal_refs ?? args.traversal_ref ?? args.refs ?? args.ref;
    const refs = (Array.isArray(raw) ? raw : [raw])
      .map((ref) => String(ref ?? "").trim())
      .filter(Boolean);
    if (refs.length > 0) {
      const tail = refs.length > 3 ? ` +${refs.length - 3}` : "";
      return _truncate(`${refs.slice(0, 3).join(", ")}${tail}`, 80);
    }
    const target = args.file || args.path || args.symbolRef?.name || null;
    if (target) return _truncate(String(target), 80);
  }

  if (a === "slice.build" || a === "slice.refresh") {
    const entries = firstArrayEntry(args.entrySymbols);
    if (entries) return `entries: ${_truncate(entries, 60)}`;
    const files = firstArrayEntry(args.editedFiles, 1);
    if (files) return `files: ${_truncate(files, 60)}`;
    if (args.failingTestPath) return `failing: ${_truncate(args.failingTestPath, 60)}`;
    if (args.sliceHandle) return `handle: ${_truncate(args.sliceHandle, 40)}`;
    // Deliberately DON'T fall back to taskText here: for slice.build the
    // taskText is almost always the job's own title, which the operator
    // already sees in the log prefix — echoing it back is noise. If nothing
    // targeted was provided, the summary just shows the bare action name.
    return "";
  }

  if (a === "tree.scope" || a === "tree.expand") {
    // Seeds are the load-bearing input — show them, not the task text, so a
    // seeded scope never reads like a raw text search in the invocation log.
    const seeds = firstArrayEntry(args.paths && args.paths.length ? args.paths : args.editedFiles, 1);
    if (seeds) return `seeds: ${_truncate(seeds, 60)}`;
    const symbols = firstArrayEntry(args.symbolIds, 1);
    if (symbols) {
      const count = Array.isArray(args.symbolIds) ? args.symbolIds.length : 1;
      return `seeds: ${count} symbol target${count === 1 ? "" : "s"}`;
    }
    if (args.taskText) return "task-text only (no seeds)";
    return "";
  }

  if (a === "tree.branch") {
    const focus = args.path || args.nodeId || (args.symbolId ? "symbol target" : null);
    if (focus) return _truncate(String(focus), 80);
  }

  if (a === "code.skeleton" || a === "code.lens" || a === "code.window") {
    const loc = args.file || (args.symbolId ? "symbol target" : null);
    const ids = identifierEntry(args.identifiersToFind, 3);
    const selection = ids && loc ? `${ids} @ ${loc}` : (ids || loc || "");
    const shape = a === "code.window"
      ? (args.symbolId
          ? String(args.granularity || "symbol")
          : `file window${args.expectedLines ? ` ${args.expectedLines}L` : ""}`)
      : (a === "code.lens" && args.contextLines != null ? `±${args.contextLines}L` : "");
    const parts = [selection, shape].filter(Boolean);
    if (parts.length > 0) return _truncate(parts.join(" · "), 140);
  }

  if (a === "context" || a === "agent.context") {
    if (args.taskText) return _truncate(String(args.taskText).split(/\r?\n/)[0], 80);
  }

  if (a === "file.read") {
    const parts = [];
    if (args.filePath) parts.push(args.filePath);
    if (args.search) parts.push(`search='${_truncate(args.search, 40)}'`);
    if (parts.length > 0) return _truncate(parts.join(" "), 80);
  }

  if (a === "review.delta" || a === "review.analyze") {
    if (args.fromVersion && args.toVersion) return `${args.fromVersion}->${args.toVersion}`;
    if (args.versionId) return _truncate(args.versionId, 40);
  }

  if (a === "repo.status" || a === "repo.overview") {
    if (args.repoId) return _truncate(args.repoId, 80);
  }

  if (a === "memory.store") {
    if (args.title) return _truncate(String(args.title), 80);
    const anchors = firstArrayEntry(args.fileRelPaths, 1)
      || (Array.isArray(args.symbolIds) && args.symbolIds.length
        ? `${args.symbolIds.length} symbol${args.symbolIds.length === 1 ? "" : "s"}`
        : null);
    if (anchors) return _truncate(anchors, 80);
  }

  if (a === "memory.feedback") {
    const parts = [];
    if (args.verdict) parts.push(String(args.verdict));
    if (args.memoryId) parts.push(_truncate(String(args.memoryId), 24));
    if (parts.length > 0) return parts.join(" ");
  }

  if (a === "memory.get" || a === "memory.surface") {
    // Memory retrieval is anchored on exact files/symbols (and optional domain
    // filters) — surface those so the log shows WHAT was probed, not a bare
    // "memory.get". The generic fallback below only knows singular query/file
    // keys, so these array-shaped anchors would otherwise read as no detail.
    const files = firstArrayEntry(args.fileRelPaths, 2);
    const symbolCount = Array.isArray(args.symbolIds) ? args.symbolIds.length : 0;
    const domains = firstArrayEntry(args.domains, 3);
    const parts = [];
    if (files) parts.push(files);
    else if (symbolCount > 0) parts.push(`${symbolCount} symbol${symbolCount === 1 ? "" : "s"}`);
    if (domains) parts.push(`[${domains}]`);
    if (parts.length > 0) return _truncate(parts.join(" "), 80);
  }

  // Generic fallback — mirrors the original priority order but ordered so
  // action-specific hints above run first.
  const candidates = [
    args.query,
    args.pattern,
    args.file,
    args.filePath,
    args.taskText,
    args.sliceHandle,
    args.versionId,
    args.fromVersion && args.toVersion ? `${args.fromVersion}->${args.toVersion}` : null,
  ];
  const first = candidates.find((value) => value != null && String(value).trim() !== "");
  if (first) return _truncate(String(first).split(/\r?\n/)[0], 80);
  if (args.symbolId) return "symbol target";
  if (Array.isArray(args.symbolIds) && args.symbolIds.length > 0) {
    return `${args.symbolIds.length} symbol target${args.symbolIds.length === 1 ? "" : "s"}`;
  }
  return "";
}

// Internal alias preserves the existing call sites.
const _atlasSummaryHint = atlasSummaryHint;

export function summarizeToolUse(toolUse, cwd = null) {
  if (!toolUse?.tool) return null;
  const input = toolUse.input || {};
  const rawTool = String(toolUse.tool);
  const posseGatewayMcp = isPosseGatewayToolUse(rawTool);
  const atlasAction = resolveAtlasToolUseAction(rawTool, input);
  // When a Claude/Codex tool_use event targets the Posse MCP gateway, the
  // gateway subprocess has already recorded the invocation with enriched
  // context (chain-state path for chain_verdict, etc.). Recording again on the
  // parent side would double-count every successful call. The exception is an
  // ATLAS call Codex cancelled before the subprocess saw it; then provider
  // replay is the only evidence.
  if (posseGatewayMcp) {
    if (!atlasAction) return null;
    if (!toolUse.status && !toolUse.error) return null;
  }
  const tool = rawTool;
  const toolLower = tool.toLowerCase();
  const webToolKind = _normalizedWebToolKind(tool);
  const cwdNorm = cwd ? normalizeToolObservationPath(cwd).replace(/\/+$/, "") : null;
  const rel = (target) => {
    const norm = normalizeToolObservationPath(target);
    if (!cwdNorm || !norm.startsWith(cwdNorm)) return norm;
    const sliced = norm.slice(cwdNorm.length).replace(/^\/+/, "");
    return sliced || ".";
  };

  const catalogSummary = summarizeCatalogToolUse(tool, input, cwdNorm, rel, toolUse.observation_detail);
  if (catalogSummary) return catalogSummary;

  if (webToolKind === "fetch") {
    const url = _firstInputValue(input, ["url", "uri", "href", "page_url"]);
    return {
      observation_type: "tool.web_fetch",
      summary: `WebFetch: ${_truncate(url || "(unknown URL)", 140)}`,
      detail: {
        kind: "web",
        tool_name: tool,
        url: url || null,
        cwd: cwdNorm || null,
      },
    };
  }

  if (webToolKind === "search") {
    const query = _firstInputValue(input, ["query", "q", "search", "search_query"]);
    return {
      observation_type: "tool.web_search",
      summary: `WebSearch: ${_truncate(query || "(unknown query)", 140)}`,
      detail: {
        kind: "web",
        tool_name: tool,
        query: query || null,
        cwd: cwdNorm || null,
      },
    };
  }

  if (tool === "MultiEdit") {
    const filePath = rel(input.file_path || "");
    const count = Array.isArray(input.edits) ? input.edits.length : 0;
    if (!filePath) return null;
    return {
      observation_type: "tool.multiedit",
      summary: `MultiEdit: ${_truncate(filePath, 140)} (${count} edit${count === 1 ? "" : "s"})`,
      detail: { file_path: normalizeToolObservationPath(input.file_path || ""), edit_count: count, cwd: cwdNorm || null },
    };
  }
  if (toolLower === "apply_patch") {
    const filePath = rel(input.file_path || input.path || "");
    const changeKind = _truncate(input.change_kind || "", 20);
    if (!filePath) return null;
    return {
      observation_type: "tool.apply_patch",
      summary: `apply_patch: ${_truncate(filePath, 120)}${changeKind ? ` (${changeKind})` : ""}`,
      detail: {
        file_path: normalizeToolObservationPath(input.file_path || input.path || ""),
        change_kind: input.change_kind || null,
        cwd: cwdNorm || null,
        tool_name: tool,
        kind: "system_call",
      },
    };
  }
  if (atlasAction) {
    // atlas.query carries the selected action's arguments under `args`, while
    // the owner records the canonical action with those arguments at the top
    // level. Summarize both shapes from the same payload so close-time replay
    // reconciliation does not invent a second call merely because its label
    // lost the file, symbol, or query.
    const atlasInput = input.args && typeof input.args === "object" && !Array.isArray(input.args)
      ? input.args
      : input;
    const hint = _atlasSummaryHint(atlasInput, atlasAction);
    const displayName = formatAtlasToolDisplayName(atlasAction) || `atlas ${atlasAction}`;
    const status = String(toolUse.status || "").trim().toLowerCase();
    const rejectedStatus = ["rejected", "denied", "cancelled", "canceled"].includes(status);
    const rawErrorText = String(toolUse.error || "").trim();
    const errorText = rejectedStatus ? "" : rawErrorText;
    const rejectionText = String(toolUse.rejection || (rejectedStatus ? rawErrorText : "")).trim();
    const outcome = normalizedToolOutcome(toolUse.outcome, {
      status,
      error: errorText,
    });
    const statusSuffix = rejectedStatus
      ? " rejected"
      : (errorText ? " failed" : "");
    const diagnosticText = errorText || rejectionText;
    const errorSuffix = diagnosticText ? `: ${_truncate(diagnosticText, 80)}` : "";
    // Tool-use stream observations are always agent-initiated — prefetch
    // flows through _recordAtlasToolObservation directly and never becomes a
    // tool_use event on the wire.
    const observationType = atlasAction === "buffer.push" ? "atlas.buffer_push" : "tool.atlas";
    return {
      observation_type: observationType,
      summary: `${displayName}${hint ? ` (${hint})` : ""}${statusSuffix}${errorSuffix}`,
      detail: {
        kind: "atlas",
        origin: "agent",
        action: atlasAction,
        args: _summarizeAtlasArgs(atlasInput),
        cwd: cwdNorm || null,
        tool_name: tool,
        transport: toolLower.startsWith("mcp__") ? "mcp" : null,
        status: status || (errorText ? "error" : null),
        ok: status || errorText ? false : null,
        outcome,
        error: errorText || null,
        rejection_reason: rejectionText || null,
      },
    };
  }
  return null;
}

// Result-side stats for native read tools, merged into the completion
// observation via extraDetail. The request-side offset/limit alone cannot
// distinguish a full read of a small file from a default-window read of a
// large one; pricing "ATLAS vs raw reads" needs what actually came back.
const READ_RESULT_STATS_TYPES = new Set(["tool.read", "tool.chain_read"]);

export function nativeReadResultStats(tool, resultText) {
  try {
    const spec = TOOL_CATALOG[normalizeCatalogToolName(tool)]?.observation;
    if (!spec || !READ_RESULT_STATS_TYPES.has(spec.type)) return null;
    if (typeof resultText !== "string" || resultText === "" || /^Error:/i.test(resultText)) return null;
    resultText = stripHashRefSurfaceSuffix(resultText);
    const structured = _structuredReadStats(resultText);
    if (structured) return structured;
    // Plain numbered-lines format: execReadFile appends "... (N more lines)"
    // when the window ends before the file does.
    const marker = /\n\.\.\. \((\d+) more lines\)$/.exec(resultText);
    let lines = 1;
    for (let i = 0; i < resultText.length; i += 1) {
      if (resultText.charCodeAt(i) === 10) lines += 1;
    }
    return {
      result_chars: resultText.length,
      result_lines: marker ? lines - 1 : lines,
      truncated: !!marker,
      ...(marker ? { remaining_lines: Number(marker[1]) } : {}),
    };
  } catch {
    return null;
  }
}

function _structuredReadStats(text) {
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || parsed.ok !== true) return null;
    if (typeof parsed.returnedLines !== "number" && typeof parsed.totalLines !== "number") return null;
    return {
      result_chars: text.length,
      ...(typeof parsed.returnedLines === "number" ? { result_lines: parsed.returnedLines } : {}),
      truncated: parsed.truncated === true,
      ...(typeof parsed.totalLines === "number" ? { total_lines: parsed.totalLines } : {}),
    };
  } catch {
    return null;
  }
}
