// @ts-check

import { LANGUAGES } from "../parser/languages/index.js";

export const EXT_TO_LANG = Object.freeze(Object.fromEntries(
  LANGUAGES.flatMap((descriptor) => descriptor.extensions.map((ext) => [ext, descriptor.tag])),
));

/**
 * @param {string} filePath
 */
export function languageForPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  return EXT_TO_LANG[ext] || "unknown";
}

/**
 * @param {string[]} paths
 * @returns {Map<string, string[]>}
 */
export function bucketPathsByLanguage(paths) {
  const buckets = new Map();
  for (const raw of paths || []) {
    const filePath = String(raw || "");
    const lang = languageForPath(filePath);
    if (!buckets.has(lang)) buckets.set(lang, []);
    buckets.get(lang).push(filePath);
  }
  return buckets;
}
