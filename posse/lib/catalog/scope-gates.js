// Title signals for a broad task whose declared writable scope is narrow.
// Strong signals can enforce the gate; weak signals only warrant a warning.
// "all <singular noun>" (e.g. "all page titles") names a property of one
// thing, not a sweep, so only the plural form is strong after "all".
export const BROAD_SCOPE_STRONG_TITLE_PATTERNS = Object.freeze([
  /\bsite[- ]?wide\b/i,
  /\bcross[- ]page\b/i,
  /\bevery\s+(?:page|form|route|view)\b/i,
  /\ball\s+(?:of\s+)?(?:the\s+)?(?:pages|forms|routes|views)\b/i,
  /\bwhole\s+(?:site|app)\b/i,
  /\baudit\b/i,
]);

export const BROAD_SCOPE_WEAK_TITLE_PATTERNS = Object.freeze([
  /\breview\b/i,
  /\bux\b/i,
  /\bui\b/i,
  /\bflow\b/i,
  /\bforms?\b/i,
  /\bpages?\b/i,
  /\boverall\b/i,
  /\bpolish\b/i,
  /\bglow[- ]?up\b/i,
  /\bhigh value\b/i,
  /\bedge cases?\b/i,
]);
