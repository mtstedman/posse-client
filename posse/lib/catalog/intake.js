// Canonical intake choices and output contract vocabulary.

export const REQUEST_KIND_CHOICES = Object.freeze([
  { value: "task", aliases: ["t"] },
  { value: "bugfix", aliases: ["b", "bug"] },
  { value: "design", aliases: ["d", "ux", "ui"] },
  { value: "context", aliases: ["c"] },
  { value: "question", aliases: ["q"] },
  { value: "oneshot", aliases: ["o", "one-shot"] },
  { value: "image", aliases: ["i"] },
  { value: "report", aliases: ["r"] },
  { value: "analysis", aliases: ["a", "analyze"] },
]);

export const ITERATIVE_WORKFLOW_CHOICES = Object.freeze([
  { value: "bugfix", aliases: ["b", "bug"] },
  { value: "ux", aliases: ["u", "d", "ui", "design"] },
  { value: "refactor", aliases: ["r"] },
  { value: "audit", aliases: ["a"] },
  { value: "iterate", aliases: ["i"] },
]);

export const INTAKE_INTENT_TYPES = Object.freeze(REQUEST_KIND_CHOICES.map((choice) => choice.value));
export const INTAKE_WORKFLOW_MODES = Object.freeze(ITERATIVE_WORKFLOW_CHOICES.map((choice) => choice.value));
export const INTAKE_DELIVERABLE_TYPES = Object.freeze([
  "code", "patch", "answer", "image", "markdown", "pdf", "json", "mixed",
]);
export const INTAKE_TERMINAL_OUTPUTS = Object.freeze(["repo", "artifact", "question_only"]);
export const INTAKE_OUTPUT_MODES = Object.freeze(["auto", ...INTAKE_TERMINAL_OUTPUTS]);
export const INTAKE_HINT_SOURCES = Object.freeze(["explicit", "inferred"]);

// The selector accepts its displayed hotkeys. The legacy free-text parser
// additionally accepts "artifacts" without changing the selector contract.
export const INTAKE_RESPONSE_SHAPE_CHOICES = Object.freeze([
  { value: "auto", label: "Auto", aliases: ["a"] },
  { value: "repo", label: "Repo", aliases: ["r", "code"] },
  { value: "artifact", label: "Artifact", aliases: ["f", "file", "files"], normalizationAliases: ["artifacts"] },
  { value: "question_only", label: "Question", aliases: ["q", "question-only", "question"] },
]);
