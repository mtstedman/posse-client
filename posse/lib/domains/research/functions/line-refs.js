const LINE_REF_PATTERN = String.raw`\b[\w./\\-]+\.[a-zA-Z0-9]{1,8}:\d+(?:-\d+)?\b`;
const URL_REF_PATTERN = String.raw`https?:\/\/[^\s<>"')\]]+`;
const LINE_REF_RE = new RegExp(LINE_REF_PATTERN);
const LINE_REF_RE_G = new RegExp(LINE_REF_PATTERN, "g");
const URL_REF_RE = new RegExp(URL_REF_PATTERN);
const URL_REF_RE_G = new RegExp(URL_REF_PATTERN, "g");

export function hasLineRef(value) {
  return LINE_REF_RE.test(String(value || ""));
}

export function countLineRefs(value) {
  return (String(value || "").match(LINE_REF_RE_G) || []).length;
}

export function hasUrlRef(value) {
  return URL_REF_RE.test(String(value || ""));
}

export function countUrlRefs(value) {
  return (String(value || "").match(URL_REF_RE_G) || []).length;
}
