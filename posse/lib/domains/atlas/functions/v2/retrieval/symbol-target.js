// @ts-check

import { parseSymbolId } from "./cards.js";
import { isCanonicalRepoPath } from "../paths.js";
import {
  normalizedQualifiedIdentifier,
  requestedIdentifierCandidates,
  resolveRequestedIdentifierSymbols,
  uniqueResolutionSymbols,
} from "./identifier-resolution.js";

/**
 * Return every durable path-qualified location for an opaque symbol ID.
 * Stable IDs intentionally do not encode the mounted repository path.
 *
 * @param {import("../contracts/api.js").View} view
 * @param {string} symbolId
 */
export async function findSymbolTargets(view, symbolId) {
  const parsed = parseSymbolId(symbolId);
  if (!parsed) return { status: "invalid_symbol_id", targets: [] };
  const targets = await view.query.getAllByContentLocal(parsed.content_hash, parsed.local_id);
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  targets.sort((left, right) => (
    compare(left.repo_rel_path, right.repo_rel_path)
    || Number(left.range_start) - Number(right.range_start)
    || Number(left.global_id) - Number(right.global_id)
  ));
  const seenPaths = new Set();
  const pathQualifiedTargets = targets.filter((target) => {
    const path = String(target.repo_rel_path || "");
    if (!path || seenPaths.has(path)) return false;
    seenPaths.add(path);
    return true;
  });
  return {
    status: pathQualifiedTargets.length > 0 ? "found" : "symbol_not_found",
    targets: pathQualifiedTargets,
  };
}

/**
 * Select the exact path for a known symbol ID. A supplied file is an exact
 * selector rather than a hint; callers can distinguish a path mismatch from
 * an unknown ID and an ambiguous multi-path ID.
 *
 * @param {{ view: import("../contracts/api.js").View, symbolId: string, file?: string }} request
 */
export async function selectSymbolTarget({ view, symbolId, file }) {
  if (file != null && !isCanonicalRepoPath(file)) {
    return { status: "invalid_path", requestedFile: String(file), targets: [] };
  }
  const resolved = await findSymbolTargets(view, symbolId);
  if (resolved.status !== "found") return resolved;
  if (file != null) {
    const selected = resolved.targets.find((target) => target.repo_rel_path === file);
    return selected
      ? { status: "selected", target: selected }
      : { status: "symbol_file_mismatch", requestedFile: file, targets: resolved.targets };
  }
  if (resolved.targets.length === 1) {
    return { status: "selected", target: resolved.targets[0] };
  }
  return { status: "ambiguous", targets: resolved.targets };
}

function compareSymbolTargets(left, right) {
  const leftPath = String(left?.repo_rel_path || "");
  const rightPath = String(right?.repo_rel_path || "");
  const kindRank = (symbol) => {
    const kind = String(symbol?.kind || "").toLowerCase();
    if (["function", "method", "constructor"].includes(kind)) return 0;
    if (["class", "interface", "type", "type_alias", "trait", "struct", "enum"].includes(kind)) return 1;
    if (["module", "namespace", "file"].includes(kind)) return 3;
    return 2;
  };
  return leftPath.localeCompare(rightPath)
    || kindRank(left) - kindRank(right)
    || Number(left?.range_start_line || 0) - Number(right?.range_start_line || 0)
    || Number(left?.range_end_line || 0) - Number(right?.range_end_line || 0)
    || Number(left?.global_id || 0) - Number(right?.global_id || 0);
}

function distinctQualifiedBearers(matches) {
  const bearers = new Map();
  for (const symbol of matches) {
    const display = String(symbol?.qualified_name || symbol?.name || "").trim();
    const key = normalizedQualifiedIdentifier(display);
    if (!key) continue;
    const equivalent = [...bearers.keys()].find((candidate) => (
      candidate === key
      || candidate.endsWith(`.${key}`)
      || key.endsWith(`.${candidate}`)
    ));
    if (!equivalent) bearers.set(key, display);
  }
  return bearers;
}

