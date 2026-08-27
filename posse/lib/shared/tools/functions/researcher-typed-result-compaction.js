// @ts-check

const CANONICAL_SYMBOL_ID = /^[0-9a-f]{64}:[0-9]+$/u;
const SYMBOL_HANDLE = /^s[1-9][0-9]{0,5}$/u;

/**
 * Remove transport-only or invariant fields from one typed Atlas JSON result.
 * Exact source, relationships, identifiers found, non-empty exceptions, short
 * handles, and the model-control suffix remain intact.
 *
 * @param {string} text
 * @param {{ action?: string | null }} [options]
 * @returns {{
 *   text: string,
 *   removedCanonicalSymbolIds: number,
 *   removedDigestFields: number,
 *   removedDefaultFields: number,
 * } | null}
 */
export function compactResearcherTypedAtlasText(text, { action = null } = {}) {
  if (typeof text !== "string") return null;
  const suffixAt = text.indexOf("\n\n[");
  const jsonText = suffixAt >= 0 ? text.slice(0, suffixAt) : text;
  const suffix = suffixAt >= 0 ? text.slice(suffixAt) : "";
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  let removedCanonicalSymbolIds = 0;
  let removedDigestFields = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) visit(child);
    if (
      typeof value.symbolId === "string"
      && CANONICAL_SYMBOL_ID.test(value.symbolId)
      && SYMBOL_HANDLE.test(String(value.symbolHandle || ""))
    ) {
      delete value.symbolId;
      removedCanonicalSymbolIds += 1;
    }
    for (const field of ["contentSha256", "content_hash"]) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      delete value[field];
      removedDigestFields += 1;
    }
  };
  visit(parsed);

  let removedDefaultFields = 0;
  if (action === "code.window") {
    if (Object.prototype.hasOwnProperty.call(parsed, "estimatedTokens")) {
      delete parsed.estimatedTokens;
      removedDefaultFields += 1;
    }
    for (const field of ["truncated", "outputTruncated"]) {
      if (parsed[field] !== false) continue;
      delete parsed[field];
      removedDefaultFields += 1;
    }
    const identifiersComplete = (
      Array.isArray(parsed.identifiersReturned)
      && Array.isArray(parsed.identifiersFound)
      && JSON.stringify(parsed.identifiersReturned) === JSON.stringify(parsed.identifiersFound)
      && Array.isArray(parsed.identifiersMissing)
      && parsed.identifiersMissing.length === 0
      && Array.isArray(parsed.identifiersOmitted)
      && parsed.identifiersOmitted.length === 0
    );
    if (identifiersComplete) {
      delete parsed.identifiersReturned;
      delete parsed.identifiersMissing;
      delete parsed.identifiersOmitted;
      parsed.identifiersComplete = true;
      removedDefaultFields += 3;
    } else {
      for (const field of ["identifiersMissing", "identifiersOmitted"]) {
        if (!Array.isArray(parsed[field]) || parsed[field].length !== 0) continue;
        delete parsed[field];
        removedDefaultFields += 1;
      }
    }
    if (parsed.map && typeof parsed.map === "object" && parsed.map.version === 2) {
      delete parsed.map.version;
      removedDefaultFields += 1;
    }
  }

  const compacted = `${JSON.stringify(parsed)}${suffix}`;
  if (compacted === text) return null;
  return {
    text: compacted,
    removedCanonicalSymbolIds,
    removedDigestFields,
    removedDefaultFields,
  };
}
