// Native deterministic-MCP tool schema definitions (pure data).
//
// Canonical JSON Schemas for the in-tree deterministic tools. Per the catalog
// contract this file holds pure data only. Its protocol enum values are
// imported from sibling catalogs so schemas and runtime validation cannot
// drift. The assembled
// catalog, role allowlists, and contract rendering that consume these schemas
// live in
// lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js.

import {
  AGENT_HANDOFF_PROTOCOL,
  AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY,
} from "./handoff.js";
import { SUB_AGENT_PROTOCOL } from "./sub-agent.js";
import { WEB_RESEARCH_PROTOCOL } from "./web-research.js";

// Compatibility facade. Existing consumers retain this path while catalog
// families can be imported directly by new, bounded owners.
export { WORK_ITEM_QUESTION_CHOICE_IDS } from "./tools/interaction.js";

export const TOOL_READ_FILE = {
  type: "function",
  name: "read_file",
  description:
    "Read the contents of a file. Returns numbered lines for precise references. " +
    "Use offset/limit for large files. Optional search/jsonPath/maxBytes returns a structured JSON result.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to working directory)" },
      offset: { type: "integer", description: "Starting line number, 1-based. Default: 1" },
      limit: { type: "integer", description: "Maximum number of lines to read. Default: 2000 outside the Atlas-first source gate. Under the active gate, non-indexed reads default to and are capped at 250; changed/unavailable indexed escape reads retain the native reader bounds." },
      maxBytes: { type: "integer", description: "Maximum bytes to return in structured mode." },
      search: { type: "string", maxLength: 200, description: "Case-insensitive regex pattern to search within the selected line range. Unsafe nested-quantifier patterns are treated as literal text; results are capped at 100 matches." },
      searchContext: { type: "integer", minimum: 0, description: "Context lines around each search match in structured mode. Used only with search; default 2." },
      jsonPath: { type: "string", description: "Dot-separated JSON path to extract from a JSON file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_WRITE_FILE = {
  type: "function",
  name: "write_file",
  description:
    "Create a file or replace its full contents, with optional executable permissions. This " +
    "compatibility capability supports dynamic artifact creation. Code dev/fix jobs receive " +
    "pre-materialized create targets through their scoped mutation surface.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full content to write to the file" },
      executable: {
        type: "boolean",
        description: "Set or clear the file's executable permission bits after writing. Omit to preserve the existing/default mode.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

function exclusiveEditMode(...fields) {
  const allowed = ["path", ...fields];
  return {
    type: "object",
    properties: Object.fromEntries(allowed.map((name) => [name, {}])),
    required: allowed,
    additionalProperties: false,
  };
}

export const TOOL_EDIT_FILE = {
  type: "function",
  name: "edit_file",
  description:
    "Edit an existing file within the allowed scope. Provide exactly one mode: exact old_string/new_string, " +
    "replaceLines, replacePattern, insertAt, append, jsonPath/jsonValue, or executable.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Exact text to find (must be unique in file)" },
      new_string: { type: "string", description: "Replacement text" },
      replaceLines: {
        type: "object",
        description: "Replace a 1-based inclusive line range [start, end] with content. Line numbers use the numbered-file output convention.",
        properties: {
          start: { type: "integer", minimum: 1, description: "1-based start line, inclusive" },
          end: { type: "integer", minimum: 1, description: "1-based end line, inclusive" },
          content: { type: "string", description: "Replacement content" },
        },
        required: ["start", "end", "content"],
        additionalProperties: false,
      },
      replacePattern: {
        type: "object",
        description: "Replace a regex match. Patterns are case-sensitive; global=false requires a unique match. Patterns longer than 500 characters or with unsafe nested quantifiers are rejected. Replacement uses JavaScript replacement syntax ($1, $$).",
        properties: {
          pattern: { type: "string", minLength: 1, maxLength: 500, description: "Regex pattern to replace. Unsafe nested quantifiers are rejected." },
          replacement: { type: "string", description: "Replacement text. Supports JavaScript replacement tokens such as $1 for capture groups and $$ for a literal dollar sign." },
          global: { type: "boolean", description: "Replace all matches. Default: false" },
        },
        required: ["pattern", "replacement"],
        additionalProperties: false,
      },
      insertAt: {
        type: "object",
        description: "Insert content before a 1-based line number. Use line_count + 1 to insert after the last line.",
        properties: {
          line: { type: "integer", minimum: 1, description: "1-based insertion line" },
          content: { type: "string", description: "Content to insert" },
        },
        required: ["line", "content"],
        additionalProperties: false,
      },
      append: { type: "string", description: "Content to append to the file." },
      jsonPath: { type: "string", description: "Dot-separated JSON path to update." },
      jsonValue: { description: "Value to write when jsonPath is used." },
      executable: {
        type: "boolean",
        description: "Set or clear the file's executable permission bits without changing its content.",
      },
    },
    required: ["path"],
    oneOf: [
      exclusiveEditMode("old_string", "new_string"),
      exclusiveEditMode("replaceLines"),
      exclusiveEditMode("replacePattern"),
      exclusiveEditMode("insertAt"),
      exclusiveEditMode("append"),
      exclusiveEditMode("jsonPath", "jsonValue"),
      exclusiveEditMode("executable"),
    ],
    additionalProperties: false,
  },
};

// Internal-only coordination primitive. It is deliberately present in the
// canonical catalog so every runtime can execute the same operation, but its
// tool-suite declaration advertises it on no transport. Out-of-scope mutation
// handlers invoke it themselves; agents do not spend a second tool call asking
// for the scope they just demonstrated they need.
export const TOOL_REQUEST_SCOPE = {
  type: "function",
  name: "request_scope",
  description:
    "Pause the current job and request human approval for one exact file path outside its writable scope.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Exact repository-relative file path that needs writable scope.",
      },
      access: {
        type: "string",
        enum: ["modify", "create"],
        description: "Whether the job needs permission to modify an existing file or create a new file.",
      },
      operation: {
        type: "string",
        enum: ["write_file", "edit_file"],
        description: "Mutation that encountered the scope boundary.",
      },
      reason: {
        type: "string",
        description: "Short explanation of why this path is required for the current task.",
      },
    },
    required: ["path", "access", "operation"],
    additionalProperties: false,
  },
};

export { ARTIFICER_COMPLETION_STATUSES, DEV_COMPLETION_STATUSES } from "./tools/interaction.js";
import { ARTIFICER_COMPLETION_STATUSES, DEV_COMPLETION_STATUSES } from "./tools/interaction.js";

const COMPLETION_FILE_REQUEST = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, maxLength: 500 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
  required: ["path", "reason"],
  additionalProperties: false,
};

const TERMINAL_COMPLETION_PARAMETERS = {
  type: "object",
  description:
    "Dev/fix and artificer completion form. Omit status for COMPLETE. Other statuses require their matching semantic field; the runtime derives the profile, target, and deterministic evidence.",
  properties: {
    status: { type: "string", enum: DEV_COMPLETION_STATUSES, default: "COMPLETE" },
    no_change_rationale: { type: "string", minLength: 1, maxLength: 1000 },
    remaining_work: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
    blocker: { type: "string", minLength: 1, maxLength: 1000 },
    verification_unavailable: { type: "string", minLength: 1, maxLength: 1000 },
    evidence_gap: { type: "string", minLength: 1, maxLength: 1000 },
    file_requests: { type: "array", minItems: 1, maxItems: 16, items: COMPLETION_FILE_REQUEST },
  },
  additionalProperties: false,
};

const AGENT_HANDOFF_SYMBOL_SEED = {
  type: "string",
  maxLength: 300,
  description: "Opaque ATLAS symbol ID copied from an ATLAS result, or a language-level fully qualified symbol name. Malformed optional seeds are ignored.",
};

const AGENT_HANDOFF_RESEARCH_DATA = {
  type: "object",
  description: "Structured researcher metadata that the compatibility pipeline preserves for downstream planning and memory persistence.",
  properties: {
    key_symbols: { type: "array", maxItems: 12, items: AGENT_HANDOFF_SYMBOL_SEED },
    memories: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          content: { type: "string", minLength: 1, maxLength: 1200 },
          key_files: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
          key_symbols: { type: "array", maxItems: 12, items: AGENT_HANDOFF_SYMBOL_SEED },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
    },
    planner_file_priorities: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
          rank: { type: "integer", minimum: 1, maximum: 100, description: "One-based priority order; must equal this entry's position in the array." },
          usefulness: { type: "string", enum: ["primary", "supporting", "context", "low"] },
          evidence: { type: "string", enum: ["audited_file_read", "atlas", "search", "prior_research", "web"] },
          reason: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["path", "rank", "usefulness", "evidence", "reason"],
        additionalProperties: false,
      },
    },
    patterns: {
      type: "array",
      maxItems: 50,
      description: "Terminal array form of the fallback pattern-name to description object. Pattern names must be unique.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          description: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["name", "description"],
        additionalProperties: false,
      },
    },
    scope_estimate: {
      type: "object",
      properties: {
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        likely_touch_count: { type: "integer", minimum: 0, maximum: 1000 },
        unknowns: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
        scope_reasons: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
      },
      required: ["confidence", "likely_touch_count", "unknowns", "scope_reasons"],
      additionalProperties: false,
    },
    absence_checks: {
      type: "array",
      maxItems: 20,
      description: "Repository-absence claims backed by one exact repository-wide search receipt. Each check must match a claim with identical text, and that claim's evidence must select the same ref as evidence_ref. Omit when making no absence claim.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 500 },
          query: { type: "string", minLength: 1, maxLength: 500 },
          scope_roots: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
          evidence_ref: { type: "string", pattern: "^#[0-9a-z]{4,12}(?::L?[0-9]+-L?[0-9]+)?$" },
          result_count: { type: "integer", minimum: 0, maximum: 0, description: "Zero, confirming that the repository-wide search found no results." },
        },
        required: ["claim", "query", "scope_roots", "evidence_ref", "result_count"],
        additionalProperties: false,
      },
    },
    question_details: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 40 },
          category: { type: "string", enum: ["data-handling", "security", "convention", "config", "unclear-pattern"] },
          question: { type: "string", minLength: 1, maxLength: 1000 },
          context: { type: "string", minLength: 1, maxLength: 1000 },
          impact: { type: "string", minLength: 1, maxLength: 1000 },
        },
        required: ["id", "category", "question", "context", "impact"],
        additionalProperties: false,
      },
    },
    verification_targets: {
      type: "array",
      maxItems: 20,
      description: "Existing repository-declared commands that directly verify a researched risk or behavior and are ready for the planner to preserve.",
      items: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: 1000 },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          files: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
        },
        required: ["command", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["key_symbols", "memories", "planner_file_priorities", "patterns"],
  additionalProperties: false,
};

