import {
  hasDirectQuestionIntent,
  hasFunctionalFailureIntent,
} from "./request-semantics.js";
import {
  hasExplicitRepoWorkIntent,
  hasPassiveRepoRequirementIntent,
  hasRepoMutationIntent,
} from "./implementation-intent.js";

const VALID_OUTPUTS = new Set(["repo", "artifact", "question_only"]);
const VALID_SOURCES = new Set(["explicit", "inferred"]);

export function parseWorkItemMetadata(workItem = null) {
  try {
    const parsed = workItem?.metadata_json ? JSON.parse(workItem.metadata_json) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedSource(value, fallback = "inferred") {
  const source = String(value || "").trim().toLowerCase();
  return VALID_SOURCES.has(source) ? source : fallback;
}

function normalizedOutputs(values = []) {
  const raw = Array.isArray(values) ? values : [values];
  return [...new Set(raw
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => VALID_OUTPUTS.has(value)))];
}

export function getWorkItemModeSource(workItem = null, metadata = null) {
  const record = metadata || parseWorkItemMetadata(workItem);
  const source = String(record.mode_source || "").trim().toLowerCase();
  if (VALID_SOURCES.has(source)) return source;
  if (workItem?.source === "image" || workItem?.source === "ask") return "explicit";
  return "legacy";
}

/**
 * Resolve the terminal output classes required by the user's objective.
 * Explicit contracts are immutable. Strong operational-failure semantics may
 * correct only inferred artifact routing.
 */
export function requiredWorkItemOutputs(workItem = null, intakeHints = {}) {
  const metadata = parseWorkItemMetadata(workItem);
  const mode = String(workItem?.mode || "build").trim().toLowerCase() || "build";
  const source = String(workItem?.source || "").trim().toLowerCase();
  const modeSource = getWorkItemModeSource(workItem, metadata);
  const desiredOutputs = normalizedOutputs(intakeHints.desired_outputs);
  const desiredSource = normalizedSource(intakeHints.desired_outputs_source);
  const outputMode = String(intakeHints.output_mode || "auto").trim().toLowerCase();
  const outputModeSource = normalizedSource(intakeHints.output_mode_source);
  const text = workItem?.description || workItem?.title || "";

  // These CLI entry points are themselves explicit terminal-output contracts.
  // In particular, `ask` historically stores the default DB mode (`build`),
  // which must not turn a research-only question into a repository objective.
  if (source === "ask") return ["question_only"];
  if (source === "image") return ["artifact"];
  if (desiredSource === "explicit" && desiredOutputs.length > 0) return desiredOutputs;
  if (outputModeSource === "explicit") {
    if (outputMode === "repo") return ["repo"];
    if (outputMode === "artifact") return ["artifact"];
    if (outputMode === "question_only") return ["question_only"];
  }
  if (modeSource === "explicit") {
    if (mode === "image" || mode === "report") return ["artifact"];
    if (mode === "build") return ["repo"];
  }

  if (hasFunctionalFailureIntent(text) && !hasDirectQuestionIntent(text)) return ["repo"];
  if (desiredOutputs.length > 0) return desiredOutputs;
  if (hasDirectQuestionIntent(text)) return ["question_only"];
  if (mode === "image" || mode === "report") return ["artifact"];
  return ["repo"];
}

/**
 * The plan compiler's early rejection is intentionally narrower than the
 * default output resolver. It activates only for an explicit repo contract or
 * strong implementation semantics, never merely because an otherwise
 * ambiguous work item fell back to build mode.
 */
export function requiresRepositoryExecution(workItem = null, intakeHints = {}) {
  const metadata = parseWorkItemMetadata(workItem);
  const mode = String(workItem?.mode || "build").trim().toLowerCase() || "build";
  const source = String(workItem?.source || "").trim().toLowerCase();
  const modeSource = getWorkItemModeSource(workItem, metadata);
  const desiredOutputs = normalizedOutputs(intakeHints.desired_outputs);
  const desiredSource = normalizedSource(intakeHints.desired_outputs_source);
  const outputMode = String(intakeHints.output_mode || "auto").trim().toLowerCase();
  const outputModeSource = normalizedSource(intakeHints.output_mode_source);
  const intentType = String(intakeHints.intent_type || "").trim().toLowerCase();
  const intentSource = normalizedSource(intakeHints.intent_type_source);
  const text = workItem?.description || workItem?.title || "";

  if (source === "ask" || source === "image") return false;
  if (desiredSource === "explicit") return desiredOutputs.includes("repo");
  if (outputModeSource === "explicit" && outputMode !== "auto") return outputMode === "repo";
  if (modeSource === "explicit") return mode === "build";
  if (intentSource === "explicit" && ["task", "bugfix", "oneshot"].includes(intentType)) return true;
  if (intentType === "bugfix") return true;
  if (hasFunctionalFailureIntent(text) && !hasDirectQuestionIntent(text)) return true;
  return hasExplicitRepoWorkIntent(text)
    || hasPassiveRepoRequirementIntent(text)
    || hasRepoMutationIntent(text, { includeCreate: true, includeCompletion: true });
}

function preserveExplicit(current, source, fallback) {
  return normalizedSource(source) === "explicit" ? current : fallback;
}

export function correctInferredRoutingToRepo(workItem = null, intakeHints = {}) {
  const metadata = parseWorkItemMetadata(workItem);
  const modeSource = getWorkItemModeSource(workItem, metadata);
  const nextHints = {
    ...intakeHints,
    intent_type: preserveExplicit(intakeHints.intent_type, intakeHints.intent_type_source, "bugfix"),
    intent_type_source: normalizedSource(intakeHints.intent_type_source),
    deliverable_type: preserveExplicit(intakeHints.deliverable_type, intakeHints.deliverable_type_source, "code"),
    deliverable_type_source: normalizedSource(intakeHints.deliverable_type_source),
    output_mode: preserveExplicit(intakeHints.output_mode, intakeHints.output_mode_source, "auto"),
    output_mode_source: normalizedSource(intakeHints.output_mode_source),
    desired_outputs: normalizedSource(intakeHints.desired_outputs_source) === "explicit"
      ? normalizedOutputs(intakeHints.desired_outputs)
      : ["repo"],
    desired_outputs_source: normalizedSource(intakeHints.desired_outputs_source),
  };
  return {
    mode: modeSource === "inferred" ? "build" : (workItem?.mode || "build"),
    metadata: {
      ...metadata,
      intake_hints: nextHints,
    },
    changedMode: modeSource === "inferred" && workItem?.mode !== "build",
    previousMode: workItem?.mode || "build",
    modeSource,
    hints: nextHints,
  };
}
