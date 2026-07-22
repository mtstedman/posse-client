import { DEV_MODE_ORDER } from "../../../../shared/policies/functions/dev-modes.js";
import { detectSensitiveAgentHandoffText } from "../agent-handoff-boundaries.js";

export const PLANNER_REPORT_METADATA_KEYS = Object.freeze([
  "dev_mode",
  "risk",
  "risk_tags",
  "scope_confidence",
  "skills",
  "deepthink_budget",
  "model_tier",
  "reasoning_effort",
  "priority",
  "skip_assessment",
  "test_command",
]);

const RESEARCHER_PROFILES = new Set(["researcher.pipeline.v1", "researcher.report.v1"]);
const ATLAS_SYMBOL_ID_RE = /^[0-9a-f]{64}:[0-9]+$/;
const PLANNER_METADATA_ENUMS = Object.freeze({
  dev_mode: new Set(DEV_MODE_ORDER),
  scope_confidence: new Set(["high", "medium", "low"]),
  deepthink_budget: new Set(["low", "normal", "high", "xhigh"]),
  model_tier: new Set(["cheap", "standard", "strong"]),
  reasoning_effort: new Set(["low", "medium", "high"]),
  priority: new Set(["low", "normal", "high", "urgent"]),
});
const RESEARCH_USEFULNESS = new Set(["primary", "supporting", "context", "low"]);
const RESEARCH_EVIDENCE = new Set(["audited_file_read", "atlas", "search", "prior_research", "web"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const QUESTION_CATEGORIES = new Set(["data-handling", "security", "convention", "config", "unclear-pattern"]);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, allowed, label) {
  const object = plainObject(value);
  if (!object) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an object`);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${key} is not allowed`);
  }
  return object;
}

function boundedString(value, label, max, { required = true } = {}) {
  if (typeof value !== "string") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be a string`);
  const text = value.trim();
  if (required && !text) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is required`);
  if (text.length > max) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${max} characters`);
  if (/#[0-9a-z]{4,12}\b/i.test(text)) {
    fail("AGENT_HANDOFF_REF_OUTSIDE_SELECTOR", `${label} contains a hash ref outside an evidence selector`);
  }
  const sensitiveLabel = detectSensitiveAgentHandoffText(text);
  if (sensitiveLabel) fail("AGENT_HANDOFF_SENSITIVE_CONTENT", `${label} contains sensitive content (${sensitiveLabel})`);
  return text;
}

function stringArray(value, label, maxItems = 50, maxChars = 1000) {
  if (!Array.isArray(value)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an array`);
  if (value.length > maxItems) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${maxItems} items`);
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, maxChars));
}

function enumString(value, label, allowed, maxChars = 80) {
  const normalized = boundedString(value, label, maxChars).toLowerCase();
  if (!allowed.has(normalized)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be one of: ${[...allowed].join(", ")}`);
  }
  return normalized;
}

export function structuredStringLength(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + structuredStringLength(entry), 0);
  if (plainObject(value)) {
    return Object.values(value).reduce((sum, entry) => sum + structuredStringLength(entry), 0);
  }
  return 0;
}