const AGENT_HANDOFF_PLANNER_REPORT_FIELDS = {
  dev_mode: {
    type: "string",
    enum: ["feature_impl", "bug_fix", "defensive_change", "refactor", "cleanup", "hotfix"],
  },
  risk: { type: "integer", minimum: 1, maximum: 5 },
  risk_tags: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
  scope_confidence: { type: "string", enum: ["high", "medium", "low"] },
  skills: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 100 } },
  deepthink_budget: { type: "string", enum: ["low", "normal", "high", "xhigh"] },
  model_tier: { type: "string", enum: ["cheap", "standard", "strong"] },
  reasoning_effort: { type: "string", enum: ["low", "medium", "high"] },
  priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
  skip_assessment: { type: "boolean" },
  test_command: { type: "string", minLength: 1, maxLength: 1000 },
};

function forbidAgentHandoffScopeFields(fields) {
  return {
    properties: {
      handoffs: {
        items: {
          properties: {
            report: {
              properties: {
                scope: {
                  not: { anyOf: fields.map((field) => ({ required: [field] })) },
                },
              },
            },
          },
        },
      },
    },
  };
}

const AGENT_HANDOFF_PLANNER_TASK_REQUIREMENTS = {
  properties: {
    handoffs: {
      items: {
        allOf: [{
          if: {
            properties: {
              target: {
                properties: { kind: { const: "agent" } },
                required: ["kind"],
              },
            },
            required: ["target"],
          },
          then: {
            properties: {
              report: {
                properties: { success_criteria: { minItems: 1 } },
                required: ["success_criteria"],
              },
            },
          },
        }],
      },
    },
  },
};

const HANDOFF_REF = {
  type: "string",
  pattern: "^#[0-9a-z]{4,12}$",
  description: "Opaque stored evidence ref such as #a3f9.",
};

const HANDOFF_SELECTOR_STRING_PATTERN =
  "^(?:#[0-9a-z]{4,12}(?::L?[0-9]+-L?[0-9]+)?|[^#\\r\\n]+:L?[0-9]+(?:-L?[0-9]+)?)$";
const HANDOFF_REF_SELECTOR_STRING_PATTERN =
  "^#[0-9a-z]{4,12}(?::L?[0-9]+-L?[0-9]+)?$";
const ASSESSOR_HANDOFF_SELECTOR_STRING_PATTERN =
  "^(?:#[0-9a-z]{4,12}(?::L?[0-9]+-L?[0-9]+)?|[^#\\r\\n]+(?::L?[0-9]+(?:-L?[0-9]+)?)?)$";

function evidenceSelector({
  maxLineCount = 2000,
  description,
  allowPath = true,
} = {}) {
  const lines = {
    type: "object",
    description:
      "A 1-based source window for a path selector. For source-backed refs, start/count use source-file line numbers shown in gutters or source metadata, and the range must fit wholly within one recorded source window. " +
      "For materialized non-source refs, start/count address stored payload lines. Omitted lines on a ref object select the entire stored ref. An evidence_ref identifies already-visible text and should be cited directly; calling a traversal_ref first promotes that same identity to evidence.",
    properties: {
      start: { type: "integer", minimum: 1 },
      count: { type: "integer", minimum: 1, maximum: maxLineCount },
    },
    required: ["start", "count"],
    additionalProperties: false,
  };
  const selectorVariants = [
    {
      type: "string",
      pattern: allowPath
        ? HANDOFF_SELECTOR_STRING_PATTERN
        : HANDOFF_REF_SELECTOR_STRING_PATTERN,
      description: allowPath
        ? "A visible stored ref such as #abcd:23-40, or a surfaced file path such as src/x.js:23-40 (src/x.js:23 selects one line)."
        : "An immutable stored evidence ref returned by the child cursor, such as #abcd:23-40.",
    },
    {
      type: "object",
      properties: {
        ref: HANDOFF_REF,
        path: { type: "string" },
        lines,
      },
      required: ["ref"],
      additionalProperties: false,
    },
  ];
  if (allowPath) {
    selectorVariants.push({
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "An exact, uniquely suffixed, or uniquely basenamed canonical path already surfaced to this agent call.",
        },
        lines,
      },
      required: ["path", "lines"],
      additionalProperties: false,
    });
  }
  return {
    description,
    oneOf: selectorVariants,
  };
}

const HANDOFF_EVIDENCE_SELECTOR = evidenceSelector({
  description:
    "Select bounded evidence from a visible stored ref or an already-surfaced file path. Prefer slices of at most 40 lines and 4000 characters; 300 lines and 24000 characters per selector are compactness recommendations, not rejection gates. " +
    "For larger refs, select a tighter server-side source_ref slice when practical. Keep total evidence near 12000 characters; 32000 is the recommended non-child packet target. " +
    "The runtime accepts complete evidence up to hard safety ceilings of 2000 lines and 131072 characters per selector, and 196608 characters total. " +
    "The runtime derives storage, source, and authored provenance directly from every selector.",
});

const COMPACT_HANDOFF_SELECTOR = evidenceSelector({
  description:
    "Visible evidence selected by a stored ref such as #abcd:23-40, a surfaced path such as src/x.js:23-40, or the equivalent {path,lines} object. Use bare range numbers in canonical output.",
});

