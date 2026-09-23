// Rank code.survey files for the compact provider-visible names projection.
// Inputs are limited to the visible assignment and repository-derived survey
// data. This module never sees benchmark keys, grades, expected answers, or
// historical outcomes.

import { SURVEY_DEPENDENCY_DISPLAY, SURVEY_OUTLINE_KINDS } from "../../../../catalog/source-display.js";

/** Preserve source availability facts without copying prefetch instructions. */
export function surveyDependencyOutline(boundaries) {
  const lines = [];
  const seen = new Set();
  let chars = 0;
  const singleLine = value => String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  for (const boundary of Array.isArray(boundaries) ? boundaries : []) {
    const name = singleLine(boundary?.dependency);
    if (!name) continue;
    const version = singleLine(boundary.version);
    const manifest = singleLine(boundary.manifest);
    const labels = SURVEY_DEPENDENCY_DISPLAY.statusLabels;
    const status = Object.hasOwn(labels, boundary.sourceStatus) ? labels[boundary.sourceStatus] : "unknown";
    const line = `- ${name}${version ? ` (${version})` : ""}: ${status}${manifest ? `; manifest=${manifest}` : ""}`;
    if (seen.has(line) || line.length > SURVEY_DEPENDENCY_DISPLAY.maxLineChars) continue;
    if (chars + line.length + 1 > SURVEY_DEPENDENCY_DISPLAY.maxChars) break;
    seen.add(line);
    lines.push(line);
    chars += line.length + 1;
    if (lines.length >= SURVEY_DEPENDENCY_DISPLAY.maxItems) break;
  }
  return lines;
}

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

