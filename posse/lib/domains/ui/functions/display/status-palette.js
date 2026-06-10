import { C as defaultColors } from "../../../../shared/format/functions/colors.js";

export const MODEL_TIER_COLOR_KEYS = Object.freeze({
  cheap: "dim",
  standard: "cyan",
  strong: "magenta",
});

const STATUS_COLOR_KEYS = Object.freeze({
  complete: "green",
  completed: "green",
  succeeded: "green",
  pass: "green",
  recovered: "green",
  failed: "red",
  dead_letter: "red",
  fail: "red",
  parse_error: "red",
  canceled: "red",
  running: "blue",
  leased: "blue",
  queued: "blue",
  planning: "cyan",
  planned: "cyan",
  awaiting_assessment: "yellow",
  blocked: "yellow",
  waiting_on_human: "yellow",
  waiting_on_review: "yellow",
  needs_review: "yellow",
  needs_replan: "yellow",
  not_assessed: "dim",
  timeout: "yellow",
  in_progress: "blue",
});

export function statusColorKey(status) {
  return STATUS_COLOR_KEYS[String(status || "")] || "dim";
}

export function statusColor(status, colors = defaultColors) {
  return colors[statusColorKey(status)] || colors.dim || "";
}

export function modelTierColorKey(tier) {
  return MODEL_TIER_COLOR_KEYS[String(tier || "")] || "dim";
}

export function modelTierColor(tier, colors = defaultColors) {
  return colors[modelTierColorKey(tier)] || colors.dim || "";
}

export function statusIcon(status, { kind = "job", colors = defaultColors } = {}) {
  const s = String(status || "");
  const color = statusColor(s, colors);
  if (kind === "work_item") {
    if (s === "complete") return `${color}+`;
    if (s === "failed" || s === "canceled") return `${color}x`;
    if (s === "running") return `${color}>`;
    if (s === "queued" || s === "planning" || s === "planned") return `${color}o`;
    if (s === "blocked" || s.startsWith("waiting_on_")) return `${color}||`;
    return `${color}o`;
  }

  if (s === "succeeded" || s === "completed") return `${color}+`;
  if (s === "failed" || s === "canceled") return `${color}x`;
  if (s === "dead_letter") return `${color}!!`;
  if (s === "running" || s === "leased") return `${color}>`;
  if (s === "queued") return `${color}o`;
  if (s === "awaiting_assessment") return `${color}?`;
  if (s === "blocked") return `${color}||`;
  if (s === "timeout") return `${color}!`;
  return `${color}~`;
}