export function normalizeResearchData(value, label, profile) {
  if (value == null) return null;
  if (!RESEARCHER_PROFILES.has(profile)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is valid only for researcher profiles`);
  }
  const source = exactKeys(
    value,
    ["key_symbols", "memories", "planner_file_priorities", "patterns", "scope_estimate", "question_details"],
    label,
  );
  const keySymbols = stringArray(source.key_symbols, `${label}.key_symbols`, 12, 80);
  for (const [index, symbolId] of keySymbols.entries()) {
    if (!ATLAS_SYMBOL_ID_RE.test(symbolId)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.key_symbols[${index}] must be an opaque ATLAS symbol ID`);
    }
  }

  if (!Array.isArray(source.memories) || source.memories.length > 2) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.memories must be an array with at most 2 entries`);
  }
  const memories = source.memories.map((raw, index) => {
    const entry = exactKeys(raw, ["title", "content", "key_files", "key_symbols"], `${label}.memories[${index}]`);
    const memorySymbols = entry.key_symbols == null
      ? []
      : stringArray(entry.key_symbols, `${label}.memories[${index}].key_symbols`, 12, 80);
    for (const [symbolIndex, symbolId] of memorySymbols.entries()) {
      if (!ATLAS_SYMBOL_ID_RE.test(symbolId)) {
        fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.memories[${index}].key_symbols[${symbolIndex}] must be an opaque ATLAS symbol ID`);
      }
    }
    return {
      title: boundedString(entry.title, `${label}.memories[${index}].title`, 120),
      content: boundedString(entry.content, `${label}.memories[${index}].content`, 1200),
      key_files: entry.key_files == null ? [] : stringArray(entry.key_files, `${label}.memories[${index}].key_files`, 12, 500),
      key_symbols: memorySymbols,
    };
  });

  if (!Array.isArray(source.planner_file_priorities) || source.planner_file_priorities.length > 100) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.planner_file_priorities must be an array with at most 100 entries`);
  }
  const plannerFilePriorities = source.planner_file_priorities.map((raw, index) => {
    const entry = exactKeys(raw, ["path", "rank", "usefulness", "evidence", "reason"], `${label}.planner_file_priorities[${index}]`);
    if (!Number.isInteger(entry.rank) || entry.rank !== index + 1) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.planner_file_priorities[${index}].rank must match its 1-based array position`);
    }
    return {
      path: boundedString(entry.path, `${label}.planner_file_priorities[${index}].path`, 500),
      rank: entry.rank,
      usefulness: enumString(entry.usefulness, `${label}.planner_file_priorities[${index}].usefulness`, RESEARCH_USEFULNESS),
      evidence: enumString(entry.evidence, `${label}.planner_file_priorities[${index}].evidence`, RESEARCH_EVIDENCE),
      reason: boundedString(entry.reason, `${label}.planner_file_priorities[${index}].reason`, 240),
    };
  });

  if (!Array.isArray(source.patterns) || source.patterns.length > 50) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.patterns must be an array with at most 50 entries`);
  }
  const patternNames = new Set();
  const patterns = source.patterns.map((raw, index) => {
    const entry = exactKeys(raw, ["name", "description"], `${label}.patterns[${index}]`);
    const name = boundedString(entry.name, `${label}.patterns[${index}].name`, 80);
    if (patternNames.has(name)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.patterns names must be unique`);
    patternNames.add(name);
    return {
      name,
      description: boundedString(entry.description, `${label}.patterns[${index}].description`, 500),
    };
  });

  let scopeEstimate = null;
  if (source.scope_estimate != null) {
    const estimate = exactKeys(source.scope_estimate, ["confidence", "likely_touch_count", "unknowns", "scope_reasons"], `${label}.scope_estimate`);
    if (!Number.isInteger(estimate.likely_touch_count) || estimate.likely_touch_count < 0 || estimate.likely_touch_count > 1000) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.scope_estimate.likely_touch_count must be an integer from 0 through 1000`);
    }
    scopeEstimate = {
      confidence: enumString(estimate.confidence, `${label}.scope_estimate.confidence`, CONFIDENCE),
      likely_touch_count: estimate.likely_touch_count,
      unknowns: stringArray(estimate.unknowns, `${label}.scope_estimate.unknowns`),
      scope_reasons: stringArray(estimate.scope_reasons, `${label}.scope_estimate.scope_reasons`),
    };
  }

  let questionDetails = [];
  if (source.question_details != null) {
    if (!Array.isArray(source.question_details) || source.question_details.length > 50) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.question_details must be an array with at most 50 entries`);
    }
    questionDetails = source.question_details.map((raw, index) => {
      const entry = exactKeys(raw, ["id", "category", "question", "context", "impact"], `${label}.question_details[${index}]`);
      return {
        id: boundedString(entry.id, `${label}.question_details[${index}].id`, 40),
        category: enumString(entry.category, `${label}.question_details[${index}].category`, QUESTION_CATEGORIES),
        question: boundedString(entry.question, `${label}.question_details[${index}].question`, 1000),
        context: boundedString(entry.context, `${label}.question_details[${index}].context`, 1000),
        impact: boundedString(entry.impact, `${label}.question_details[${index}].impact`, 1000),
      };
    });
  }

  return {
    key_symbols: keySymbols,
    memories,
    planner_file_priorities: plannerFilePriorities,
    patterns,
    ...(scopeEstimate == null ? {} : { scope_estimate: scopeEstimate }),
    ...(questionDetails.length === 0 ? {} : { question_details: questionDetails }),
  };
}

export function normalizePlannerReportMetadata(report, label, profile) {
  const present = PLANNER_REPORT_METADATA_KEYS.filter((key) => report[key] != null);
  if (present.length === 0) return {};
  if (profile !== "planner.plan.v1") {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${present[0]} is valid only for planner reports`);
  }
  const out = {};
  for (const [key, allowed] of Object.entries(PLANNER_METADATA_ENUMS)) {
    if (report[key] != null) out[key] = enumString(report[key], `${label}.${key}`, allowed);
  }
  if (report.risk != null) {
    if (!Number.isInteger(report.risk) || report.risk < 1 || report.risk > 5) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.risk must be an integer from 1 through 5`);
    }
    out.risk = report.risk;
  }
  if (report.risk_tags != null) out.risk_tags = stringArray(report.risk_tags, `${label}.risk_tags`, 20, 80);
  if (report.skills != null) out.skills = stringArray(report.skills, `${label}.skills`, 20, 100);
  if (report.skip_assessment != null) {
    if (typeof report.skip_assessment !== "boolean") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.skip_assessment must be a boolean`);
    out.skip_assessment = report.skip_assessment;
  }
  if (report.test_command != null) out.test_command = boundedString(report.test_command, `${label}.test_command`, 1000);
  return out;
}
