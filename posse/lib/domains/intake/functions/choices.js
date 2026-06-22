export function defaultOutputModeForMode(fallbackMode = "build") {
  return "auto";
}

const REQUEST_KIND_CHOICES = Object.freeze([
  { value: "task", aliases: ["t"] },
  { value: "bugfix", aliases: ["b", "bug"] },
  { value: "design", aliases: ["d", "ux", "ui"] },
  { value: "context", aliases: ["c"] },
  { value: "question", aliases: ["q"] },
  { value: "image", aliases: ["i"] },
  { value: "report", aliases: ["r"] },
  { value: "analysis", aliases: ["a", "analyze"] },
]);

const ITERATIVE_WORKFLOW_CHOICES = Object.freeze([
  { value: "bugfix", aliases: ["b", "bug"] },
  { value: "ux", aliases: ["u", "d", "ui", "design"] },
  { value: "refactor", aliases: ["r"] },
  { value: "audit", aliases: ["a"] },
  { value: "iterate", aliases: ["i"] },
]);

function normalizeChoice(value, choices, fallback) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  for (const choice of choices) {
    if (raw === choice.value || (choice.aliases || []).includes(raw)) return choice.value;
  }
  return fallback;
}

export function normalizeRequestKindChoice(value, fallback = "task") {
  return normalizeChoice(value, REQUEST_KIND_CHOICES, fallback);
}

export function normalizeIterativeWorkflowModeChoice(value, fallback = "bugfix") {
  return normalizeChoice(value, ITERATIVE_WORKFLOW_CHOICES, fallback);
}
