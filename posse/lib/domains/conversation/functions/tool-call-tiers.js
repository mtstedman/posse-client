// Tool-call facts and their two detail tiers (posse.agent_conversation.v1 §3.2).
//
// A call's facts are extracted once from its observation detail, never from
// the display `summary` (which embeds edit snippets, commands, patterns, URLs
// and queries). Facts are local-tier bounded and are what agent_tool_groups
// persists; renderCallItem then fills only the fields a tier may carry.
// remote: tool label, repo-relative path or symbol, URL host, status, duration.
// local:  adds range/edit count, search pattern, scrubbed command, Atlas hint,
//         URL path, web query, and error text.
import path from "node:path";

import {
  AGENT_CONVERSATION_BOUNDS as BOUNDS,
  AGENT_CONVERSATION_LOCAL_BOUNDS as LOCAL_BOUNDS,
  AGENT_CONVERSATION_TIER,
} from "../../../catalog/agent-conversation.js";
import { TOOL_CATALOG } from "../../../shared/tools/functions/tool-descriptors.js";
import { formatAtlasToolDisplayName } from "../../../shared/tools/functions/mcp-surface.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { redactBridgeValue } from "../../bridge/functions/redaction.js";

export const TOOL_FAMILIES = Object.freeze({
  FILE: "file",
  EDIT: "edit",
  SEARCH: "search",
  COMMAND: "command",
  ATLAS: "atlas",
  WEB_FETCH: "web_fetch",
  WEB_SEARCH: "web_search",
  GENERIC: "generic",
});

const FORMAT_FAMILY = Object.freeze({
  file: TOOL_FAMILIES.FILE,
  chain_verdict: TOOL_FAMILIES.FILE,
  resize_image: TOOL_FAMILIES.FILE,
  reencode_image: TOOL_FAMILIES.FILE,
  generate_image: TOOL_FAMILIES.FILE,
  artifact_output: TOOL_FAMILIES.FILE,
  move_copy: TOOL_FAMILIES.FILE,
  edit: TOOL_FAMILIES.EDIT,
  list: TOOL_FAMILIES.SEARCH,
  search: TOOL_FAMILIES.SEARCH,
  command: TOOL_FAMILIES.COMMAND,
  generic: TOOL_FAMILIES.GENERIC,
});

const SPEC_BY_TYPE = new Map(Object.values(TOOL_CATALOG)
  .filter((entry) => entry?.observation?.type)
  .map((entry) => [entry.observation.type, { ...entry.observation, name: entry.name }]));
const SPEC_BY_NAME = new Map(Object.values(TOOL_CATALOG)
  .filter((entry) => entry?.observation?.type)
  .map((entry) => [entry.name, { ...entry.observation, name: entry.name }]));

const PROVIDER_SPECS = Object.freeze({
  "tool.web_fetch": { label: "WebFetch", family: TOOL_FAMILIES.WEB_FETCH },
  "tool.web_search": { label: "WebSearch", family: TOOL_FAMILIES.WEB_SEARCH },
  "tool.multiedit": { label: "MultiEdit", family: TOOL_FAMILIES.EDIT },
  "tool.apply_patch": { label: "apply_patch", family: TOOL_FAMILIES.EDIT },
});

const WRAPPER_PROGRAMS = new Set(["sudo", "env", "time", "nice", "nohup", "timeout", "command", "exec", "xargs"]);
const VERDICT_WORD = /^[a-z][a-z_-]{0,19}$/u;