function symbolRefRecoveryBearers(matches) {
  const rows = new Map();
  for (const symbol of uniqueResolutionSymbols(matches).sort(compareSymbolTargets)) {
    const name = String(symbol?.qualified_name || symbol?.name || "").trim();
    const file = String(symbol?.repo_rel_path || "").trim();
    if (!name || !file) continue;
    const kind = String(symbol?.kind || "").trim();
    const key = `${name}\u0000${file}\u0000${kind}`;
    if (!rows.has(key)) rows.set(key, { name, file, ...(kind ? { kind } : {}) });
    if (rows.size >= 20) break;
  }
  return [...rows.values()];
}

/**
 * Resolve one exact symbol name without a fuzzy discovery pass. Repeated
 * overload rows for the same bearer collapse to their first indexed address;
 * distinct owners remain an explicit ambiguity, and identical bearers in
 * several repository paths use symbol.get's existing path-choice flow.
 *
 * @param {{ view: import("../contracts/api.js").View, symbolRef: {name:string,file?:string,kind?:string,exportedOnly?:boolean}, file?: string }} request
 */
export async function selectSymbolRefTarget({ view, symbolRef, file }) {
  const name = String(symbolRef?.name || "").trim();
  if (!name) return { status: "invalid_symbol_ref", targets: [] };
  const refFile = symbolRef?.file == null ? null : String(symbolRef.file).trim();
  const requestedFile = file == null ? refFile : String(file).trim();
  if (file != null && refFile && requestedFile !== refFile) {
    return {
      status: "symbol_ref_file_mismatch",
      requestedFile,
      symbolRefFile: refFile,
      targets: [],
    };
  }
  if (requestedFile && !isCanonicalRepoPath(requestedFile)) {
    return { status: "invalid_path", requestedFile, targets: [] };
  }
  const opts = { fuzzy: false, limit: 500 };
  if (symbolRef.kind) opts.kinds = [String(symbolRef.kind)];
  const found = [];
  for (const candidate of [...new Set([name, ...requestedIdentifierCandidates(name)])]) {
    found.push(...await view.query.findSymbol(candidate, opts));
  }
  const eligible = symbolRef.exportedOnly === true
    ? found.filter((symbol) => !["private", "protected"].includes(String(symbol.visibility || "").toLowerCase()))
    : found;
  const pathExact = requestedFile
    ? eligible.filter((symbol) => symbol.repo_rel_path === requestedFile)
    : eligible;
  const exported = pathExact;
  const resolution = resolveRequestedIdentifierSymbols(uniqueResolutionSymbols(exported), name);
  if (resolution.ambiguousBearers.length > 0) {
    return { status: "ambiguous_symbol_ref", bearers: resolution.ambiguousBearers, targets: [] };
  }
  const matches = uniqueResolutionSymbols(resolution.matches).sort(compareSymbolTargets);
  if (matches.length === 0) {
    const fallbackResolution = requestedFile
      ? resolveRequestedIdentifierSymbols(uniqueResolutionSymbols(eligible), name)
      : { matches: [] };
    return {
      status: "symbol_ref_not_found",
      requestedFile,
      bearers: symbolRefRecoveryBearers(fallbackResolution.matches || []),
      targets: [],
    };
  }
  const bearers = distinctQualifiedBearers(matches);
  if (bearers.size > 1) {
    return {
      status: "ambiguous_symbol_ref",
      bearers: [...bearers.values()].sort(),
      targets: matches,
    };
  }
  const byPath = new Map();
  for (const match of matches) {
    if (!byPath.has(match.repo_rel_path)) byPath.set(match.repo_rel_path, match);
  }
  const targets = [...byPath.values()].sort(compareSymbolTargets);
  if (targets.length === 1) return { status: "selected", target: targets[0] };
  return { status: "ambiguous", targets };
}