export const TOOL_AGENT_HANDOFF = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish the current agent turn with a terminal handoff. Dev/fix and artificer use the compact completion form; call agent_handoff() for normal COMPLETE. " +
    `Other roles submit ${AGENT_HANDOFF_PROTOCOL} with evidence selectors. Posse ends provider generation after acknowledging the receipt.`,
  parameters: {
    oneOf: [
      TERMINAL_COMPLETION_PARAMETERS,
      {
        type: "object",
        description: "Semantic report form for researcher, planner, assessor, and citation-synthesis roles. Legacy dev/artificer reports remain accepted during migration.",
        properties: {
      protocol: { type: "string", enum: [AGENT_HANDOFF_PROTOCOL] },
      profile: {
        type: "string",
        enum: [
          "researcher.pipeline.v1",
          "researcher.report.v1",
          "planner.plan.v1",
          "dev.result.v1",
          "artificer.result.v1",
          "assessor.verdict.v1",
          "citation_synthesis.v1",
        ],
      },
      outcome: {
        type: "string",
        enum: ["success", "complete", "partial", "gap", "input_required", "failed", "blocked", "pass", "fail", "needs_replan", "needs_review"],
        description:
          "Profile-specific outcome: researcher.pipeline.v1=success|gap|input_required; researcher.report.v1=complete; " +
          "planner.plan.v1=success; dev.result.v1 and artificer.result.v1=complete|failed|blocked; " +
          "assessor.verdict.v1=pass|fail|needs_replan|needs_review|blocked; citation_synthesis.v1=complete|partial|failed.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description:
          "Assessor-only confidence in the terminal verdict. Required for assessor.verdict.v1 and invalid for every other profile.",
      },
      handoffs: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 80, description: "Keep IDs at 40 characters or fewer when practical; 80 is the hard safety ceiling." },
            depends_on: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } },
            target: {
              type: "object",
              description:
                "Profile target: researcher.pipeline.v1, dev.result.v1, artificer.result.v1, and assessor.verdict.v1 use pipeline/$pipeline; " +
                "researcher.report.v1 uses result/$result; planner.plan.v1 uses agent/dev|artificer or system/promote; " +
                "planner.plan.v1 may also use system/human_input; citation_synthesis.v1 uses parent/$parent. For system/promote, put each exact repository destination file in report.scope.files_to_create or files_to_modify; Posse derives deterministic mappings.",
              properties: {
                kind: { type: "string", enum: ["agent", "system", "pipeline", "result", "parent"] },
                role: { type: "string", enum: ["dev", "artificer", "human_input", "promote", "$pipeline", "$result", "$parent"] },
              },
              required: ["kind"],
              additionalProperties: false,
            },
            intent: { type: "string", minLength: 1, maxLength: 1000 },
            report: {
              type: "object",
              description:
                "Allowed fields are summary, claims, scope, constraints, success_criteria, questions, research, planner execution metadata, and payload. " +
                "Omit payload or pass {}; put repository paths in scope and explanation in summary or claims.",
              properties: {
                summary: {
                  type: "string",
                  description:
                    "For researcher.report.v1, a compact wireframe that orders or connects the claims. Use as little prose as possible; claim detail and source excerpts stay in claims and evidence, while claim order supplies [E1], [E2], ... evidence labels. For researcher.pipeline.v1, the pipeline synthesis. Other profiles target 2000 characters or fewer and have a 4000-character safety ceiling.",
                },
                claims: {
                  type: "array",
                  maxItems: 12,
                  description:
                    "In researcher.report.v1, evidence-backed claims are the primary answer: put one self-contained finding in each claim and claim N supplies [EN]. Prefer the narrowest implementation-code evidence over documentation or inference when code is available. " +
                    'Exact tuple form: [["self-contained finding", {"evidence":["#ref:1-3", "src/x.js:23-40"], "decoy":[["#ref","reason"]]}]]. ' +
                    "The runtime resolves and range-validates evidence and decoy selectors and derives their provenance. Unsupported report candidates are moved into a marked summary note with no retry. " +
                    "Evidence accepts visible stored refs and already-surfaced file ranges in string or object form.",
                  items: {
                    type: "array",
                    minItems: 1,
                    maxItems: 2,
                    items: {
                      oneOf: [
                        { type: "string", minLength: 1, maxLength: 1000 },
                        {
                          type: "object",
                          properties: {
                            evidence: { type: "array", maxItems: 16, items: HANDOFF_EVIDENCE_SELECTOR },
                            decoy: { type: "array", maxItems: 8, items: { type: "array", minItems: 2, maxItems: 2 } },
                            prose: { type: "string", maxLength: 4000, description: "Target 2000 characters or fewer; 4000 is the hard safety ceiling." },
                          },
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                },
                scope: {
                  type: "object",
                  description:
                    "Planner task execution scope. Set task_mode to db only for a dev task whose entire write surface is the project database; db requires empty file arrays. Other agent task modes require writable file or create-root scope. A system/promote task requires exact destination files in files_to_create or files_to_modify.",
                  properties: {
                    task_mode: {
                      type: "string",
                      enum: ["code", "report", "content", "image", "intake_processing", "db"],
                      default: "code",
                    },
                    files_to_modify: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } },
                    files_to_create: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } },
                    files_to_delete: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } },
                    create_roots: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } },
                    output_root: { type: "string", maxLength: 500, description: "Planner-only output root. Invalid for non-planner profiles." },
                    key_files: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 }, description: "Researcher-only verified seed files. Invalid for non-researcher profiles." },
                    related_files: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 }, description: "Researcher-only related seed files. Invalid for non-researcher profiles." },
                  },
                  additionalProperties: false,
                },
                constraints: { type: "array", maxItems: 50, items: { type: "string", maxLength: 1000 } },
                success_criteria: { type: "array", maxItems: 50, items: { type: "string", maxLength: 1000 } },
                questions: { type: "array", maxItems: 50, items: { type: "string", maxLength: 1000 } },
                research: AGENT_HANDOFF_RESEARCH_DATA,
                ...AGENT_HANDOFF_PLANNER_REPORT_FIELDS,
                payload: {
                  type: "object",
                  description: "Reserved. Omit this field or pass an empty object.",
                  properties: {},
                  additionalProperties: false,
                },
              },
              required: ["summary"],
              additionalProperties: false,
            },
          },
          required: ["target", "report"],
          additionalProperties: false,
        },
        },
        },
        allOf: [
          {
            if: {
              properties: { profile: { not: { const: "researcher.report.v1" } } },
              required: ["profile"],
            },
            then: {
              properties: {
                handoffs: {
                  items: {
                    properties: {
                      report: {
                        properties: {
                          summary: { maxLength: 4000 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            if: {
              properties: { profile: { const: "researcher.report.v1" } },
              required: ["profile"],
            },
            then: {
              properties: {
                handoffs: {
                  items: {
                    properties: {
                      report: {
                        required: ["summary", "claims"],
                        properties: { claims: { minItems: 1 } },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            if: {
              properties: { profile: { const: "assessor.verdict.v1" } },
              required: ["profile"],
            },
            then: { required: ["confidence"] },
            else: { not: { required: ["confidence"] } },
          },
          {
            if: {
              properties: {
                profile: {
                  not: { enum: ["researcher.pipeline.v1", "researcher.report.v1"] },
                },
              },
              required: ["profile"],
            },
            then: forbidAgentHandoffScopeFields(["key_files", "related_files"]),
          },
          {
            if: {
              properties: { profile: { not: { const: "planner.plan.v1" } } },
              required: ["profile"],
            },
            then: forbidAgentHandoffScopeFields(["output_root"]),
          },
          {
            if: {
              properties: { profile: { const: "planner.plan.v1" } },
              required: ["profile"],
            },
            then: AGENT_HANDOFF_PLANNER_TASK_REQUIREMENTS,
          },
        ],
        required: ["protocol", "profile", "outcome", "handoffs"],
        additionalProperties: false,
      },
    ],
  },
};

// Providers receive one of these role projections so completion roles do not
// pay the prompt cost of the semantic report protocol. TOOL_AGENT_HANDOFF
// remains the permissive runtime/catalog schema for migration compatibility.
export const TOOL_AGENT_HANDOFF_DEV = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish dev/fix work. Call with no arguments for COMPLETE; use only the matching exceptional fields when work is unchanged, partial, blocked, unverified, or needs files. The receipt ends provider generation.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: DEV_COMPLETION_STATUSES, default: "COMPLETE" },
      no_change_rationale: { type: "string", minLength: 1, maxLength: 1000 },
      remaining_work: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
      blocker: { type: "string", minLength: 1, maxLength: 1000 },
      verification_unavailable: { type: "string", minLength: 1, maxLength: 1000 },
      file_requests: { type: "array", minItems: 1, maxItems: 16, items: COMPLETION_FILE_REQUEST },
    },
    additionalProperties: false,
  },
};

export const TOOL_AGENT_HANDOFF_ARTIFICER = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish artificer work. Call with no arguments for COMPLETE; use only the matching exceptional fields when work is partial, blocked, or has an evidence gap. The receipt ends provider generation.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ARTIFICER_COMPLETION_STATUSES, default: "COMPLETE" },
      remaining_work: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
      blocker: { type: "string", minLength: 1, maxLength: 1000 },
      evidence_gap: { type: "string", minLength: 1, maxLength: 1000 },
    },
    additionalProperties: false,
  },
};

const HANDOFF_DECOY = {
  type: "object",
  properties: {
    selector: COMPACT_HANDOFF_SELECTOR,
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["selector", "reason"],
  additionalProperties: false,
};

const HANDOFF_CLAIM = {
  type: "object",
  description:
    "One concise claim with evidence selected by bounded stored-ref or surfaced-file ranges.",
  properties: {
    claim: { type: "string", minLength: 1, maxLength: 240 },
    evidence: { type: "array", maxItems: 8, items: COMPACT_HANDOFF_SELECTOR },
    decoy: { type: "array", maxItems: 2, items: HANDOFF_DECOY },
    summary: { type: "string", maxLength: 300 },
  },
  required: ["claim"],
  additionalProperties: false,
};

const HANDOFF_CLAIMS = {
  type: "array",
  maxItems: 6,
  items: HANDOFF_CLAIM,
};

const RESEARCHER_HANDOFF_CLAIM = {
  ...HANDOFF_CLAIM,
  description:
    "Candidate report finding. State one self-contained claim and cite the narrowest implementation-code evidence available; claim N maps to [EN]. The staged report retains evidence-backed claims and moves unsupported candidates into a clearly marked summary note without a retry.",
  properties: {
    ...HANDOFF_CLAIM.properties,
    claim: { type: "string", minLength: 1 },
    evidence: { type: "array", maxItems: 8, items: COMPACT_HANDOFF_SELECTOR },
    summary: { type: "string", description: "Pipeline-only optional synthesis. Omit for researcher.report.v1." },
  },
  required: ["claim"],
};

const RESEARCHER_HANDOFF_CLAIMS = {
  type: "array",
  description:
    "Candidate report content. In report mode each evidence-backed finding supplies [E1], [E2], ...; unsupported candidates are moved into a marked summary note without a retry.",
  items: RESEARCHER_HANDOFF_CLAIM,
};

const RESEARCHER_PIPELINE_HANDOFF_CLAIMS = {
  ...RESEARCHER_HANDOFF_CLAIMS,
  description:
    "Advisory planner input. Evidence is useful when already surfaced, but may be omitted because the planner can inspect the named claim and source itself.",
  items: {
    ...RESEARCHER_HANDOFF_CLAIM,
    required: ["claim"],
  },
};

const RESEARCHER_PIPELINE_LIMITS =
  AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY["researcher.pipeline.v1"];

const HANDOFF_STRING_LIST = {
  type: "array",
  maxItems: 50,
  items: { type: "string", minLength: 1, maxLength: 1000 },
};

const PLANNER_SCOPE = {
  type: "object",
  description:
    "Exact execution scope. db requires target dev and empty file arrays; other agent tasks require at least one exact writable path. " +
    "Dev/code tasks require exact file paths and cannot use create_roots; artificer tasks may use bounded create_roots for artifact output. " +
    "Agent and promote tasks require concrete writable scope; non-db scope includes more than task_mode. " +
    "system/human_input uses scope:{}; system/promote requires exact destination files in files_to_create or files_to_modify.",
  properties: {
    task_mode: {
      type: "string",
      enum: ["code", "report", "content", "image", "intake_processing", "db"],
      default: "code",
    },
    files_to_modify: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
    files_to_create: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
    files_to_delete: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
    create_roots: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 500 },
      description: "Artifact-output roots for artificer tasks. Invalid for dev/code; declare each new repository file in files_to_create.",
    },
    output_root: { type: "string", maxLength: 500 },
  },
  anyOf: [
    {
      maxProperties: 0,
      description: "Only a human_input task may use an empty scope.",
    },
    {
      required: ["task_mode"],
      properties: { task_mode: { enum: ["db"] } },
    },
    {
      required: ["files_to_modify"],
      properties: { files_to_modify: { minItems: 1 } },
    },
    {
      required: ["files_to_create"],
      properties: { files_to_create: { minItems: 1 } },
    },
    {
      required: ["files_to_delete"],
      properties: { files_to_delete: { minItems: 1 } },
    },
    {
      required: ["create_roots"],
      properties: { create_roots: { minItems: 1 } },
    },
  ],
  additionalProperties: false,
};

const COMMON_HANDOFF_FIELDS = {
  id: { type: "string", minLength: 1, maxLength: 80, description: "Optional; Posse generates a deterministic ID when omitted. Target 40 characters or fewer; 80 is the hard ceiling." },
  depends_on: { type: "array", maxItems: 50, default: [], items: { type: "string", minLength: 1, maxLength: 80 } },
  intent: { type: "string", minLength: 1, maxLength: 1000, description: "Optional; Posse supplies a terminal-intent stub when omitted." },
};

function exactTarget(kind, role) {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: [kind] },
      role: { type: "string", enum: [role] },
    },
    required: ["kind", "role"],
    additionalProperties: false,
  };
}

function exactReport(properties, required = ["summary"], {
  summaryMaxLength = 4000,
  claims = HANDOFF_CLAIMS,
  summaryDescription = "Target 2000 characters or fewer; 4000 is the hard safety ceiling.",
} = {}) {
  return {
    type: "object",
    properties: {
      summary: {
        type: "string",
        ...(Number.isInteger(summaryMaxLength) ? { maxLength: summaryMaxLength } : {}),
        description: summaryDescription,
      },
      claims: { ...claims, default: [] },
      ...properties,
    },
    required,
    additionalProperties: false,
  };
}

function exactHandoff(target, report, { commonFields = COMMON_HANDOFF_FIELDS } = {}) {
  return {
    type: "object",
    description: "Submit terminal content in the nested report object. Flat report fields are rejected by the agent-facing schema.",
    properties: { ...commonFields, target, report },
    required: ["target", "report"],
    additionalProperties: false,
  };
}

function semanticRoleTool({
  description,
  profile,
  profiles = [profile],
  outcomes,
  handoff,
  maxHandoffs,
  confidence = false,
  rules = [],
}) {
  return {
    type: "function",
    name: "agent_handoff",
    description,
    parameters: {
      type: "object",
      properties: {
        protocol: { type: "string", enum: [AGENT_HANDOFF_PROTOCOL] },
        profile: { type: "string", enum: profiles },
        outcome: { type: "string", enum: outcomes },
        ...(confidence ? {
          confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Required confidence in the assessor's terminal verdict.",
          },
        } : {}),
        handoffs: {
          type: "array",
          minItems: 1,
          maxItems: maxHandoffs,
          items: handoff,
        },
      },
      ...(rules.length > 0 ? { allOf: rules } : {}),
      required: ["protocol", "profile", "outcome", ...(confidence ? ["confidence"] : []), "handoffs"],
      additionalProperties: false,
    },
  };
}

