import { hasExplicitRepoWorkIntent, hasRepoMutationIntent } from "./implementation-intent.js";
import { hasFunctionalFailureIntent } from "./request-semantics.js";

const IMAGE_MODE_ACTION_RE = /\b(generate|create|make|draw|design)\b/i;
const IMAGE_MODE_NOUN_RE = /\b(images?|photos?|pictures?|illustrations?|banners?|icons?|logos?|artworks?|mermaid)\b/i;
const IMAGE_MODE_DIRECT_RE = /\b(dall-?e|midjourney|stable.?diffusion|image.?gen)\b/i;
const NEGATED_IMAGE_MODE_RE = /\b(?:not\s+(?:an?\s+)?|no\s+(?:new\s+)?|without\s+(?:an?\s+)?)(?:image|photo|picture|illustration|banner|icon|logo|artwork|mermaid|images|photos|pictures|illustrations|banners|icons|logos)\b|\b(?:do not|don't|no need to)\s+(?:generate|create|make|draw|design)\b[\s\S]{0,60}\b(?:image|photo|picture|illustration|banner|icon|logo|artwork|mermaid|images|photos|pictures|illustrations|banners|icons|logos)\b/i;

function hasImageModeIntent(text) {
  const source = String(text || "");
  const sentences = source.match(/[^.!?\r\n]+[.!?\r\n]*/g) || [source];
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence || NEGATED_IMAGE_MODE_RE.test(sentence)) continue;
    if (IMAGE_MODE_DIRECT_RE.test(sentence)) return true;
    if (IMAGE_MODE_ACTION_RE.test(sentence) && IMAGE_MODE_NOUN_RE.test(sentence)) return true;
  }
  return false;
}

// Image mode is never inferred from request text alone: a sentence that merely
// mentions images next to a creation verb ("use the thumbnail images ... and
// create a breeding tree") is repo work far more often than an image request.
// Image mode comes from an explicit choice (`--mode image`, `--intent image`,
// `--deliverable image`, `posse image`, the TUI image action), or from the
// request text only once the user explicitly asked for artifact output.

export function inferWiMode(text) {
  const lower = String(text || "").toLowerCase();
  // Creation verbs are legitimate report-generation signals, but explicit
  // repository mutation verbs must keep a mixed "analyze ... and fix it"
  // request in build mode.
  const repoMutationIntent = hasRepoMutationIntent(lower, { includeCompletion: true });
  if (repoMutationIntent || hasExplicitRepoWorkIntent(lower)) return null;
  // Operational failure reports ("generate report doesn't work") are build
  // work, not report requests. Questions remain neutral here so intake hints
  // can retain their read-only contract.
  if (hasFunctionalFailureIntent(lower)) return null;
  const reportAction = "\\b(write|prepare|draft|produce|create|generate|compile|export|deliver|analy[sz](?:e|ed|es|ing)|summari[sz](?:e|ed|es|ing))\\b";
  const reportObject = "\\b(report|summary|write[- ]?up|analysis|brief|csv|spreadsheet|analy[sz](?:e|ed|es|ing))\\b";
  if (!repoMutationIntent && new RegExp(`${reportAction}[\\s\\S]{0,80}${reportObject}`, "i").test(lower)) return "report";
  if (!repoMutationIntent && new RegExp(`${reportObject}[\\s\\S]{0,80}${reportAction}`, "i").test(lower)) return "report";
  const directAnalysisIntent = /\b(summary|analysis|brief)\s+of\b/i.test(lower)
    || /\b(analy[sz](?:e|ed|es|ing)|summari[sz](?:e|ed|es|ing))\b/i.test(lower);
  if (directAnalysisIntent && !repoMutationIntent) return "report";
  return null;
}

function requestsImageExplicitly(hints = {}) {
  return (hints.intent_type_source === "explicit" && String(hints.intent_type || "").toLowerCase() === "image")
    || (hints.deliverable_type_source === "explicit" && String(hints.deliverable_type || "").toLowerCase() === "image");
}

function requestsArtifactOutputExplicitly(hints = {}) {
  const desired = (Array.isArray(hints.desired_outputs) ? hints.desired_outputs : [hints.desired_outputs])
    .map((value) => String(value || "").trim().toLowerCase());
  return hints.desired_outputs_source === "explicit" && desired.includes("artifact") && !desired.includes("repo");
}

/**
 * Resolve a new work item's mode once its intake hints are known. Explicit
 * choices win; an explicit artifact request picks image or report from the
 * request text; otherwise only report mode is ever inferred.
 */
export function resolveWorkItemMode({ explicitMode = null, description = "", intakeHints = null } = {}) {
  if (explicitMode) return { mode: explicitMode, source: "explicit" };
  const hints = intakeHints || {};
  if (requestsImageExplicitly(hints)) return { mode: "image", source: "explicit" };
  if (requestsArtifactOutputExplicitly(hints)) {
    return { mode: hasImageModeIntent(String(description || "").toLowerCase()) ? "image" : "report", source: "explicit" };
  }
  return { mode: inferWiMode(description) || "build", source: "inferred" };
}
