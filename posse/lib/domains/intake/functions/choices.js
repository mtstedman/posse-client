import { REQUEST_KIND_CHOICES, ITERATIVE_WORKFLOW_CHOICES } from "../../../catalog/intake.js";

export function defaultOutputModeForMode(fallbackMode = "build") {
  return "auto";
}

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
