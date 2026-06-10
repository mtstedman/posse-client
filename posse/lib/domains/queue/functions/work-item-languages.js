// @ts-check

import { bucketPathsByLanguage } from "../../atlas/functions/v2/parse/language-buckets.js";

function normalizePaths(value) {
  if (Array.isArray(value)) return value.map((path) => String(path || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (value && typeof value === "object" && Array.isArray(value.paths)) return normalizePaths(value.paths);
  return [];
}

export function workItemLanguageBuckets(scope = {}) {
  const paths = normalizePaths(scope);
  const buckets = bucketPathsByLanguage(paths);
  buckets.delete("unknown");
  return buckets;
}

export function workItemLanguages(scope = {}) {
  return [...workItemLanguageBuckets(scope).keys()].sort();
}
