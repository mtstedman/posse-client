const SENTENCE_RE = /[^.!?\r\n]+[.!?\r\n]*/gu;

const DIRECT_QUESTION_RE =
  /(?:^|[.!?\r\n]\s*)(?:why|what|where|how|who|when|which)\b|(?:^|[.!?\r\n]\s*)(?:can|could|would|will|do|does|is|are|should)\b[^.!?\r\n]*\?/iu;
const IMAGE_ACTION_RE = /\b(?:generate|create|make|draw|design|render|produce)\b/iu;
const IMAGE_NOUN_RE = /\b(?:images?|photos?|pictures?|illustrations?|banners?|icons?|logos?|artworks?|png|jpe?g|webp)\b/iu;
const DEPICTION_RE =
  /\b(?:images?|photos?|pictures?|illustrations?|artworks?)\b[^.!?\r\n]{0,30}\b(?:of|showing|depicting|featuring|with)\b/iu;
const INTERACTION_NOOP_RE =
  /\b(?:click(?:s|ed|ing)?|tap(?:s|ped|ping)?|press(?:es|ed|ing)?|select(?:s|ed|ing)?|submit(?:s|ted|ting)?)\b[^.!?\r\n]{0,100}\b(?:nothing(?:\s+happens?)?|no\s+(?:response|result|effect|output)|does\s+not\s+respond|doesn't\s+respond|unresponsive|inert|no[- ]?op)\b/iu;
const NAMED_ACTION_FAILURE_RE =
  /\b(?:generate|create|render|save|upload|download|submit|send|open|load|sign\s*in|log\s*in)(?:\s+[\p{L}\p{N}_'"/-]+){0,5}\s+(?:does\s+not|doesn't|did\s+not|didn't|won't|will\s+not|stopped)\s+work\b/iu;
const IMAGE_GENERATION_FAILURE_RE =
  /\b(?:images?\s+generation|image[- ]?gen)\b[^.!?\r\n]{0,60}\b(?:does\s+not|doesn't|did\s+not|didn't|won't|will\s+not|stopped)\s+work\b|\b(?:does\s+not|doesn't|did\s+not|didn't|won't|will\s+not)\b[^.!?\r\n]{0,60}\b(?:images?\s+generation|image[- ]?gen)\b[^.!?\r\n]{0,20}\bwork\b/iu;
const PROVIDER_ACTION_FAILURE_RE =
  /\b(?:can\s*not|cannot|can't|unable\s+to|fails?\s+to|failed\s+to)\b[^.!?\r\n]{0,100}\b(?:generate|create|render|save|upload|download|submit|send|open|load)\b[^.!?\r\n]{0,100}\b(?:with|using|via|through)\s+[\p{L}\p{N}_.-]+/iu;
const GENERIC_ACTION_FAILURE_RE =
  /\b(?:can\s*not|cannot|can't|unable\s+to|fails?\s+to|failed\s+to)\b[^.!?\r\n]{0,100}\b(?:generate|create|render|save|upload|download|submit|send|open|load)\b/iu;
const GENERIC_FAILURE_RE =
  /\b(?:does\s+not|doesn't|did\s+not|didn't|won't|will\s+not|stopped)\s+work\b|\b(?:unresponsive|inert|no[- ]?op)\b|\bnothing\s+happens?\b/iu;
const PRODUCT_CONTEXT_RE =
  /\b(?:button|control|form|endpoint|api|provider|model|service|feature|workflow|flow|page|screen|dialog|menu|app|application|ui|frontend|backend|request|response|click|tap|press|submit)\b/iu;

export function hasDirectQuestionIntent(text = "") {
  return DIRECT_QUESTION_RE.test(String(text || ""));
}

export function looksLikeImageDepictionRequest(text = "") {
  const value = String(text || "");
  return IMAGE_ACTION_RE.test(value) && IMAGE_NOUN_RE.test(value) && DEPICTION_RE.test(value);
}

/**
 * Detect an operational failure report without treating the subject of a
 * requested illustration as a broken product feature. The high-weight
 * patterns deliberately describe observable application behavior; generic
 * inability language needs corroborating product context or another failure
 * clause before it can change routing.
 */
export function hasFunctionalFailureIntent(text = "") {
  const value = String(text || "");
  if (!value.trim()) return false;

  const interactionNoop = INTERACTION_NOOP_RE.test(value);
  const namedActionFailure = NAMED_ACTION_FAILURE_RE.test(value);
  const imageGenerationFailure = IMAGE_GENERATION_FAILURE_RE.test(value);
  const providerActionFailure = PROVIDER_ACTION_FAILURE_RE.test(value);
  const depiction = looksLikeImageDepictionRequest(value);

  if (interactionNoop || providerActionFailure || imageGenerationFailure) return true;
  if (namedActionFailure && !depiction) return true;

  const sentences = value.match(SENTENCE_RE) || [value];
  let failureClauses = 0;
  let genericActionFailure = false;
  let productContext = false;
  for (const sentence of sentences) {
    if (GENERIC_FAILURE_RE.test(sentence) || GENERIC_ACTION_FAILURE_RE.test(sentence)) failureClauses++;
    if (GENERIC_ACTION_FAILURE_RE.test(sentence)) genericActionFailure = true;
    if (PRODUCT_CONTEXT_RE.test(sentence)) productContext = true;
  }

  if (depiction && !productContext && failureClauses < 2) return false;
  return failureClauses >= 2 || (genericActionFailure && productContext);
}

export function classifyRequestSemantics(text = "") {
  return Object.freeze({
    direct_question: hasDirectQuestionIntent(text),
    functional_failure: hasFunctionalFailureIntent(text),
    image_depiction: looksLikeImageDepictionRequest(text),
  });
}