export function boundedText(value, maxChars) {
  if (value == null) return null;
  const text = String(redactBridgeValue(String(value)))
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…` : text;
}

function scrubbedText(value, maxChars) {
  if (value == null || value === "") return null;
  return boundedText(scrubSecretText(String(value)), maxChars);
}

function posix(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function isAbsolutePath(value) {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

/**
 * Repository-relative form of an observed path. Absolute paths outside the
 * job's working directory keep only their basename, so no tier ever carries
 * an absolute path.
 */
export function repoRelativePath(rawPath, rawCwd = null) {
  const target = posix(rawPath).trim();
  if (!target) return null;
  const cwd = posix(rawCwd).trim().replace(/\/+$/u, "");
  if (isAbsolutePath(target)) {
    if (cwd && (target === cwd || target.startsWith(`${cwd}/`))) {
      return target.slice(cwd.length).replace(/^\/+/u, "") || ".";
    }
    const base = path.posix.basename(target);
    return base ? `…/${base}` : null;
  }
  return target.replace(/^(?:\.\/)+/u, "") || ".";
}

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (first) return first;
      continue;
    }
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Program basename of a shell command, skipping env assignments and wrappers. */
export function commandProgram(command) {
  const tokens = String(command ?? "").trim().split(/\s+/u).filter(Boolean);
  for (const raw of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(raw)) continue;
    const token = raw.replace(/^["'(]+|["');]+$/gu, "");
    const base = path.posix.basename(posix(token));
    if (!base || WRAPPER_PROGRAMS.has(base) || base.startsWith("-")) continue;
    return /^[A-Za-z0-9._+-]{1,40}$/u.test(base) ? base : "command";
  }
  return null;
}

function urlParts(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return { host: url.host || null, page: `${url.origin}${url.pathname}` };
  } catch {
    return null;
  }
}

function catalogSpec(type, detail) {
  const name = String(detail?.catalog_name || "").trim();
  if (name && SPEC_BY_NAME.has(name)) return SPEC_BY_NAME.get(name);
  return SPEC_BY_TYPE.get(type) || null;
}

function symbolLabel(ref) {
  if (typeof ref === "string") return ref.trim() || null;
  if (!ref || typeof ref !== "object") return null;
  return typeof ref.name === "string" && ref.name.trim() ? ref.name.trim() : null;
}

// Atlas file/symbol hint for the remote tier: never query, pattern, search,
// or task text.
function atlasRemoteHint(args, cwd) {
  if (!args || typeof args !== "object") return null;
  const file = firstText(args.file, args.filePath, args.path, args.paths, args.editedFiles, args.fileRelPaths);
  const fileLabel = file ? repoRelativePath(file, cwd) : null;
  const refs = Array.isArray(args.symbolRefs) ? args.symbolRefs : args.symbolRef ? [args.symbolRef] : [];
  const symbol = refs.map(symbolLabel).find(Boolean) || null;
  // A provider's own tool-use record carries the agent-facing `names`; an
  // owner observation carries the execution field they fold onto.
  const named = Array.isArray(args.identifiersToFind) ? args.identifiersToFind : args.names;
  const identifiers = Array.isArray(named)
    ? named.filter((entry) => typeof entry === "string" && /^[A-Za-z_$][\w$.:]*$/u.test(entry.trim()))
    : [];
  const symbolText = symbol
    ? `${symbol}${refs.length > 1 ? ` +${refs.length - 1}` : ""}`
    : identifiers.length > 0
      ? `${identifiers.slice(0, 3).join(", ")}${identifiers.length > 3 ? ` +${identifiers.length - 3}` : ""}`
      : null;
  const ids = Array.isArray(args.symbolIds) ? args.symbolIds.length
    : args.symbolId ? 1
      : Array.isArray(args.symbols) && !fileLabel ? args.symbols.length : 0;
  const parts = [symbolText, fileLabel].filter(Boolean);
  if (parts.length > 0) return parts.join(" @ ");
  return ids > 0 ? `${ids} symbol target${ids === 1 ? "" : "s"}` : null;
}

function genericLocalTarget(spec, detail) {
  const input = detail?.input && typeof detail.input === "object" ? detail.input : {};
  const values = (spec?.targetKeys || [])
    .map((key) => input[key])
    .filter((value) => value != null && (typeof value !== "object"))
    .map((value) => String(value));
  return values.length > 0 ? values.join(" · ") : null;
}

/**
 * Extract a call's bounded facts from its observation row. `row.detail` is the
 * parsed detail object. Returns null for rows that are not tool calls.
 */
export function toolCallFacts(row) {
  const type = String(row?.observation_type || "");
  const detail = row?.detail && typeof row.detail === "object" ? row.detail : {};
  const baseType = type.endsWith(".not_found") ? type.slice(0, -".not_found".length) : type;
  const cwd = typeof detail.cwd === "string" ? detail.cwd : null;
  const facts = {
    tool: null,
    family: TOOL_FAMILIES.GENERIC,
    path: null,
    range: null,
    edit_count: null,
    pattern: null,
    program: null,
    command: null,
    host: null,
    url: null,
    query: null,
    atlas_hint: null,
    atlas_local_hint: null,
    verdict: null,
    generic_target: null,
  };

  if (baseType === "tool.atlas") {
    const action = String(detail.action || "").trim();
    facts.family = TOOL_FAMILIES.ATLAS;
    facts.tool = formatAtlasToolDisplayName(action) || "atlas";
    facts.atlas_hint = atlasRemoteHint(detail.args, cwd);
    facts.atlas_local_hint = detail.args && typeof detail.args === "object" ? detail.args : null;
    facts.atlas_action = action || null;
  } else if (PROVIDER_SPECS[baseType]) {
    const provider = PROVIDER_SPECS[baseType];
    facts.tool = provider.label;
    facts.family = provider.family;
    if (provider.family === TOOL_FAMILIES.WEB_FETCH) {
      const parts = urlParts(detail.url);
      facts.host = parts?.host || null;
      facts.url = parts?.page || null;
    } else if (provider.family === TOOL_FAMILIES.WEB_SEARCH) {
      facts.query = detail.query == null ? null : String(detail.query);
    } else {
      facts.path = repoRelativePath(detail.file_path || detail.path, cwd);
      facts.edit_count = Number.isSafeInteger(detail.edit_count) ? detail.edit_count : null;
    }
  } else {
    const spec = catalogSpec(baseType, detail);
    if (!spec && !baseType.startsWith("tool.")) return null;
    facts.tool = spec?.label || baseType.replace(/^tool\./u, "");
    facts.family = FORMAT_FAMILY[spec?.format] || TOOL_FAMILIES.GENERIC;
    if (spec?.format === "move_copy") {
      const from = repoRelativePath(detail.source, cwd);
      const to = repoRelativePath(detail.destination, cwd);
      facts.path = [from, to].filter(Boolean).join(" → ") || null;
    } else if (spec?.format === "artifact_output") {
      facts.path = repoRelativePath(detail.output_root, cwd);
    } else if (spec?.format === "generate_image") {
      facts.path = repoRelativePath(detail.filename, cwd);
    } else if (facts.family !== TOOL_FAMILIES.COMMAND && facts.family !== TOOL_FAMILIES.GENERIC) {
      facts.path = repoRelativePath(detail.path || detail.file_path, cwd);
    }
    if (spec?.includeRange && Number.isSafeInteger(detail.offset) && Number.isSafeInteger(detail.limit)
      && (detail.offset !== 1 || detail.limit !== 2000)) {
      facts.range = `${detail.offset}+${detail.limit}`;
    }
    if (Number.isSafeInteger(detail.edit_count)) facts.edit_count = detail.edit_count;
    if (facts.family === TOOL_FAMILIES.SEARCH && detail.pattern != null) facts.pattern = String(detail.pattern);
    if (facts.family === TOOL_FAMILIES.COMMAND) {
      const command = scrubSecretText(String(detail.command || ""));
      facts.program = commandProgram(command);
      facts.command = command || null;
    }
    if (spec?.format === "chain_verdict" && VERDICT_WORD.test(String(detail.verdict || ""))) {
      facts.verdict = String(detail.verdict);
    }
    if (facts.family === TOOL_FAMILIES.GENERIC) facts.generic_target = genericLocalTarget(spec, detail);
  }
  return {
    tool: boundedText(facts.tool, BOUNDS.TOOL_LABEL_CHARS) || "tool",
    family: facts.family,
    path: boundedText(facts.path, BOUNDS.CALL_TARGET_CHARS),
    range: boundedText(facts.range, 40),
    edit_count: facts.edit_count,
    pattern: scrubbedText(facts.pattern, LOCAL_BOUNDS.PATTERN_CHARS),
    program: boundedText(facts.program, BOUNDS.TOOL_LABEL_CHARS),
    command: scrubbedText(facts.command, LOCAL_BOUNDS.COMMAND_CHARS),
    host: boundedText(facts.host, BOUNDS.CALL_TARGET_CHARS),
    url: scrubbedText(facts.url, BOUNDS.CALL_TARGET_CHARS),
    query: scrubbedText(facts.query, LOCAL_BOUNDS.QUERY_CHARS),
    atlas_hint: boundedText(facts.atlas_hint, BOUNDS.CALL_TARGET_CHARS),
    atlas_local_hint: facts.family === TOOL_FAMILIES.ATLAS
      ? scrubbedText(localAtlasHint(facts.atlas_local_hint, facts.atlas_action), LOCAL_BOUNDS.ATLAS_HINT_CHARS)
      : null,
    verdict: facts.verdict,
    generic_target: scrubbedText(facts.generic_target, BOUNDS.CALL_TARGET_CHARS),
    error: scrubbedText(detail.rejection_reason || detail.error, BOUNDS.CALL_ERROR_CHARS),
  };
}

// The local tier may name what Atlas searched for; it never leaves the machine.
function localAtlasHint(args, action) {
  if (!args || typeof args !== "object") return null;
  const query = firstText(args.query, args.pattern, args.search);
  const hint = atlasRemoteHint(args, null);
  const parts = [query ? `"${query}"` : null, hint].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  const task = firstText(args.taskText);
  return task ? String(task).split(/\r?\n/u)[0] : action;
}

function remoteTarget(facts) {
  switch (facts.family) {
    case TOOL_FAMILIES.FILE:
    case TOOL_FAMILIES.EDIT:
    case TOOL_FAMILIES.SEARCH:
      return [facts.path, facts.verdict ? `→ ${facts.verdict}` : null].filter(Boolean).join(" ") || null;
    case TOOL_FAMILIES.COMMAND:
      return facts.program;
    case TOOL_FAMILIES.ATLAS:
      return facts.atlas_hint;
    case TOOL_FAMILIES.WEB_FETCH:
      return facts.host;
    case TOOL_FAMILIES.WEB_SEARCH:
      return null;
    default:
      return facts.verdict;
  }
}

function localTarget(facts) {
  switch (facts.family) {
    case TOOL_FAMILIES.FILE:
      return [facts.path, facts.range ? `[${facts.range}]` : null, facts.verdict ? `→ ${facts.verdict}` : null]
        .filter(Boolean).join(" ") || null;
    case TOOL_FAMILIES.EDIT:
      return [facts.path, facts.edit_count != null ? `(${facts.edit_count} edit${facts.edit_count === 1 ? "" : "s"})` : null]
        .filter(Boolean).join(" ") || null;
    case TOOL_FAMILIES.SEARCH:
      return [facts.path, facts.pattern ? `(${facts.pattern})` : null].filter(Boolean).join(" ") || null;
    case TOOL_FAMILIES.COMMAND:
      return facts.command || facts.program;
    case TOOL_FAMILIES.ATLAS:
      return facts.atlas_local_hint || facts.atlas_hint;
    case TOOL_FAMILIES.WEB_FETCH:
      return facts.url || facts.host;
    case TOOL_FAMILIES.WEB_SEARCH:
      return facts.query;
    default:
      return [facts.generic_target, facts.verdict].filter(Boolean).join(" · ") || null;
  }
}

/** Wire `call` item for one tier. Both tiers carry the same keys. */
export function renderCallItem(item, tier) {
  const local = tier === AGENT_CONVERSATION_TIER.LOCAL;
  const facts = item.facts || {};
  return {
    type: "call",
    seq: item.seq,
    tool: boundedText(facts.tool, BOUNDS.TOOL_LABEL_CHARS) || "tool",
    target: boundedText(local ? localTarget(facts) : remoteTarget(facts), BOUNDS.CALL_TARGET_CHARS),
    status: item.status,
    benign: item.benign === true,
    duration_ms: item.duration_ms ?? null,
    at: item.at,
    timing: item.timing,
    error: local ? facts.error ?? null : null,
  };
}