function terminalName(value) {
  return String(value || "").split(/[.#:/\\]/).filter(Boolean).at(-1) || "";
}

function containsIdentifier(text, identifier) {
  if (identifier.length < 4) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(text);
}

function isDistinctiveIdentifier(identifier) {
  return identifier.includes("_")
    || /[a-z][A-Z]/.test(identifier)
    || /^[A-Z][A-Za-z0-9_$]{3,}$/.test(identifier);
}

function surveySymbolCatalog(files) {
  const byFull = new Map();
  const byTerminal = new Map();
  let order = 0;
  for (const file of Array.isArray(files) ? files : []) {
    for (const symbol of Array.isArray(file?.symbols) ? file.symbols : []) {
      const full = symbolName(symbol);
      if (!full || byFull.has(full)) continue;
      const entry = { full, terminal: terminalName(full), path: String(file?.path || "").trim(), order: order++ };
      byFull.set(full, entry);
      const key = entry.terminal.toLowerCase();
      if (key) byTerminal.set(key, [...(byTerminal.get(key) || []), entry]);
    }
  }
  return { byFull, byTerminal };
}

function resolveUniqueSymbol(value, catalog) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (catalog.byFull.has(raw)) return raw;
  const exactFolded = [...catalog.byFull.keys()].filter((name) => name.toLowerCase() === raw.toLowerCase());
  if (exactFolded.length === 1) return exactFolded[0];
  const matches = catalog.byTerminal.get(terminalName(raw).toLowerCase()) || [];
  return matches.length === 1 ? matches[0].full : null;
}

/** Select real declarations before imports/container aliases, using survey metadata. */
export function surveyOutlineSymbols(file, { taskText = "" } = {}) {
  const requested = taskTokens(taskText);
  const seen = new Set();
  return (Array.isArray(file?.symbols) ? file.symbols : [])
    .map((symbol, index) => {
      const name = symbolName(symbol);
      const kind = String(symbol?.kind || "").toLowerCase();
      const callable = SURVEY_OUTLINE_KINDS.callables.includes(kind);
      const declaration = SURVEY_OUTLINE_KINDS.declarations.includes(kind);
      const container = SURVEY_OUTLINE_KINDS.containers.includes(kind);
      const matches = normalizedTokens(name).filter(token => requested.has(token)).length;
      const canonicalName = name.replace(/::|[\\/#]/g, ".");
      return { name, index, canonicalName, symbolId: symbol?.symbolId,
        rank: callable ? 3 : declaration ? 2 : container ? 0 : 1, matches };
    })
    .filter(entry => entry.name)
    .sort((a, b) => b.rank - a.rank || b.matches - a.matches || a.index - b.index)
    .filter(entry => {
      const nameKey = `name:${entry.canonicalName}`;
      const symbolKey = entry.symbolId ? `id:${entry.symbolId}` : null;
      if (seen.has(nameKey) || (symbolKey && seen.has(symbolKey))) return false;
      seen.add(nameKey);
      if (symbolKey) seen.add(symbolKey);
      return true;
    })
    .map(entry => entry.name);
}

/** Render bounded orientation from already-ranked survey files, not source evidence. */
// Anonymous callbacks (`<anonymous@23:53>`) name nothing a reader can search
// for or fetch, and example/demo trees are rarely the implementation. In
// HARD-40 code maps they averaged 3 of 45 listed symbols and whole example
// files ahead of source. Keep example files (a task may be about them) but
// list them after source; never list anonymous names.
const EXAMPLE_PATH_RE = /(?:^|\/)(?:examples?|demos?|samples?)\//i;
const ANONYMOUS_SYMBOL_RE = /<anonymous@/;

export function surveyFileOutline(files) {
  const lines = [];
  const seen = new Set();
  let chars = 0;
  const list = Array.isArray(files) ? files : [];
  const ordered = [
    ...list.filter((file) => !EXAMPLE_PATH_RE.test(String(file?.path || ""))),
    ...list.filter((file) => EXAMPLE_PATH_RE.test(String(file?.path || ""))),
  ];
  for (const file of ordered) {
    const filePath = String(file?.path || "").trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    let line = `- ${filePath}`;
    if (line.length > 480) continue;
    const names = [...new Set((Array.isArray(file.outlineSymbols) ? file.outlineSymbols : Array.isArray(file.symbols) ? file.symbols : [])
      .map(symbolName).filter((name) => name && !ANONYMOUS_SYMBOL_RE.test(name)))];
    let shown = 0;
    for (const name of names) {
      const suffix = `${shown ? ", " : ": "}${name}`;
      if (shown >= 6) break;
      if (line.length + suffix.length > 480) continue;
      line += suffix;
      shown += 1;
    }
    if (chars + line.length + 1 > 4000) break;
    lines.push(line);
    chars += line.length + 1;
    if (lines.length === 8) break;
  }
  return lines;
}

/**
 * Produce an intentionally tiny, abstaining researcher orientation surface.
 * Roots must be uniquely resolved survey symbols explicitly named by the task;
 * arrows must be exact repository call-map edges whose endpoints both resolve
 * to full survey symbol names. No file, line, kind, score, or prose metadata is
 * admitted to this projection.
 */
export function thinSurveyDirection(files, { taskText = "", callMap = null, maxRoots = 3, maxEdges = 6 } = {}) {
  const catalog = surveySymbolCatalog(files);
  const task = String(taskText || "");
  const roots = [...catalog.byFull.values()]
    .filter((entry) => (entry.full !== entry.terminal && containsIdentifier(task, entry.full))
      || (isDistinctiveIdentifier(entry.terminal) && containsIdentifier(task, entry.terminal)))
    .filter((entry) => (catalog.byTerminal.get(entry.terminal.toLowerCase()) || []).length === 1)
    .sort((a, b) => b.terminal.length - a.terminal.length || a.order - b.order)
    .slice(0, Math.max(0, maxRoots))
    .map((entry) => entry.full);
  if (roots.length === 0) return { treePaths: [], roots: [], edges: [] };

  const rootSet = new Set(roots);
  const edges = [];
  const seen = new Set();
  edgeGroups: for (const group of [callMap?.inbound, callMap?.outbound, callMap?.edges]) {
    for (const edge of Array.isArray(group) ? group : []) {
      const from = resolveUniqueSymbol(edge?.from, catalog);
      const to = resolveUniqueSymbol(edge?.to, catalog);
      if (!from || !to || (!rootSet.has(from) && !rootSet.has(to))) continue;
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
      if (edges.length >= Math.max(0, maxEdges)) break edgeGroups;
    }
  }
  const mapSymbols = new Set([...roots, ...edges.flatMap((edge) => [edge.from, edge.to])]);
  const treePaths = [...new Set([...mapSymbols]
    .map((symbol) => catalog.byFull.get(symbol)?.path)
    .filter(Boolean))].slice(0, 8);
  return { treePaths, roots, edges };
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
