import { exactKeys, plainObject, fail } from "./report-schema.js";
import { AGENT_HANDOFF_PLANNER_METADATA_ENUMS, AGENT_HANDOFF_PLANNER_REPORT_METADATA_KEYS, AGENT_HANDOFF_PROFILES, AGENT_HANDOFF_RESEARCH_EVIDENCE_VALUES, AGENT_HANDOFF_RESEARCH_QUESTION_CATEGORIES, AGENT_HANDOFF_RESEARCH_USEFULNESS_VALUES, AGENT_HANDOFF_SCOPE_CONFIDENCE_VALUES } from "../../../../catalog/handoff.js";
import { detectSensitiveAgentHandoffText } from "../agent-handoff-boundaries.js";
import { recordHandoffSoftening } from "./field-diagnostics.js";
import { truncateCompletionProse } from "./shape-normalizer.js";
import { normalizeResearchSymbolSeeds } from "./research-symbols.js";

const RESEARCHER_PROFILES = new Set([AGENT_HANDOFF_PROFILES.RESEARCHER_PIPELINE, AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT]);
const HASH_REF_SELECTOR_RE = /^#[0-9a-z]{4,12}(?::L?[0-9]+-L?[0-9]+)?$/;




// Caps here are soft, as in agent-handoff-implementation.js: prose is
// truncated and lists are trimmed with a recorded softening rather than
// bouncing the whole handoff for another full-context turn. `exact` marks
// values that are only meaningful verbatim (paths, commands, enum members,
// ids, selectors); a shortened one would be a different value, so those
// keep the hard length limit.
function boundedString(value, label, max, { required = true, exact = false } = {}) {
  if (typeof value !== "string") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be a string`);
  let text = value.trim();
  if (required && !text) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is required`);
  if (text.length > max) {
    if (exact) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${max} characters`);
    recordHandoffSoftening(label, "text_truncated", { max, received: text.length });
    text = truncateCompletionProse(text, max);
  }
  const sensitiveLabel = detectSensitiveAgentHandoffText(text);
  if (sensitiveLabel) fail("AGENT_HANDOFF_SENSITIVE_CONTENT", `${label} contains sensitive content (${sensitiveLabel})`);
  return text;
}

function stringArray(value, label, maxItems = 50, maxChars = 1000, options = {}) {
  return boundedArray(value, label, maxItems)
    .map((entry, index) => boundedString(entry, `${label}[${index}]`, maxChars, options));
}

// Soft list cap: keep the leading entries and record the trim.
function boundedArray(value, label, maxItems) {
  if (!Array.isArray(value)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an array`);
  if (value.length <= maxItems) return value;
  recordHandoffSoftening(label, "list_trimmed", { max: maxItems, received: value.length });
  return value.slice(0, maxItems);
}

