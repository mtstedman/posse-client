// @ts-check

import { tokenizeForRanking } from "./tokens.js";

/**
 * Reorder symbols only within the result slots already occupied by their file.
 * The repository-path sequence is invariant, so this opt-in cannot change file
 * recall; it only selects the most query-relevant symbol for each file slot.
 *
 * @param {any[]} entries
 * @param {string} query
 * @returns {Promise<any[]>}
 */
export async function applyWithinFileSymbolReranking(entries, query) {
  const input = Array.isArray(entries) ? entries : [];
  if (input.length < 2 || !String(query || "").trim()) return input;
  const queryTokens = new Set(await tokenizeForRanking(query));
  if (queryTokens.size === 0) return input;

  const groups = new Map();
  for (let index = 0; index < input.length; index++) {
    const file = candidatePath(input[index]);
    if (!file) continue;
    const positions = groups.get(file) || [];
    positions.push(index);
    groups.set(file, positions);
  }

  const output = input.slice();
  for (const positions of groups.values()) {
    if (positions.length < 2) continue;
    const ranked = await Promise.all(positions.map(async (position, originalOrder) => {
      const entry = input[position];
      const evidence = await withinFileEvidence(entry, queryTokens);
      return { entry, evidence, originalOrder };
    }));
    ranked.sort((left, right) => right.evidence.score - left.evidence.score
      || right.evidence.overlap - left.evidence.overlap
      || left.originalOrder - right.originalOrder
      || String(left.entry?.id || "").localeCompare(String(right.entry?.id || "")));
    for (let index = 0; index < positions.length; index++) {
      output[positions[index]] = {
        ...ranked[index].entry,
        withinFileRanking: ranked[index].evidence,
      };
    }
  }
  return output;
}

async function withinFileEvidence(entry, queryTokens) {
  const symbol = candidatePayload(entry);
  const text = [
    symbol.name,
    symbol.qualified_name,
    symbol.qualifiedName,
    symbol.signature_text,
    symbol.signature,
    symbol.doc,
    symbol.container,
    symbol.container_name,
    symbol.parent_name,
  ].filter(Boolean).join(" ");
  const symbolTokens = new Set(await tokenizeForRanking(text));
  let overlap = 0;
  for (const token of queryTokens) if (symbolTokens.has(token)) overlap++;
  const queryCoverage = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
  const symbolPrecision = symbolTokens.size > 0 ? overlap / symbolTokens.size : 0;
  const exactName = queryTokens.has(String(symbol.name || "").trim().toLowerCase());
  return {
    overlap,
    queryCoverage,
    symbolPrecision,
    exactName,
    score: queryCoverage * 0.75 + symbolPrecision * 0.25 + (exactName ? 0.25 : 0),
  };
}

function candidatePayload(entry) {
  return entry?.payload && typeof entry.payload === "object" ? entry.payload : entry || {};
}

function candidatePath(entry) {
  const symbol = candidatePayload(entry);
  return String(
    symbol.repo_rel_path
      || symbol.repoRelPath
      || symbol.location?.repo_rel_path
      || symbol.location?.repoRelPath
      || symbol.file
      || "",
  ).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").toLowerCase();
}