const PLANNER_COMPACT_TASK_V3 = {
  type: "object",
  description:
    "One planner task. Posse derives the canonical target from role, supplies protocol/profile/outcome, " +
    "and defaults omitted id and intent to deterministic stubs plus depends_on, claims, and constraints to empty arrays.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80, description: "Optional; Posse generates task-N when omitted. Target 40 characters or fewer; 80 is the hard ceiling." },
    depends_on: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } },
    role: { type: "string", enum: ["dev", "artificer", "human_input", "promote"] },
    intent: { type: "string", minLength: 1, maxLength: 1000 },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description:
        "Target 2000 characters or fewer; 4000 is the summary hard ceiling. " +
        "Posse preserves longer complete derived task text while the task stays within the 12000-character narrative safety ceiling.",
    },
    claims: HANDOFF_CLAIMS,
    scope: PLANNER_SCOPE,
    constraints: HANDOFF_STRING_LIST,
    success_criteria: { ...HANDOFF_STRING_LIST, minItems: 1 },
    ...AGENT_HANDOFF_PLANNER_REPORT_FIELDS,
  },
  required: ["role", "summary", "scope", "success_criteria"],
  allOf: [{
    if: {
      properties: { role: { const: "dev" } },
      required: ["role"],
    },
    then: {
      properties: {
        scope: {
          not: {
            required: ["create_roots"],
            properties: { create_roots: { minItems: 1 } },
          },
        },
      },
    },
  }],
  additionalProperties: false,
};

const CITATION_EVIDENCE_SELECTOR = evidenceSelector({
  maxLineCount: 40,
  allowPath: false,
  description:
    "Citation-child selector for an immutable ref returned by the private cursor. Paths are not accepted. Prefer at most 40 selected lines while staying within the 4000-character child evidence budget. Narrow it before the first handoff; normally select no more than 10 decisive lines from one input.",
});

const CITATION_DECOY = {
  type: "object",
  properties: {
    selector: CITATION_EVIDENCE_SELECTOR,
    reason: { type: "string", minLength: 1, maxLength: 80 },
  },
  required: ["selector", "reason"],
  additionalProperties: false,
};

const CITATION_CLAIM = {
  type: "object",
  description: "Concise citation-child claim with optional evidence and synthesis.",
  properties: {
    claim: { type: "string", minLength: 1, maxLength: 160 },
    evidence: { type: "array", minItems: 1, maxItems: 16, items: CITATION_EVIDENCE_SELECTOR },
    decoy: { type: "array", maxItems: 1, items: CITATION_DECOY },
    summary: { type: "string", maxLength: 100 },
  },
  required: ["claim", "evidence"],
  additionalProperties: false,
};

const CITATION_CLAIMS = {
  type: "array",
  maxItems: 2,
  items: CITATION_CLAIM,
};

const CITATION_HANDOFF_FIELDS = {
  ...COMMON_HANDOFF_FIELDS,
  intent: { type: "string", minLength: 1, maxLength: 100 },
};

const V2_HANDOFF_DECOY = {
  type: "object",
  description: "Canonical selector/reason decoy.",
  properties: {
    selector: HANDOFF_EVIDENCE_SELECTOR,
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["selector", "reason"],
  additionalProperties: false,
};

const V2_HANDOFF_CLAIM = {
  type: "object",
  description:
    "One specific claim with optional evidence. Use summary for brief synthesis. Place visible stored refs or surfaced file ranges in evidence or decoy selectors while runtime-owned provenance classifies each selector.",
  properties: {
    claim: { type: "string", minLength: 1, maxLength: 1000 },
    evidence: { type: "array", maxItems: 16, items: HANDOFF_EVIDENCE_SELECTOR },
    decoy: { type: "array", maxItems: 8, items: V2_HANDOFF_DECOY },
    summary: { type: "string", maxLength: 4000, description: "Optional claim synthesis. Target 2000 characters or fewer; 4000 is the hard safety ceiling." },
  },
  required: ["claim"],
  additionalProperties: false,
};

const V2_HANDOFF_CLAIMS = {
  type: "array",
  maxItems: 12,
  items: V2_HANDOFF_CLAIM,
};

const V2_RESEARCHER_SCOPE = {
  type: "object",
  description: "Verified downstream seed files. These are research seeds, not write authority.",
  properties: {
    key_files: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
    related_files: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
  },
  additionalProperties: false,
};

const V2_RESEARCHER_REPORT = exactReport({
  scope: V2_RESEARCHER_SCOPE,
  constraints: HANDOFF_STRING_LIST,
  questions: HANDOFF_STRING_LIST,
  research: AGENT_HANDOFF_RESEARCH_DATA,
}, ["summary"], {
  claims: V2_HANDOFF_CLAIMS,
  summaryMaxLength: null,
  summaryDescription:
    "For researcher.report.v1, a compact wireframe that orders or connects the claims. Use as little prose as possible; claim detail and source excerpts stay in claims and evidence, while claim order supplies [E1], [E2], ... evidence labels. For researcher.pipeline.v1, the pipeline synthesis.",
});

const V2_PLANNER_COMPACT_TASK = {
  ...PLANNER_COMPACT_TASK_V3,
  properties: {
    ...PLANNER_COMPACT_TASK_V3.properties,
    claims: V2_HANDOFF_CLAIMS,
  },
};

const V2_ASSESSOR_CLAIM = {
  type: "object",
  description:
    "One verdict claim. Use exactly claim plus optional summary and optional proof. " +
    "proof contains visible stored refs or surfaced file ranges; terminal assessor proof may use either tool-owned evidence or agent-authored prose refs.",
  properties: {
    claim: { type: "string", minLength: 1, maxLength: 1000 },
    summary: { type: "string", maxLength: 4000 },
    proof: { type: "array", maxItems: 8, items: HANDOFF_EVIDENCE_SELECTOR },
  },
  required: ["claim"],
  additionalProperties: false,
};

const V2_ASSESSOR_CLAIMS = {
  type: "array",
  description: "A JSON array of verdict claim objects in their evaluation order.",
  maxItems: 12,
  items: V2_ASSESSOR_CLAIM,
};

export const TOOL_AGENT_HANDOFF_RESEARCHER = semanticRoleTool({
  description:
    "Finish research with the active profile and target. Staged report claims remain assessment-grade and evidence-backed, while an unsupported submitted claim moves into a clearly marked summary note with no retry. Pipeline claims are advisory and may omit evidence; invalid pipeline selectors are dropped so the planner can inspect the claim itself. Preserve exact existing verification commands in research.verification_targets. Use outcome input_required when an unresolved choice would materially change security, authentication, data handling, or user-facing semantics and leave that choice to the human. The receipt ends generation.",
  profile: "researcher.pipeline.v1",
  profiles: ["researcher.pipeline.v1", "researcher.report.v1"],
  outcomes: ["success", "gap", "input_required", "complete"],
  handoff: exactHandoff({
    oneOf: [exactTarget("pipeline", "$pipeline"), exactTarget("result", "$result")],
  }, V2_RESEARCHER_REPORT),
  maxHandoffs: 1,
  rules: [
    {
      if: {
        properties: { profile: { const: "researcher.pipeline.v1" } },
        required: ["profile"],
      },
      then: {
        properties: {
          handoffs: {
            items: {
              properties: {
                report: {
                  properties: {
                    summary: { maxLength: RESEARCHER_PIPELINE_LIMITS.maxSummaryChars },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      if: {
        properties: { profile: { const: "researcher.report.v1" } },
        required: ["profile"],
      },
      then: {
        properties: {
          handoffs: {
            items: {
              properties: {
                report: {
                  required: ["summary", "claims"],
                  properties: { claims: { minItems: 1 } },
                },
              },
            },
          },
        },
      },
    },
  ],
});

export const TOOL_AGENT_HANDOFF_PLANNER = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish planning with one atomic tasks batch. Posse converts each flat task into the canonical planner packet. " +
    "Use role dev or artificer for executable work; human_input and promote are system roles. " +
    "Every non-db dev task must name exact repository files in scope.files_to_modify, scope.files_to_create, or scope.files_to_delete; dev tasks cannot use create_roots. Artificer tasks may use bounded scope.create_roots for artifact output; promote requires an exact destination path and human_input uses scope:{}. " +
    "Claims use claim plus optional evidence, decoy, and summary. Claims are optional, not a plan validity requirement: prefer task-relevant claims backed by exact source already surfaced in this call for existing-code work, because Posse materializes them into the downstream developer brief and avoids repeated discovery. Omit claims for genuinely new work or when no reliable source evidence exists, and attach only grounded selectors. A file name or skeleton is not surfaced source. If an attempted selector is unavailable, Posse moves that unsupported claim into a marked task-summary note; finish the plan because evidence repair is optional. Prefer 40-line evidence slices and keep combined developer task prose near 2000 characters; complete task prose is preserved up to the 12000-character narrative safety ceiling. " +
    "Use an evidence_ref directly because its text is already visible to this planner call. A re-issued traversal_ref is available routing custody, not evidence: call it first to surface the content, then cite the returned evidence_ref or an exact surfaced path range. Source-backed line selectors use the source-file line numbers shown in gutters or source metadata and must stay inside one surfaced window. Cite only visibility surfaced to this planner call. " +
    "Planning always hands off executable verification: when research suggests the requested state already exists, emit a narrow dev task so downstream execution and assessment own the no-op decision. Correct example: " +
    '{"tasks":[{"id":"implement","role":"dev","intent":"Implement the requested change","summary":"Update the implementation and regression coverage.","scope":{"task_mode":"code","files_to_modify":["src/example.js"]},"constraints":[],"success_criteria":["The regression is fixed without changing unrelated behavior"]}]}. ' +
    "Submit the fields shown in the task schema directly in the tasks array. The receipt ends provider generation.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: V2_PLANNER_COMPACT_TASK,
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
};

export const TOOL_AGENT_HANDOFF_ASSESSOR = semanticRoleTool({
  description:
    "Finish assessment with one exact verdict report and explicit confidence. claims must be an array; each item uses claim plus optional summary and optional proof containing only visible stored hash-ref strings. Terminal assessor proof may use tool-owned evidence or agent-authored prose refs. " +
    "A fail verdict must include at least one claim with proof so automatic repair starts only from a supported assertion. " +
    "Submit the canonical claim objects and their hash-ref proof selectors, plus the verdict fields present in the schema. The receipt ends provider generation.",
  profile: "assessor.verdict.v1",
  outcomes: ["pass", "fail", "needs_replan", "needs_review", "blocked"],
  confidence: true,
  handoff: {
    type: "object",
    description: "Supply exactly one nested target and one canonical report object.",
    properties: {
      target: exactTarget("pipeline", "$pipeline"),
      report: exactReport({
        questions: HANDOFF_STRING_LIST,
      }, ["summary", "claims"], { claims: V2_ASSESSOR_CLAIMS }),
    },
    required: ["target", "report"],
    additionalProperties: false,
  },
  maxHandoffs: 1,
});

export const TOOL_AGENT_HANDOFF_RESEARCHER_V3 = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish research using the active profile. Staged report claims require exact evidence, but unsupported submitted claims are moved into a marked summary note without a retry. Pipeline claims are advisory and may omit evidence; the planner can inspect them directly. Preserve exact existing test commands in verification_targets. Use input_required for unresolved choices that materially change security, authentication, data handling, or user-facing semantics. The receipt ends generation.",
  parameters: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        enum: ["researcher.pipeline.v1", "researcher.report.v1"],
      },
      outcome: {
        type: "string",
        enum: ["success", "gap", "input_required", "complete"],
      },
      summary: {
        type: "string",
        minLength: 1,
        description:
          "For researcher.report.v1, a compact wireframe that orders or connects the claims. Use as little prose as possible; claim detail and source excerpts stay in claims and evidence, while claim order supplies [E1], [E2], ... evidence labels. For researcher.pipeline.v1, the pipeline synthesis.",
      },
      claims: { ...RESEARCHER_PIPELINE_HANDOFF_CLAIMS, default: [] },
      key_files: {
        type: "array",
        maxItems: 12,
        items: { type: "string", minLength: 1, maxLength: 300 },
      },
      related_files: {
        type: "array",
        maxItems: 12,
        items: { type: "string", minLength: 1, maxLength: 300 },
      },
      key_symbols: {
        type: "array",
        maxItems: 8,
        items: AGENT_HANDOFF_SYMBOL_SEED,
      },
      memories: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 80 },
            content: { type: "string", minLength: 1, maxLength: 400 },
            key_files: {
              type: "array",
              maxItems: 8,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
          },
          required: ["title", "content"],
          additionalProperties: false,
        },
      },
      file_priorities: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: 300 },
            rank: { type: "integer", minimum: 1, maximum: 12, description: "One-based priority order; must equal this entry's position in the array." },
            usefulness: { type: "string", enum: ["primary", "supporting", "context", "low"] },
            evidence: { type: "string", enum: ["audited_file_read", "atlas", "search", "prior_research", "web"] },
            reason: { type: "string", minLength: 1, maxLength: 160 },
          },
          required: ["path", "rank", "usefulness", "evidence", "reason"],
          additionalProperties: false,
        },
      },
      patterns: {
        type: "array",
        maxItems: 8,
        description: "Observed pattern names and descriptions. Pattern names must be unique.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            description: { type: "string", minLength: 1, maxLength: 240 },
          },
          required: ["name", "description"],
          additionalProperties: false,
        },
      },
      absence_checks: AGENT_HANDOFF_RESEARCH_DATA.properties.absence_checks,
      verification_targets: AGENT_HANDOFF_RESEARCH_DATA.properties.verification_targets,
      questions: {
        type: "array",
        maxItems: 5,
        items: { type: "string", minLength: 1, maxLength: 240 },
      },
    },
    required: ["profile", "outcome", "summary"],
    allOf: [
      {
        if: {
          properties: { profile: { const: "researcher.pipeline.v1" } },
          required: ["profile"],
        },
        then: {
          properties: {
            summary: {
              maxLength: RESEARCHER_PIPELINE_LIMITS.maxSummaryChars,
            },
            claims: {
              maxItems: RESEARCHER_PIPELINE_LIMITS.maxClaims,
              items: {
                properties: {
                  claim: { maxLength: RESEARCHER_PIPELINE_LIMITS.maxClaimChars },
                  summary: { maxLength: RESEARCHER_PIPELINE_LIMITS.maxClaimSummaryChars },
                },
              },
            },
          },
        },
      },
      {
        if: {
          properties: { profile: { const: "researcher.report.v1" } },
          required: ["profile"],
        },
        then: {
          required: ["claims"],
          properties: { claims: { minItems: 1 } },
        },
      },
    ],
    additionalProperties: false,
  },
};

