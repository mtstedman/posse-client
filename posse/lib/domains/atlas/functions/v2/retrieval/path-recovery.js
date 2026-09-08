// @ts-check

import { ATLAS_PATH_RECOVERY_POLICY as policy } from "../../../../../catalog/atlas.js";
import { isCanonicalRepoPath } from "../paths.js";

/**
 * Suggestions may cross directories; an executable correction must preserve
 * any directory the caller supplied. Check all observed paths before applying
 * the presentation limit, and never infer uniqueness from a truncated query.
 */
export async function recoverIndexedPath(view, requestedPath) {
  if (typeof view?.query?.indexedPaths !== "function") return { candidates: [] };
  let indexed;
  try {
    indexed = await view.query.indexedPaths({ limit: policy.indexedPathLimit + 1 });
  } catch {
    return { candidates: [] };
  }
  if (!Array.isArray(indexed)) return { candidates: [] };
  const complete = indexed.length <= policy.indexedPathLimit;
  const requested = splitPath(requestedPath);
  const paths = [...new Set(indexed.filter(entry => typeof entry === "string" && isCanonicalRepoPath(entry)))];
  const ranked = paths.map(candidate => {
    const parts = splitPath(candidate);
    const sameDirectory = parts.directory.toLowerCase() === requested.directory.toLowerCase();
    const basenameDistance = editRatio(requested.basename, parts.basename);
    const score = sameDirectory || !requested.directory
      ? basenameDistance
      : Math.min(editRatio(requestedPath, candidate), basenameDistance + 0.15);
    const directoryRank = parts.directory === requested.directory ? 0 : sameDirectory ? 1 : 2;
    return { path: candidate, directory: parts.directory, sameDirectory, directoryRank, basenameDistance, score };
  }).sort((left, right) => (
    (requested.directory ? left.directoryRank - right.directoryRank : 0)
    || left.score - right.score || left.path.localeCompare(right.path)
  ));

  let corrected;
  if (complete && isCanonicalRepoPath(requestedPath)) {
    let eligible = ranked;
    if (requested.directory) {
      const directories = new Set(ranked.filter(row => row.sameDirectory).map(row => row.directory));
      // An exact directory spelling preserves filesystem identity; otherwise
      // there must be just one possible spelling to normalize to.
      const directory = directories.has(requested.directory)
        ? requested.directory
        : directories.size === 1 ? [...directories][0] : null;
      eligible = directory == null ? [] : ranked.filter(row => row.directory === directory);
    }
    // Case-folding can discover spellings, but cannot merge distinct files.
    const exact = eligible.filter(row => requested.directory
      ? row.path.toLowerCase() === requestedPath.toLowerCase()
      : row.basenameDistance === 0);
    if (exact.length === 1) {
      corrected = exact[0];
    } else if (exact.length === 0) {
      const [first, second] = eligible;
      if (first && first.basenameDistance <= policy.maxFilenameCorrectionDistance
          && (!second || second.basenameDistance - first.basenameDistance >= policy.minCorrectionMargin)) {
        corrected = first;
      }
    }
  }
  return {
    candidates: ranked.filter(row => row.score <= policy.maxSuggestionDistance)
      .slice(0, policy.candidateLimit)
      .map(row => ({ path: row.path, score: Number(row.score.toFixed(3)) })),
    ...(corrected ? { correctedPath: corrected.path } : {}),
  };
}

function splitPath(value) {
  const slash = value.lastIndexOf("/");
  return { directory: slash < 0 ? "" : value.slice(0, slash), basename: value.slice(slash + 1) };
}

function editRatio(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return levenshteinDistance(a, b) / Math.max(1, a.length, b.length);
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        prior[j] + 1,
        prior[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    prior = current;
  }
  return prior[right.length];
}
