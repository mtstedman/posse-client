// Agents select Atlas targets with the same two fields on every tool: `names`
// (declared names, optionally with `file`) and `symbols` (Atlas symbols taken
// from earlier results). Execution keeps each action's own selector fields, so
// this module folds the unified pair onto them. It is pure and idempotent: a
// call already in the execution shape comes back unchanged, which lets every
// entry point (tool owner, embedded payload preparation, JS dispatch) apply it.

const CANONICAL_SYMBOL_ID = /^[0-9a-f]{64}:[0-9]+$/u;

// Actions whose `symbols` field carries Atlas symbols. On code.survey the
// execution contract's `symbols` holds names and is not agent-facing.
export const ATLAS_SYMBOL_SELECTOR_ACTIONS = Object.freeze([
  "symbol.callers",
  "symbol.get",
  "code.lens",
  "code.window",
]);

export const ATLAS_UNIFIED_SELECTOR_ACTIONS = Object.freeze([
  ...ATLAS_SYMBOL_SELECTOR_ACTIONS,
  "code.skeleton",
  "code.survey",
]);

const SINGLE_SYMBOL_ACTIONS = new Set(["symbol.callers", "code.lens", "code.window"]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalSymbolId(value) {
  return CANONICAL_SYMBOL_ID.test(value);
}

// Returns null when the value is not a list of strings, so the caller leaves
// the field in place for schema validation to report against the agent's name.
function stringList(value) {
  if (value == null) return [];
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return stringList(parsed);
      } catch { /* not JSON: treat as one separated list below */ }
    }
    return raw.split(/[\n,;]+/u).map((entry) => entry.trim()).filter(Boolean);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function unchanged(args) {
  return { args, folded: false, repairedNames: 0 };
}

// Worded by position: the IDs here are canonical, and an agent only ever sees
// its session handles.
function singleSymbolNote(action, ids) {
  if (ids.length <= 1) return null;
  const rest = ids.length - 1;
  return `${action} reads one symbol per call; the first of symbols was used and the other ${rest === 1 ? "one was" : `${rest} were`} not.`;
}

function foldSymbolCallers(args) {
  if (args.symbols == null) return unchanged(args);
  const entries = stringList(args.symbols);
  if (entries == null) return unchanged(args);
  const ids = unique([
    ...(typeof args.symbolId === "string" && args.symbolId.trim() ? [args.symbolId.trim()] : []),
    ...entries.filter(isCanonicalSymbolId),
  ]);
  if (ids.length === 0) {
    const name = entries[0];
    // The fold has no index to look a name up in, so it refuses. A caller that
    // does (the tool owner) resolves `unresolvedName` instead of answering this.
    return {
      ...unchanged(args),
      error: name
        ? `symbol.callers needs an Atlas symbol in symbols; "${name}" is a name, not a symbol from an Atlas result`
        : "symbol.callers needs one Atlas symbol in symbols",
      ...(name ? { unresolvedName: name } : {}),
    };
  }
  const { symbols: _symbols, ...rest } = args;
  const note = singleSymbolNote("symbol.callers", ids);
  return { args: { ...rest, symbolId: ids[0] }, folded: true, repairedNames: 0, ...(note ? { note } : {}) };
}

// code.lens and code.window: one symbol and/or names within a file.
function foldSourceSelectors(action, args) {
  if (args.names == null && args.symbols == null) return unchanged(args);
  const named = stringList(args.names);
  const entries = stringList(args.symbols);
  const prior = stringList(args.identifiersToFind);
  if (named == null || entries == null || prior == null) return unchanged(args);
  const repaired = entries.filter((entry) => !isCanonicalSymbolId(entry));
  const ids = unique([
    ...(typeof args.symbolId === "string" && args.symbolId.trim() ? [args.symbolId.trim()] : []),
    ...entries.filter(isCanonicalSymbolId),
  ]);
  const hasFile = typeof args.file === "string" && args.file.trim() !== "";
  if (repaired.length > 0 && ids.length === 0 && !hasFile) {
    return {
      ...unchanged(args),
      error: `${action}: "${repaired[0]}" in symbols is a name, not a symbol from an Atlas result; give names together with file`,
    };
  }
  const { names: _names, symbols: _symbols, ...rest } = args;
  const identifiers = unique([...prior, ...named, ...repaired]);
  const out = { ...rest };
  if (ids.length > 0) out.symbolId = ids[0];
  if (identifiers.length > 0) out.identifiersToFind = identifiers;
  const note = SINGLE_SYMBOL_ACTIONS.has(action) ? singleSymbolNote(action, ids) : null;
  return { args: out, folded: true, repairedNames: repaired.length, ...(note ? { note } : {}) };
}

