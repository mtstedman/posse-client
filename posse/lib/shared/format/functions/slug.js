const ALPHABET_PATTERNS = Object.freeze({
  "alnum-dash": /[^a-z0-9]+/g,
  id: /[^a-z0-9_-]+/g,
  filename: /[^a-z0-9._-]+/g,
  path: /[^a-z0-9/_-]+/g,
});

export function slugify(value, {
  alphabet = "alnum-dash",
  fallback = "item",
  maxLength = null,
  preserveCase = false,
} = {}) {
  const pattern = alphabet instanceof RegExp ? alphabet : (ALPHABET_PATTERNS[alphabet] || ALPHABET_PATTERNS["alnum-dash"]);
  const activePattern = preserveCase && !pattern.ignoreCase
    ? new RegExp(pattern.source, `${pattern.flags}i`)
    : pattern;
  let slug = String(value || "").trim();
  if (!preserveCase) slug = slug.toLowerCase();
  slug = slug
    .replace(activePattern, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._/]+|[-._/]+$/g, "");
  if (Number.isFinite(Number(maxLength)) && Number(maxLength) > 0) {
    slug = slug.slice(0, Number(maxLength)).replace(/^[-._/]+|[-._/]+$/g, "");
  }
  return slug || fallback;
}
