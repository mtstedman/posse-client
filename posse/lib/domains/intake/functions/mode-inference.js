const IMAGE_MODE_ACTION_RE = /\b(generate|create|make|draw|design)\b/i;
const IMAGE_MODE_NOUN_RE = /\b(image|photo|picture|illustration|banner|icon|logo|artwork|mermaid)\b/i;
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

export function inferWiMode(text) {
  const lower = String(text || "").toLowerCase();
  if (hasImageModeIntent(lower)) return "image";
  const reportAction = "\\b(write|prepare|draft|produce|create|generate|compile|export|deliver|analy[sz](?:e|ed|es|ing)|summari[sz](?:e|ed|es|ing))\\b";
  const reportObject = "\\b(report|summary|write[- ]?up|analysis|brief|csv|spreadsheet|analy[sz](?:e|ed|es|ing))\\b";
  if (new RegExp(`${reportAction}[\\s\\S]{0,80}${reportObject}`, "i").test(lower)) return "report";
  if (new RegExp(`${reportObject}[\\s\\S]{0,80}${reportAction}`, "i").test(lower)) return "report";
  const directAnalysisIntent = /\b(summary|analysis|brief)\s+of\b/i.test(lower)
    || /\b(analy[sz](?:e|ed|es|ing)|summari[sz](?:e|ed|es|ing))\b/i.test(lower);
  const mutationIntent = /\b(fix|implement|change|update|modify|edit|refactor|add|remove|delete|migrate|build)\b/i.test(lower);
  if (directAnalysisIntent && !mutationIntent) return "report";
  return null;
}