// Report-only researcher projection for sessions that have already negotiated
// compact v3. Runtime validation remains the permissive canonical contract;
// this provider projection removes pipeline-only metadata and object-form
// evidence selectors from the per-turn schema tax.
export const TOOL_AGENT_HANDOFF_RESEARCHER_V4 = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish research with a compact report. Put each self-contained finding in claims and cite visible stored refs or surfaced file ranges. Prefer implementation-code evidence. If evidence is unavailable, submit the finding once; Posse moves it into a marked summary note with no retry. The receipt ends generation.",
  parameters: {
    type: "object",
    properties: {
      profile: { type: "string", enum: ["researcher.report.v1"] },
      outcome: { type: "string", enum: ["complete"] },
      summary: {
        type: "string",
        minLength: 1,
        description: "A compact wireframe that orders or connects the claims.",
      },
      claims: {
        type: "array",
        minItems: 1,
        description: "Ordered candidate findings; evidence-backed claims supply [EN], while unsupported candidates are moved into a marked summary note.",
        items: {
          type: "object",
          properties: {
            claim: { type: "string", minLength: 1 },
            evidence: {
              type: "array",
              maxItems: 8,
              items: {
                type: "string",
                pattern: HANDOFF_SELECTOR_STRING_PATTERN,
                description: "A visible #ref or surfaced path with an optional line range.",
              },
            },
          },
          required: ["claim"],
          additionalProperties: false,
        },
      },
    },
    required: ["profile", "outcome", "summary", "claims"],
    additionalProperties: false,
  },
};

export const TOOL_AGENT_HANDOFF_PLANNER_V3 = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish planning with one atomic tasks batch. Posse converts each flat task into the canonical planner packet. " +
    "Use role dev or artificer for executable work; human_input and promote are system roles. " +
    "Every non-db dev task must name exact repository files in scope.files_to_modify, scope.files_to_create, or scope.files_to_delete; dev tasks cannot use create_roots. Artificer tasks may use bounded scope.create_roots for artifact output; promote requires an exact destination path and human_input uses scope:{}. " +
    "Claims use claim plus optional evidence, decoy, and summary. Claims are optional, not a plan validity requirement: prefer task-relevant claims backed by exact source already surfaced in this call for existing-code work, because Posse materializes them into the downstream developer brief and avoids repeated discovery. Omit claims for genuinely new work or when no reliable source evidence exists, and attach only grounded selectors. A file name or skeleton is not surfaced source. If an attempted selector is unavailable, Posse moves that unsupported claim into a marked task-summary note; finish the plan because evidence repair is optional. Prefer 40-line evidence slices and keep combined developer task prose near 2000 characters; complete task prose is preserved up to the 12000-character narrative safety ceiling. " +
    "Use an evidence_ref directly because its text is already visible to this planner call. A re-issued traversal_ref is available routing custody, not evidence: call it first to surface the content, then cite the returned evidence_ref or an exact surfaced path range. Source-backed line selectors use the source-file line numbers shown in gutters or source metadata and must stay inside one surfaced window. Cite only visibility surfaced to this planner call. " +
    "Planning always hands off executable verification: when research suggests the requested state already exists, emit a narrow dev task so downstream execution and assessment own the no-op decision. Correct example: " +
    '{"tasks":[{"id":"implement","role":"dev","intent":"Implement the requested change","summary":"Update the implementation and regression coverage.","scope":{"task_mode":"code","files_to_modify":["src/example.js"]},"constraints":[],"success_criteria":["The regression is fixed without changing unrelated behavior"]}]}. ' +
    "Submit the fields shown in the task schema directly in the tasks array. The receipt ends provider generation.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: PLANNER_COMPACT_TASK_V3,
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
};

export const TOOL_AGENT_HANDOFF_CITATION = semanticRoleTool({
  description:
    "Finish citation synthesis with one parent report containing supported findings in named claim objects and optional summaries. Before the first handoff, narrow every evidence selector and target a sum of 30 or fewer selected lines. Submit the citation report fields present in the schema. The receipt ends provider generation.",
  profile: "citation_synthesis.v1",
  outcomes: ["complete", "partial", "failed"],
  handoff: exactHandoff(exactTarget("parent", "$parent"), exactReport({}, ["summary"], {
    summaryMaxLength: 500,
    claims: CITATION_CLAIMS,
    summaryDescription: "At most 500 characters. Target 350 or fewer; the total narrative ceiling across intent, claims, synthesis, and decoy reasons is 2000 characters.",
  }), { commonFields: CITATION_HANDOFF_FIELDS }),
  maxHandoffs: 1,
});

// Backward-compatible internal export. New role projection code must select
// the exact researcher/planner/citation schemas above instead of this alias.
export const TOOL_AGENT_HANDOFF_REPORT = TOOL_AGENT_HANDOFF_RESEARCHER;

export const TOOL_AGENT_HANDOFF_ASSESSOR_V3 = {
  type: "function",
  name: "agent_handoff",
  description:
    "Finish assessment with one verdict, explicit confidence, and a brief prose proof drawn from the evidence already available. A fail verdict also requires at least one visible evidence selector and an exact repair instruction so the fix handoff preserves the grounded defect location, current behavior, expected behavior, and narrow change. The receipt ends provider generation.",
  parameters: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail", "needs_replan", "needs_review", "blocked"],
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Required confidence in the terminal verdict.",
      },
      proof: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "One concise sentence stating the decisive verified fact or remaining defect.",
      },
      repair: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description: "Required only for fail: exact path/location, current behavior, expected behavior, and narrow required change passed to the fix job.",
      },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "string",
          pattern: ASSESSOR_HANDOFF_SELECTOR_STRING_PATTERN,
          description: "Visible #ref, source range, or inspected relative binary path.",
        },
        description: "Fail evidence; inspected binary paths need no line range.",
      },
      questions: {
        type: "array",
        maxItems: 3,
        items: { type: "string", minLength: 1, maxLength: 240 },
      },
    },
    required: ["verdict", "confidence", "proof"],
    allOf: [{
      if: { properties: { verdict: { const: "fail" } }, required: ["verdict"] },
      then: { required: ["repair", "evidence"] },
      else: { not: { anyOf: [{ required: ["repair"] }, { required: ["evidence"] }] } },
    }],
    additionalProperties: false,
  },
};

export function getAgentHandoffToolSchemaForRole(role, {
  compactCompletion = false,
  compactV3 = false,
  compactV4 = false,
} = {}) {
  if (!compactCompletion) return TOOL_AGENT_HANDOFF;
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "dev" || normalizedRole === "fix") return TOOL_AGENT_HANDOFF_DEV;
  if (normalizedRole === "artificer") return TOOL_AGENT_HANDOFF_ARTIFICER;
  if (normalizedRole === "assessor") {
    return compactV3 ? TOOL_AGENT_HANDOFF_ASSESSOR_V3 : TOOL_AGENT_HANDOFF_ASSESSOR;
  }
  if (normalizedRole === "researcher") {
    if (compactV3 && compactV4) return TOOL_AGENT_HANDOFF_RESEARCHER_V4;
    return compactV3 ? TOOL_AGENT_HANDOFF_RESEARCHER_V3 : TOOL_AGENT_HANDOFF_RESEARCHER;
  }
  if (normalizedRole === "planner") {
    return compactV3 ? TOOL_AGENT_HANDOFF_PLANNER_V3 : TOOL_AGENT_HANDOFF_PLANNER;
  }
  if (normalizedRole === "subagent") return TOOL_AGENT_HANDOFF_CITATION;
  return TOOL_AGENT_HANDOFF;
}