function foldSymbolGet(args) {
  if (args.names == null && args.symbols == null) return unchanged(args);
  const named = stringList(args.names);
  const entries = stringList(args.symbols);
  if (named == null || entries == null) return unchanged(args);
  const ids = entries.filter(isCanonicalSymbolId);
  const symbolNames = entries.filter((entry) => !isCanonicalSymbolId(entry));
  const hasFile = typeof args.file === "string" && args.file.trim() !== "";
  // The execution contract's own shared-file form: file plus names in `symbols`.
  if (args.names == null && ids.length === 0 && hasFile) return unchanged(args);
  if (args.symbolRef != null || args.items != null) {
    return { ...unchanged(args), error: "symbol.get selects by names and symbols; do not combine them with other selectors" };
  }
  const allIds = unique([
    ...(typeof args.symbolId === "string" && args.symbolId.trim() ? [args.symbolId.trim()] : []),
    ...ids,
  ]);
  const allNames = unique([...named, ...symbolNames]);
  if (allIds.length + allNames.length === 0) return unchanged(args);
  const { names: _names, symbols: _symbols, symbolId: _symbolId, file, ...rest } = args;
  const nameSelector = (name) => ({ symbolRef: { name, ...(hasFile ? { file } : {}) } });
  // Counted only when a name arrived in `symbols` without the shared file that
  // would make it the execution contract's own form.
  const repairedNames = hasFile && allIds.length === 0 ? 0 : symbolNames.length;
  if (allIds.length + allNames.length === 1) {
    return {
      args: allIds.length === 1
        ? { ...rest, symbolId: allIds[0], ...(hasFile ? { file } : {}) }
        : { ...rest, ...nameSelector(allNames[0]) },
      folded: true,
      repairedNames,
    };
  }
  return {
    args: {
      ...rest,
      items: [...allIds.map((symbolId) => ({ symbolId })), ...allNames.map(nameSelector)],
    },
    folded: true,
    repairedNames,
  };
}

function foldNamesInto(args, field) {
  if (args.names == null) return unchanged(args);
  const named = stringList(args.names);
  const prior = stringList(args[field]);
  if (named == null || prior == null) return unchanged(args);
  const { names: _names, ...rest } = args;
  const merged = unique([...prior, ...named]);
  return {
    args: merged.length > 0 ? { ...rest, [field]: merged } : rest,
    folded: true,
    repairedNames: 0,
  };
}

// Validation and execution report problems against the execution fields. An
// agent only knows `names` and `symbols`, so prose that mentions an execution
// selector is reworded; a JSON key (`"symbolId":`) is data and is left alone.
const AGENT_FIELD_WORDING = Object.freeze([
  [/\bidentifiersToFind\b(?!"\s*:)/gu, "names"],
  [/\bsymbolRef(?:\.name)?\b(?!"\s*:)/gu, "names"],
  [/\bsymbolId\b(?!"\s*:)/gu, "symbols"],
]);

/**
 * @param {string} action
 * @param {string} text
 * @returns {string}
 */
export function describeWithAgentSelectors(action, text) {
  if (typeof text !== "string" || !ATLAS_UNIFIED_SELECTOR_ACTIONS.includes(action)) return text;
  let worded = text;
  for (const [pattern, field] of AGENT_FIELD_WORDING) worded = worded.replace(pattern, field);
  if (action === "code.survey") worded = worded.replace(/\bsymbols\b(?!"\s*:)/gu, "names");
  return worded.replace(/\bnames or names\b/gu, "names");
}

/**
 * Fold the agent-facing `names` / `symbols` selectors onto an action's
 * execution fields. `symbols` entries must already be canonical symbol IDs;
 * the tool owner resolves session handles before calling this. An entry that
 * is not a symbol ID is a name the agent put in the wrong field, and is moved
 * to the names it should have been in rather than refused.
 *
 * @param {string} action
 * @param {Record<string, any>} args
 * @returns {{ args: Record<string, any>, folded: boolean, repairedNames: number, note?: string, error?: string, unresolvedName?: string }}
 */
export function foldAtlasUnifiedSelectors(action, args) {
  if (!isPlainObject(args)) return unchanged(args);
  switch (action) {
    case "symbol.callers": return foldSymbolCallers(args);
    case "symbol.get": return foldSymbolGet(args);
    case "code.lens":
    case "code.window": return foldSourceSelectors(action, args);
    case "code.skeleton": return foldNamesInto(args, "identifiersToFind");
    case "code.survey": return foldNamesInto(args, "symbols");
    default: return unchanged(args);
  }
}
