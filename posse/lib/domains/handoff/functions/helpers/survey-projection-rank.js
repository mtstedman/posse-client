// Rank code.survey files for the compact provider-visible names projection.
// Inputs are limited to the visible assignment and repository-derived survey
// data. This module never sees benchmark keys, grades, expected answers, or
// historical outcomes.

const TOKEN_STOP = new Set([
  "across", "behavior", "code", "concrete", "deliverable", "deliverables",
  "distinguish", "enumerate", "evidence", "explain", "false", "file",
  "identify", "internal", "least", "named", "normal", "ordered", "plausible",
  "read", "reconstruct", "relevant", "repository", "source", "trace", "where",
]);

const PUBLIC_SURFACE_STEMS = new Set([
  "api", "index", "init", "main", "mod", "package", "public",
]);

function words(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9]*/g) || [];
}

function stem(value) {
  let token = String(value || "").toLowerCase();
  for (const suffix of ["ization", "isation", "ments", "ment", "ations", "ation", "izers", "izer", "ing", "ers", "er", "ies", "es", "s"]) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) {
      token = suffix === "ies" ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length);
      break;
    }
  }
  return token;
}

function normalizedTokens(value) {
  return [...new Set(words(value).map(stem).filter((token) => token.length >= 3))];
}

function taskTokens(taskText) {
  return new Set(normalizedTokens(taskText).filter((token) => !TOKEN_STOP.has(token)));
}

function symbolName(symbol) {
  return String(symbol?.qualifiedName || symbol?.qualified_name || symbol?.name || symbol || "").trim();
}

function publicSurfaceWeight(filePath) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const basename = parts.at(-1) || "";
  const withoutExtensions = basename.replace(/(?:\.[^.]+)+$/u, "").replace(/^_+|_+$/g, "").toLowerCase();
  if (!PUBLIC_SURFACE_STEMS.has(withoutExtensions)) return 0;
  if (["api", "public"].includes(withoutExtensions)) return 320;
  return parts.length <= 3 ? 280 : 60;
}

function taskMatchCount(file, requested) {
  if (requested.size === 0) return 0;
  const candidate = new Set([
    ...normalizedTokens(file?.path),
    ...(Array.isArray(file?.symbols) ? file.symbols.flatMap((symbol) => normalizedTokens(symbolName(symbol))) : []),
  ]);
  let matches = 0;
  for (const token of requested) {
    if ([...candidate].some((value) => value === token || (value.length >= 5 && token.length >= 5 && (value.startsWith(token) || token.startsWith(value))))) {
      matches += 1;
    }
  }
  return matches;
}

function relationNames(callMap) {
  const names = new Map();
  for (const group of ["inbound", "outbound", "edges", "unresolved"]) {
    for (const edge of Array.isArray(callMap?.[group]) ? callMap[group] : []) {
      const count = Math.max(1, Number(edge?.count) || 1);
      for (const value of [edge?.from, edge?.to]) {
        const key = normalizedTokens(value).join(" ");
        if (key) names.set(key, (names.get(key) || 0) + count);
      }
    }
  }
  return names;
}

function relationWeight(file, related) {
  if (related.size === 0) return 0;
  let weight = 0;
  for (const symbol of Array.isArray(file?.symbols) ? file.symbols : []) {
    const key = normalizedTokens(symbolName(symbol)).join(" ");
    if (key && related.has(key)) weight += related.get(key);
  }
  return Math.min(12, weight);
}

/**
 * Promote provider-visible survey candidates without changing the stored
 * survey, source evidence, or agent tool surface. The returned file objects
 * are unchanged; only their compact projection order differs.
 */
export function rankSurveyFilesForProjection(files, { taskText = "", callMap = null } = {}) {
  const rows = Array.isArray(files) ? files.filter((file) => file && String(file.path || "").trim()) : [];
  const requested = taskTokens(taskText);
  const related = relationNames(callMap);
  return rows
    .map((file, index) => {
      const publicSurface = publicSurfaceWeight(file.path);
      const taskMatches = taskMatchCount(file, requested);
      const graphWeight = relationWeight(file, related);
      return {
        file,
        index,
        promoted: publicSurface > 0 || taskMatches > 0 || graphWeight > 0,
        score: publicSurface
          + (Math.min(6, taskMatches) * 70)
          + (graphWeight * 12)
          + Math.max(0, 40 - index),
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ file }) => file);
}