// Provider-facing schemas intentionally differ from the permissive migration
// schema in TOOL_AGENT_HANDOFF. Runtime additionally accepts legacy tuple
// claims and `prose` aliases at compatibility boundaries.

export const TOOL_SUB_AGENT_NEXT_INPUT = {
  type: "function",
  name: "sub_agent_next_input",
  description:
    "Advance an isolated citation child through its backend-owned ordered inputs. " +
    "Start at position 0 and use only the returned next_position; count batches up to three ordered inputs in one turn, and exact-position replay is idempotent.",
  parameters: {
    type: "object",
    properties: {
      position: { type: "integer", minimum: 0, maximum: 2 },
      count: { type: "integer", minimum: 1, maximum: 3 },
    },
    required: ["position"],
    additionalProperties: false,
  },
};

const SUB_AGENT_REQUEST = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 40 },
    profile: { type: "string", enum: ["citation_synthesis.v1"] },
    intent: { type: "string", minLength: 1, maxLength: 2000 },
    inputs: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "Ordered evidence refs or deterministic read calls selected by the parent. Children materialize them lazily through a private cursor.",
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 40 },
              kind: { type: "string", enum: ["ref"] },
              ref: { type: "string", pattern: "^#[0-9a-z]{4,12}(?::[Ll]?[0-9]+(?:-[Ll]?[0-9]+)?)?$" },
            },
            required: ["id", "kind", "ref"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 40 },
              kind: { type: "string", enum: ["call"] },
              tool: {
                type: "string",
                minLength: 1,
                maxLength: 120,
                description: "Provide the exact canonical issued name from the current surface, retaining its suite prefix and dotted action name.",
              },
              arguments: { type: "object" },
            },
            required: ["id", "kind", "tool", "arguments"],
            additionalProperties: false,
          },
        ],
      },
    },
    budget: {
      type: "object",
      properties: {
        timeout_ms: { type: "integer", minimum: 5000, maximum: 60000 },
        max_inputs: { type: "integer", minimum: 1, maximum: 3 },
      },
      additionalProperties: false,
    },
  },
  required: ["id", "profile", "intent", "inputs"],
  additionalProperties: false,
};

export const TOOL_SUB_AGENT = {
  type: "function",
  name: "sub_agent",
  description:
    "Dispatch or control an admin-gated batch of one to three isolated citation agents. " +
    "Mandatory routing check: after two parent evidence calls across multiple targets, dispatch one batch before another read or materialization call when at least two related targets still need synthesis. Continue directly when current context contains the answers or the remaining question needs one targeted call. Prefetched names, skeletons, and file lists provide orientation; child agents synthesize evidence while developer parents apply it. " +
    "Children receive a private lazy input cursor plus a terminal handoff capability. Use wait_all when the answer is needed before continuing; async returns immediately and status collects results.",
  parameters: {
    oneOf: [
      {
        type: "object",
        properties: {
          op: { type: "string", enum: ["dispatch"] },
          protocol: { type: "string", enum: [SUB_AGENT_PROTOCOL] },
          requests: { type: "array", minItems: 1, maxItems: 3, items: SUB_AGENT_REQUEST },
          completion: {
            type: "object",
            properties: { mode: { type: "string", enum: ["async", "wait_all"] } },
            required: ["mode"],
            additionalProperties: false,
          },
        },
        required: ["op", "protocol", "requests", "completion"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { type: "string", enum: ["status"] },
          protocol: { type: "string", enum: [SUB_AGENT_PROTOCOL] },
          batch_id: { type: "string", minLength: 12, maxLength: 80 },
          wait_ms: { type: "integer", minimum: 0, maximum: 5000 },
        },
        required: ["op", "protocol", "batch_id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { type: "string", enum: ["cancel"] },
          protocol: { type: "string", enum: [SUB_AGENT_PROTOCOL] },
          batch_id: { type: "string", minLength: 12, maxLength: 80 },
        },
        required: ["op", "protocol", "batch_id"],
        additionalProperties: false,
      },
    ],
  },
};

export const TOOL_DISPATCH_AGENT = {
  type: "function",
  name: "dispatch_agent",
  description:
    "Dispatch one isolated specialty agent and wait for its bounded result. " +
    "The web route receives only the question, performs web search/fetch in its own context, and returns parent-visible evidence selectors without exposing its browsing transcript.",
  parameters: {
    type: "object",
    properties: {
      route: {
        type: "string",
        enum: ["web"],
        description: "Specialty agent route. Only web is currently supported.",
      },
      question: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Self-contained web research question for the isolated agent.",
      },
    },
    required: ["route", "question"],
    additionalProperties: false,
  },
};

export const TOOL_WEB_RESEARCH_HANDOFF = {
  type: "function",
  name: "web_research_handoff",
  description:
    "Submit the web specialty agent's sole final result. Every finding must name an exact HTTP(S) source URL. " +
    "The runtime validates and materializes accepted findings into evidence refs visible to the calling agent.",
  parameters: {
    type: "object",
    properties: {
      protocol: { type: "string", enum: [WEB_RESEARCH_PROTOCOL] },
      summary: { type: "string", minLength: 1, maxLength: 2000 },
      findings: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            claim: { type: "string", minLength: 1, maxLength: 800 },
            url: { type: "string", minLength: 1, maxLength: 2000 },
            title: { type: "string", minLength: 1, maxLength: 300 },
            published_at: { type: "string", minLength: 1, maxLength: 80 },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["claim", "url", "confidence"],
          additionalProperties: false,
        },
      },
      gaps: {
        type: "array",
        maxItems: 6,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    required: ["protocol", "summary", "findings"],
    additionalProperties: false,
  },
};

export const TOOL_LIST_FILES = {
  type: "function",
  name: "list_files",
  description:
    "List files in a directory, optionally filtering by name pattern. Returns at most 200 file paths and marks the result when additional matches were truncated.",
  parameters: {
    type: "object",
    properties: {
      directory: { type: "string", description: "Directory to list. Default: working directory" },
      pattern: { type: "string", description: "File name pattern filter, e.g. '*.js', '*.ts'. Default: all files" },
      recursive: { type: "boolean", description: "Search subdirectories recursively. Default: true" },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_SEARCH_FILES = {
  type: "function",
  name: "search_files",
  description:
    "Search file contents deterministically with ripgrep (rg), using regex or literal modes. " +
    "Returns a self-bounded ranked result with at most one context line, matchesTotal, and file/count output modes; it does not return continuation pages.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern. Interpreted as a regex unless literal is true." },
      path: { type: "string", description: "File or directory to search in. Default: working directory" },
      include: { type: "string", description: "Glob pattern to filter files, e.g. '*.js', '*.{ts,tsx}'" },
      case_insensitive: { type: "boolean", description: "Match case-insensitively. Default: false." },
      literal: { type: "boolean", description: "Treat pattern as literal text. Default: false, which enables regex interpretation." },
      multiline: { type: "boolean", description: "Allow regex to match across newlines. Default: false." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Result format. Default: content.",
      },
      before_context: { type: "integer", description: "Lines of context before each content match." },
      after_context: { type: "integer", description: "Lines of context after each content match." },
      context: { type: "integer", description: "Lines of context before and after each match." },
      head_limit: { type: "integer", description: "Maximum returned rows after offset. Default: 100, max: 500." },
      offset: { type: "integer", description: "Legacy internal row offset.", internalOnly: true },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const TOOL_HASH_FILE = {
  type: "function",
  name: "hash_file",
  description:
    "Calculate a deterministic file hash for verification. Returns structured metadata with SHA-256 by default.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to working directory)" },
      algorithm: {
        type: "string",
        enum: ["sha256", "sha1", "md5"],
        description: "Hash algorithm. Default: sha256.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_RESIZE_IMAGE = {
  type: "function",
  name: "resize_image",
  description:
    "Resize a PNG image deterministically, writing PNG or JPEG output based on output_path/output_format. " +
    "Use this when an existing generated image needs different dimensions or final format for the layout.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source PNG path (absolute or relative to working directory)" },
      output_path: { type: "string", description: "Optional destination PNG/JPEG path. Defaults to overwriting the source file." },
      output_format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format. Defaults from output_path extension, then png." },
      quality: { type: "integer", description: "JPEG quality from 1-100 when outputting JPEG. Default: 90." },
      width: { type: "integer", description: "Target width in pixels" },
      height: { type: "integer", description: "Target height in pixels" },
      mode: {
        type: "string",
        enum: ["fit", "fill", "stretch"],
        description: "Resize mode. fit preserves aspect ratio with transparent padding, fill preserves aspect ratio and crops, stretch ignores aspect ratio. Default: fit.",
      },
    },
    required: ["path", "width", "height"],
    additionalProperties: false,
  },
};

export const TOOL_READ_IMAGE_METADATA = {
  type: "function",
  name: "read_image_metadata",
  description: "Read basic image metadata (format, dimensions, byte size).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_VALIDATE_ARTIFACT_OUTPUT = {
  type: "function",
  name: "validate_artifact_output",
  description:
    "Validate an artifact output directory against the configured artifact contract and optional expected image dimensions in one structured result.",
  parameters: {
    type: "object",
    properties: {
      output_root: { type: "string", description: "Artifact output directory to validate. Defaults to the working directory." },
      task_mode: {
        type: "string",
        enum: ["image", "report", "content", "intake_processing"],
        description: "Artifact task mode. Default: image.",
      },
      expected_files: {
        type: "array",
        items: { type: "string" },
        description: "Optional exact filenames/relative paths that must exist under output_root.",
      },
      expected_images: {
        type: "array",
        description: "Optional image-specific expectations for dimensions and transparency.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Image path relative to output_root." },
            width: { type: "integer", description: "Exact expected width in pixels." },
            height: { type: "integer", description: "Exact expected height in pixels." },
            min_width: { type: "integer", description: "Minimum acceptable width in pixels." },
            min_height: { type: "integer", description: "Minimum acceptable height in pixels." },
            max_width: { type: "integer", description: "Maximum acceptable width in pixels." },
            max_height: { type: "integer", description: "Maximum acceptable height in pixels." },
            transparent: { type: "boolean", description: "When true, PNG must contain at least one transparent pixel; when false, it must be fully opaque." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      allowed_extensions: {
        type: "array",
        items: { type: "string" },
        description: "Optional extension allowlist overriding the artifact protocol, e.g. ['.png','.jpg'].",
      },
      min_bytes: { type: "integer", description: "Optional minimum byte size for non-manifest output files." },
    },
    additionalProperties: false,
  },
};

export const TOOL_PRUNE_ARTIFACT_OUTPUT = {
  type: "function",
  name: "prune_artifact_output",
  description:
    "Remove non-deliverable sidecar files from a scoped artifact output directory while preserving allowed image files and manifest files.",
  parameters: {
    type: "object",
    properties: {
      output_root: { type: "string", description: "Artifact output directory to prune. Defaults to the working directory." },
      task_mode: {
        type: "string",
        enum: ["image", "report", "content", "intake_processing"],
        description: "Artifact task mode used to derive allowed formats. Default: image.",
      },
      allowed_extensions: {
        type: "array",
        items: { type: "string" },
        description: "Optional extension allowlist overriding the artifact protocol, e.g. ['.png','.jpg'].",
      },
      keep_paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional relative paths under output_root to preserve even if their extension is not allowed.",
      },
      dry_run: {
        type: "boolean",
        description: "When true, report what would be deleted without deleting. Default: false.",
      },
      remove_empty_dirs: {
        type: "boolean",
        description: "Remove empty directories left behind after pruning. Default: true.",
      },
      max_delete_count: {
        type: "integer",
        description: "Safety cap for files that may be deleted in one call. Default: 50.",
      },
    },
    additionalProperties: false,
  },
};