function enumString(value, label, allowed, maxChars = 80) {
  const normalized = boundedString(value, label, maxChars, { exact: true }).toLowerCase();
  if (!allowed.includes(normalized)) {
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
    ["key_symbols", "memories", "planner_file_priorities", "patterns", "scope_estimate", "absence_checks", "question_details", "verification_targets"],
    label,
  );
  const keySymbols = normalizeResearchSymbolSeeds(source.key_symbols, 12);

  const memories = boundedArray(source.memories, `${label}.memories`, 2).map((raw, index) => {
    const entry = exactKeys(raw, ["title", "content", "key_files", "key_symbols"], `${label}.memories[${index}]`);
    const memorySymbols = normalizeResearchSymbolSeeds(entry.key_symbols, 12);
    return {
      title: boundedString(entry.title, `${label}.memories[${index}].title`, 120),
      content: boundedString(entry.content, `${label}.memories[${index}].content`, 1200),
      key_files: entry.key_files == null ? [] : stringArray(entry.key_files, `${label}.memories[${index}].key_files`, 12, 500, { exact: true }),
      key_symbols: memorySymbols,
    };
  });

  // Rank is the 1-based array position; a different number is renumbered.
  let ranksRenumbered = 0;
  const plannerFilePriorities = boundedArray(source.planner_file_priorities, `${label}.planner_file_priorities`, 100).map((raw, index) => {
    const entry = exactKeys(raw, ["path", "rank", "usefulness", "evidence", "reason"], `${label}.planner_file_priorities[${index}]`);
    if (entry.rank !== index + 1) ranksRenumbered += 1;
    return {
      path: boundedString(entry.path, `${label}.planner_file_priorities[${index}].path`, 500, { exact: true }),
      rank: index + 1,
      usefulness: enumString(entry.usefulness, `${label}.planner_file_priorities[${index}].usefulness`, AGENT_HANDOFF_RESEARCH_USEFULNESS_VALUES),
      evidence: enumString(entry.evidence, `${label}.planner_file_priorities[${index}].evidence`, AGENT_HANDOFF_RESEARCH_EVIDENCE_VALUES),
      reason: boundedString(entry.reason, `${label}.planner_file_priorities[${index}].reason`, 240),
    };
  });

  if (ranksRenumbered > 0) {
    recordHandoffSoftening(`${label}.planner_file_priorities`, "ranks_renumbered", { count: ranksRenumbered });
  }

  const patternNames = new Set();
  const patterns = boundedArray(source.patterns, `${label}.patterns`, 50).map((raw, index) => {
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
      confidence: enumString(estimate.confidence, `${label}.scope_estimate.confidence`, AGENT_HANDOFF_SCOPE_CONFIDENCE_VALUES),
      likely_touch_count: estimate.likely_touch_count,
      unknowns: stringArray(estimate.unknowns, `${label}.scope_estimate.unknowns`),
      scope_reasons: stringArray(estimate.scope_reasons, `${label}.scope_estimate.scope_reasons`),
    };
  }

  let questionDetails = [];
  let absenceChecks = [];
  let verificationTargets = [];
  if (source.absence_checks != null) {
    absenceChecks = boundedArray(source.absence_checks, `${label}.absence_checks`, 20).map((raw, index) => {
      const entry = exactKeys(raw, ["claim", "query", "scope_roots", "evidence_ref", "result_count"], `${label}.absence_checks[${index}]`);
      const evidenceRef = boundedString(entry.evidence_ref, `${label}.absence_checks[${index}].evidence_ref`, 80, { exact: true });
      if (!HASH_REF_SELECTOR_RE.test(evidenceRef)) {
        fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.absence_checks[${index}].evidence_ref must be a hash-ref selector`);
      }
      if (entry.result_count !== 0) {
        fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.absence_checks[${index}].result_count must be 0 for a repository-absence claim`);
      }
      return {
        claim: boundedString(entry.claim, `${label}.absence_checks[${index}].claim`, 500),
        query: boundedString(entry.query, `${label}.absence_checks[${index}].query`, 500, { exact: true }),
        scope_roots: stringArray(entry.scope_roots, `${label}.absence_checks[${index}].scope_roots`, 20, 500, { exact: true }),
        evidence_ref: evidenceRef,
        result_count: entry.result_count,
      };
    });
  }
  if (source.question_details != null) {
    questionDetails = boundedArray(source.question_details, `${label}.question_details`, 50).map((raw, index) => {
      const entry = exactKeys(raw, ["id", "category", "question", "context", "impact"], `${label}.question_details[${index}]`);
      return {
        id: boundedString(entry.id, `${label}.question_details[${index}].id`, 40, { exact: true }),
        category: enumString(entry.category, `${label}.question_details[${index}].category`, AGENT_HANDOFF_RESEARCH_QUESTION_CATEGORIES),
        question: boundedString(entry.question, `${label}.question_details[${index}].question`, 1000),
        context: boundedString(entry.context, `${label}.question_details[${index}].context`, 1000),
        impact: boundedString(entry.impact, `${label}.question_details[${index}].impact`, 1000),
      };
    });
  }
  if (source.verification_targets != null) {
    verificationTargets = boundedArray(source.verification_targets, `${label}.verification_targets`, 20).flatMap((raw, index) => {
      const entry = exactKeys(raw, ["command", "reason", "files"], `${label}.verification_targets[${index}]`);
      // A command only works verbatim. These targets are advisory, so an
      // over-long one is left out rather than truncated or rejected.
      if (typeof entry.command === "string" && entry.command.trim().length > 1000) {
        recordHandoffSoftening(`${label}.verification_targets[${index}]`, "entry_dropped", {
          reason: "command exceeds 1000 characters",
          received: entry.command.trim().length,
        });
        return [];
      }
      return [{
        command: boundedString(entry.command, `${label}.verification_targets[${index}].command`, 1000, { exact: true }),
        reason: boundedString(entry.reason, `${label}.verification_targets[${index}].reason`, 1000),
        files: entry.files == null
          ? []
          : stringArray(entry.files, `${label}.verification_targets[${index}].files`, 20, 500, { exact: true }),
      }];
    });
  }

  return {
    key_symbols: keySymbols,
    memories,
    planner_file_priorities: plannerFilePriorities,
    patterns,
    ...(scopeEstimate == null ? {} : { scope_estimate: scopeEstimate }),
    ...(absenceChecks.length === 0 ? {} : { absence_checks: absenceChecks }),
    ...(questionDetails.length === 0 ? {} : { question_details: questionDetails }),
    ...(verificationTargets.length === 0 ? {} : { verification_targets: verificationTargets }),
  };
}

export function normalizePlannerReportMetadata(report, label, profile) {
  const present = AGENT_HANDOFF_PLANNER_REPORT_METADATA_KEYS.filter((key) => report[key] != null);
  if (present.length === 0) return {};
  if (profile !== AGENT_HANDOFF_PROFILES.PLANNER_PLAN) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${present[0]} is valid only for planner reports`);
  }
  const out = {};
  for (const [key, allowed] of Object.entries(AGENT_HANDOFF_PLANNER_METADATA_ENUMS)) {
    if (report[key] != null) out[key] = enumString(report[key], `${label}.${key}`, allowed);
  }
  if (report.risk != null) {
    if (!Number.isInteger(report.risk) || report.risk < 1 || report.risk > 5) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.risk must be an integer from 1 through 5`);
    }
    out.risk = report.risk;
  }
  if (report.risk_tags != null) out.risk_tags = stringArray(report.risk_tags, `${label}.risk_tags`, 20, 80, { exact: true });
  if (report.skills != null) out.skills = stringArray(report.skills, `${label}.skills`, 20, 100, { exact: true });
  if (report.skip_assessment != null) {
    if (typeof report.skip_assessment !== "boolean") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.skip_assessment must be a boolean`);
    out.skip_assessment = report.skip_assessment;
  }
  if (report.executed_by_planner != null) {
    if (typeof report.executed_by_planner !== "boolean") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.executed_by_planner must be a boolean`);
    out.executed_by_planner = report.executed_by_planner;
  }
  // The task's own verification command: never shortened, and not dropped
  // either, since the task would then run without the check it named.
  if (report.test_command != null) out.test_command = boundedString(report.test_command, `${label}.test_command`, 1000, { exact: true });
  if (report.tests_to_run != null) out.tests_to_run = stringArray(report.tests_to_run, `${label}.tests_to_run`, 24, 500, { exact: true });
  if (report.write_tests != null) {
    if (typeof report.write_tests !== "boolean") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.write_tests must be a boolean`);
    out.write_tests = report.write_tests;
  }
  return out;
}