export const TOOL_OPTIMIZE_IMAGE = {
  type: "function",
  name: "optimize_image",
  description: "Optimize a PNG by stripping non-essential metadata chunks.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path." },
      output_path: { type: "string", description: "Optional destination path. Defaults to source path." },
      overwrite: { type: "boolean", description: "When false, refuses to overwrite existing output_path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_REENCODE_IMAGE = {
  type: "function",
  name: "reencode_image",
  description:
    "Re-encode an image to a clean PNG or JPEG within the allowed scope. " +
    "Use this to repair files whose extension does not match their bytes or transcode generated PNGs to true JPEG deliverables.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path." },
      output_path: { type: "string", description: "Destination image path. Defaults to overwriting the source." },
      output_format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format. Defaults from output_path extension, then png." },
      quality: { type: "integer", description: "JPEG quality from 1-100 when outputting JPEG. Default: 90." },
      overwrite: { type: "boolean", description: "When false, refuses to overwrite existing output_path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_CLEAN_IMAGE = {
  type: "function",
  name: "clean_image",
  description:
    "Inspect, re-encode, resize, optimize, or remove a solid background from one scoped image in a single operation.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path." },
      output_path: { type: "string", description: "Optional destination path. Defaults to overwriting the source." },
      mode: {
        type: "string",
        enum: ["metadata", "optimize", "reencode", "resize", "clean", "alpha_key"],
        description:
          "Operation to run. metadata reads dimensions/format; optimize rewrites PNG without metadata; " +
          "reencode writes a clean PNG/JPEG; resize resizes a PNG to PNG/JPEG; clean reencodes/optimizes and optionally resizes; " +
          "alpha_key turns a solid edge-connected background color transparent.",
      },
      output_format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format for reencode/resize/clean. Defaults from output_path extension, then png." },
      quality: { type: "integer", description: "JPEG quality from 1-100 when outputting JPEG. Default: 90." },
      width: { type: "integer", description: "Target width in pixels for resize/clean." },
      height: { type: "integer", description: "Target height in pixels for resize/clean." },
      resize_mode: {
        type: "string",
        enum: ["fit", "fill", "stretch"],
        description: "Resize behavior when width/height are supplied. Default: fit.",
      },
      target_color: {
        type: "string",
        description: "For mode=alpha_key, background color to key out, e.g. '#ffffff' or '245,234,208'. Omit or use 'auto' to sample image corners.",
      },
      tolerance: {
        type: "integer",
        description: "For mode=alpha_key, per-channel tolerance from 0-255. Default: 24.",
      },
      sample: {
        type: "string",
        enum: ["corners", "top_left", "top_right", "bottom_left", "bottom_right"],
        description: "For mode=alpha_key auto target color sampling. Default: corners.",
      },
      sample_size: {
        type: "integer",
        description: "For mode=alpha_key, square corner sample size in pixels. Default: 3.",
      },
      edge_only: {
        type: "boolean",
        description: "For mode=alpha_key, only key pixels connected to the image edge. Default: true.",
      },
      overwrite: { type: "boolean", description: "When false, refuses to overwrite existing output_path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_EXTRACT_IMAGE_TEXT = {
  type: "function",
  name: "extract_image_text",
  description:
    "Extract text from an image (OCR) using the local tesseract CLI. " +
    "Use this when you need the text content of a flyer, screenshot, scanned document, or other image. " +
    "Returns the recognized text. Requires tesseract to be installed on the host.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image path (absolute or relative to working directory). Common formats: png, jpg, jpeg, tiff, bmp, gif, webp." },
      language: {
        type: "string",
        description: "Tesseract language code (e.g. 'eng', 'eng+fra'). Default: 'eng'.",
      },
      psm: {
        type: "integer",
        description: "Optional Tesseract page segmentation mode (0-13). Defaults to tesseract's own default.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_AGENT_FEEDBACK = {
  type: "function",
  name: "agent_feedback",
  description:
    "Live status-update tool for the Monitor Agents channel. " +
    "Send a short operator-facing update on visible state: current phase, decision or strategy change, blocker, verification transition, or finalization status. " +
    "Do not include hidden reasoning or private chain-of-thought.",
  parameters: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        enum: ["reading", "planning", "editing", "testing", "verifying", "blocked", "finalizing", "handoff"],
        description: "Current operational phase.",
      },
      status: {
        type: "string",
        enum: ["running", "blocked", "waiting", "verifying", "done"],
        description: "Current visible status. Defaults to running when omitted.",
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 180,
        description: "One short operator-facing update, no hidden reasoning. Maximum 180 characters.",
      },
      detail: {
        type: "string",
        maxLength: 360,
        description: "Optional bounded supporting detail, no hidden reasoning. Maximum 360 characters.",
      },
    },
    required: ["phase", "summary"],
    additionalProperties: false,
  },
};

export const TOOL_GET_OPERATOR_FEEDBACK = {
  type: "function",
  name: "get_operator_feedback",
  description:
    "Internal recovery endpoint for re-reading direct operator-feedback deliveries after an interrupted transport. " +
    "This tool is not issued to models and must never be polled.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Maximum feedback items to retrieve. Default: 20.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_ACK_OPERATOR_FEEDBACK = {
  type: "function",
  name: "ack_operator_feedback",
  description:
    "Acknowledge one operator feedback item attached directly to a tool result. " +
    "The default decision is accepted, so the usual case only needs interaction_id. " +
    "Choose rejected or deferred with a short reason when the feedback will not be applied now.",
  parameters: {
    type: "object",
    properties: {
      interaction_id: {
        type: "integer",
        description: "The item id in the direct operator-feedback delivery.",
      },
      decision: {
        type: "string",
        enum: ["accepted", "rejected", "deferred"],
        description: "Acknowledgement decision. Defaults to accepted.",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Required for rejected or deferred; optional for accepted.",
      },
    },
    required: ["interaction_id"],
    allOf: [{
      if: {
        properties: { decision: { enum: ["rejected", "deferred"] } },
        required: ["decision"],
      },
      then: { required: ["reason"] },
    }],
    additionalProperties: false,
  },
};

export const TOOL_BASH = {
  type: "function",
  name: "bash",
  description:
    "Execute a read-only inspection command or test/build runner and return stdout+stderr. " +
    "On Windows this runs through PowerShell when shell features are needed; prefer repo-native test commands and PowerShell-compatible syntax over Unix-only filters. " +
    "Use the declared-scope check capability for covered lint and typecheck work. Workspace changes use scoped mutation capabilities.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "integer", minimum: 1, maximum: 120000, description: "Timeout in milliseconds. Default: 60000; maximum: 120000." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const TOOL_RUN_SCOPED_CHECKS = {
  type: "function",
  name: "run_scoped_checks",
  description:
    "Run the canonical deterministic lint/typecheck checks for the declared job scope in one batch, including scoped PHP syntax lint when PHP files are present. " +
    "Returns all-checks-passed, compact failure feedback with file/line/rule details, or an unavailable result when no supported/requested runner can execute.",
  parameters: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: { type: "string", enum: ["lint", "typecheck"] },
        description: "Checks to run. Default: ['lint'].",
      },
      scope: {
        type: "object",
        description: "Optional explicit scope override. Omit to use the declared job scope.",
        properties: {
          files: { type: "array", items: { type: "string" } },
          modifyFiles: { type: "array", items: { type: "string" } },
          scopedFiles: { type: "array", items: { type: "string" }, description: "Additional files included in the explicit check scope." },
          createFiles: { type: "array", items: { type: "string" } },
          deleteFiles: { type: "array", items: { type: "string" } },
          roots: { type: "array", items: { type: "string" } },
          createRoots: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_CREATE_TEST_SUITE = {
  type: "function",
  name: "create_test_suite",
  description:
    "Create or update one registered Posse test suite. Suites are stored in the runtime DB and mirrored under private .posse-test-suites metadata. " +
    "This does not list the full catalog; use a suite id/name returned by this tool for later calls.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Human-readable suite name, e.g. 'queue lease safety'." },
      slug: { type: "string", description: "Optional stable suite slug. Defaults from name." },
      explanation: { type: "string", description: "What this suite covers and when it should be run." },
    },
    required: ["name", "explanation"],
    additionalProperties: false,
  },
};

export const TOOL_CREATE_TEST = {
  type: "function",
  name: "create_test",
  description:
    "Register or update one or many tests inside an existing suite. For a batch, provide shared suite_id/suite plus tests (max 24); each result is reported independently. " +
    "Every candidate is executed before it can be inserted or updated and must return/resolve exactly true. A failing candidate is never added, and a failing update never replaces the last passing definition. " +
    "Declare the production files/functions each test covers so Posse can scope future runs. " +
    "The harness runs from a temp directory and deletes it after the run; put all scratch files in the provided tmp path.",
  parameters: {
    type: "object",
    properties: {
      suite_id: { type: "integer", description: "Target suite id. Prefer this when available." },
      suite: { type: "string", description: "Target suite name or slug when suite_id is not available." },
      name: { type: "string", description: "Human-readable test name." },
      slug: { type: "string", description: "Optional stable test slug. Defaults from name." },
      explanation: { type: "string", description: "What this test checks and why it belongs in the suite." },
      language: {
        type: "string",
        enum: ["javascript", "python"],
        description: "Runtime language for the test function.",
      },
      function_name: {
        type: "string",
        description: "Optional test function/export name. This is the test entrypoint, not the production function being covered.",
      },
      target_files: {
        type: "array",
        items: { type: "string" },
        description: "Workspace-relative production file paths covered by this test. Required so future runs can be scoped to edited files.",
      },
      target_symbols: {
        type: "array",
        items: { type: "string" },
        description: "Optional production functions/classes/symbols covered by this test, e.g. ['parseLeaseToken', 'Scheduler.acquire'].",
      },
      target_imports: {
        type: "array",
        description:
          "Optional import hints for covered files. The runner also passes targetFiles/targetSymbols/targetImports and helpers importTarget/requireTarget (JS) or import_target (Python).",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file to import." },
            symbols: { type: "array", items: { type: "string" }, description: "Named exports/symbols to import or inspect." },
            default: { type: "string", description: "Default export/local binding hint." },
            namespace: { type: "string", description: "Namespace import/local binding hint." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      test: {
        type: "string",
        description:
          "Test source. JavaScript can be an async function/lambda, default export, or named export. Python should define function_name, test, run, or main. Return true to pass.",
      },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
      tests: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        description:
          "Batch form (max 24). Each candidate is run before registration; failed candidates remain unregistered while valid candidates continue. Uses the outer suite_id/suite and optional timeout_ms by default.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Human-readable test name." },
            slug: { type: "string", description: "Optional stable test slug. Defaults from name." },
            explanation: { type: "string", description: "What this test checks and why it belongs in the suite." },
            language: { type: "string", enum: ["javascript", "python"], description: "Runtime language for the test function." },
            function_name: { type: "string", description: "Optional test function/export name." },
            target_files: {
              type: "array",
              items: { type: "string" },
              description: "Workspace-relative production file paths covered by this test.",
            },
            target_symbols: {
              type: "array",
              items: { type: "string" },
              description: "Optional production functions/classes/symbols covered by this test.",
            },
            target_imports: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Workspace-relative file to import." },
                  symbols: { type: "array", items: { type: "string" } },
                  default: { type: "string" },
                  namespace: { type: "string" },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
            test: { type: "string", description: "Test source. It must return/resolve exactly true to be registered." },
            timeout_ms: { type: "integer", description: "Optional per-test timeout override in milliseconds." },
          },
          required: ["name", "explanation", "language", "target_files", "test"],
          additionalProperties: false,
        },
      },
    },
    allOf: [
      {
        anyOf: [
          { required: ["suite_id"] },
          { required: ["suite"] },
        ],
      },
      {
        anyOf: [
          { required: ["tests"] },
          { required: ["name", "explanation", "language", "target_files", "test"] },
        ],
      },
    ],
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_RUN_TEST = {
  type: "function",
  name: "run_test",
  description:
    "Run one or many registered Posse tests. Select one by id or by suite plus test name/slug; for a batch, provide tests (max 24). " +
    "Only tests whose registered target files overlap the current job file scope run; others return skipped_out_of_scope. Returns per-test suite/name identity, pass/fail, and compact failure feedback without stopping the batch after one failure.",
  parameters: {
    type: "object",
    properties: {
      test_id: { type: "integer", description: "Registered test id." },
      suite_id: { type: "integer", description: "Suite id when selecting by test name." },
      suite: { type: "string", description: "Suite name or slug when selecting by test name." },
      test: { type: "string", description: "Test name or slug when test_id is omitted." },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
      tests: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        description:
          "Batch form (max 24). Each item selects a test by test_id or by test name/slug using the outer suite_id/suite. Results preserve input order.",
        items: {
          type: "object",
          properties: {
            test_id: { type: "integer", description: "Registered test id." },
            test: { type: "string", description: "Test name or slug when test_id is omitted." },
            timeout_ms: { type: "integer", description: "Optional per-test timeout override in milliseconds." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_RUN_TEST_SUITE = {
  type: "function",
  name: "run_test_suite",
  description:
    "Run active tests in one registered suite whose target files overlap the current job file scope. Out-of-scope tests return skipped_out_of_scope. Requires a suite id/name and intentionally does not expose the full suite catalog.",
  parameters: {
    type: "object",
    properties: {
      suite_id: { type: "integer", description: "Registered suite id." },
      suite: { type: "string", description: "Suite name or slug." },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
    },
    required: [],
    additionalProperties: false,
  },
};

export { TOOL_COPY_FILE, TOOL_MAKE_DIR, TOOL_MOVE_FILE } from "./tools/filesystem-mutations.js";

export const TOOL_CHAIN_READ = {
  type: "function",
  name: "chain_read",
  description:
    "Read exact missing file context through the deterministic fallback. When ATLAS is active, " +
    "successful ATLAS source retrieval already counts as file-content evidence. This reader covers " +
    "remaining ATLAS evidence gaps, exact mutated or non-indexed state, an " +
    "unsupported operation, or when ATLAS is unavailable. The first read of a file locks the chain until you " +
    "classify that file as relevant or irrelevant. Large files may be paged with " +
    "offset/limit; after the file is tagged relevant, later continuation pages inherit " +
    "that verdict. When ATLAS is active, indexed evidence and withheld ranges stay on the issued ATLAS " +
    "retrieval surface; raw indexed reads are reserved for changed files or the ATLAS unavailable/strikeout " +
    "escape hatch. " +
    "A previously relevant file restored from the audit ledger retains its verdict. " +
    "Optional search/jsonPath/maxBytes uses the same structured extraction as the issued exact-file reader.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative to project root).",
      },
      offset: { type: "integer", description: "Starting line number, 1-based. Default: 1" },
      limit: { type: "integer", description: "Maximum number of lines to read. Default: 2000 outside the Atlas-first source gate. Under the active gate, non-indexed reads default to and are capped at 250; changed/unavailable indexed escape reads retain the native reader bounds." },
      maxBytes: { type: "integer", description: "Maximum bytes to return in structured mode." },
      search: { type: "string", maxLength: 200, description: "Case-insensitive regex pattern to search within the selected line range. Unsafe nested-quantifier patterns are treated as literal text; results are capped at 100 matches." },
      searchContext: { type: "integer", minimum: 0, description: "Context lines around each search match in structured mode. Used only with search; default 2." },
      jsonPath: { type: "string", description: "Dot-separated JSON path to extract from a JSON file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_CHAIN_VERDICT = {
  type: "function",
  name: "chain_verdict",
  description:
    "Classify the currently locked file as relevant or irrelevant, unlocking the next file read. Relevant continuation pages inherit " +
    "that verdict. Mark the file relevant or " +
    "irrelevant. The classification stays in the local audit ledger for duplicate " +
    "suppression and research telemetry. ATLAS evidence remains the primary indexed source, and terminal handoff selection remains explicit. " +
    "Irrelevant files are logged for later read suppression.",
  parameters: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["relevant", "irrelevant"],
        description: "Whether this file is relevant to the research task.",
      },
      summary: {
        type: "string",
        minLength: 1,
        description: "What you found. Required for irrelevant verdicts so later pruning preserves why the file was excluded.",
      },
    },
    required: ["verdict"],
    allOf: [{
      if: {
        properties: { verdict: { const: "irrelevant" } },
        required: ["verdict"],
      },
      then: { required: ["summary"] },
    }],
    additionalProperties: false,
  },
};

export const TOOL_PULL_BRIEF = {
  type: "function",
  name: "pull_brief",
  description:
    "Deterministically gather a compact evidence brief from the repository in one guarded call. " +
    "Supports targeted gap-fill or bounded tree pull without shell commands.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["gap_fill", "tree_pull"],
        description: "gap_fill targets missing evidence; tree_pull performs a bounded repo sweep.",
      },
      query: {
        type: "string",
        description: "Natural-language question or objective used to derive search terms.",
      },
      missing: {
        type: "array",
        maxItems: 20,
        items: { type: "string" },
        description: "Optional missing file hints or identifiers to prioritize in gap_fill mode, up to 20.",
      },
      seed_paths: {
        type: "array",
        maxItems: 30,
        items: { type: "string" },
        description: "Optional relative paths to prioritize before scanning, up to 30.",
      },
      max_files: {
        type: "integer",
        description: "Maximum number of files in the brief (1-30). Default: 12.",
      },
      max_lines_per_file: {
        type: "integer",
        description: "Maximum snippet lines per file (1-80). Default: 8.",
      },
      include_ext: {
        type: "array",
        items: { type: "string", pattern: "^\\.[^./\\\\]+$" },
        description: "Optional extension allowlist with a leading dot on every entry, e.g. ['.js','.php']. Entries without a leading dot are ignored.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const TOOL_GET_BRIEF = {
  type: "function",
  name: "get_brief",
  description:
    "Load the research brief already prepared for this work item in one call: canonical structured research " +
    "(key files, patterns, constraints), the ranked file-priority list, the function/class index, " +
    "plus a manifest of staged source files. One call at the start of planning returns the complete " +
    "pre-staged handoff context; raw brief markdown is omitted only when structured research includes the complete planning synthesis.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export const TOOL_GENERATE_IMAGE = {
  type: "function",
  name: "generate_image",
  description:
    "Generate an image using the configured image provider/model and save it in the current output directory.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed description of the image to generate.",
      },
      filename: {
        type: "string",
        minLength: 1,
        pattern: "^[^/\\\\]+$",
        description: "Output image filename only, such as image.png. Directory paths are not accepted.",
      },
      size: {
        type: "string",
        description: "Optional size hint (provider/model dependent).",
      },
      quality: {
        type: "string",
        description: "Optional quality hint (provider/model dependent).",
      },
      provider: {
        type: "string",
        enum: ["openai", "grok"],
        description: "Optional provider override. Defaults to configured image provider.",
      },
    },
    required: ["prompt", "filename"],
    additionalProperties: false,
  },
};

export const TOOL_PROJECT_DB_QUERY = {
  type: "function",
  name: "project_db_query",
  description:
    "Run a single SQL statement against this project's configured application database " +
    "(sqlite/postgres/mysql). Opt-in and operator-configured per repository: the statement " +
    "types you may run depend on separate per-verb grants: READ enables SELECT, WRITE enables UPDATE, " +
    "and INSERT, DELETE, CREATE, and ALTER each require their matching grant. Read-only inspection (PRAGMA/EXPLAIN/SHOW/DESCRIBE) follows the read grant. " +
    "Read-phase roles are capped to SELECT/inspection regardless of the grant. The capability " +
    "accepts only granted statement families and excludes destructive DDL such as DROP and TRUNCATE. One statement " +
    "per call; read results are row- and byte-capped.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A single SQL statement to execute.",
      },
      maxRows: {
        type: "integer",
        description: "Maximum rows to return for read queries. Default: 200, max: 1000.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};
