// @ts-check

import { languageForPath } from "../parse/language-buckets.js";

/** @typedef {import("./name-index.js").NameCandidate} NameCandidate */
/** @typedef {import("./resolve.js").EdgeToResolve} EdgeToResolve */

/** @param {NameCandidate} symbol */
function ownerName(symbol) {
  const qualified = symbol.qualified_name || "";
  const split = qualified.lastIndexOf(".");
  return split > 0 ? qualified.slice(0, split) : null;
}

/**
 * Qualified JS function names describe lexical owners, not globally available
 * exports. Walk only uniquely identified owners in the same file. Missing or
 * ambiguous ownership is insufficient evidence to bind a nested helper.
 *
 * @param {Array<NameCandidate & {name: string}>} symbols
 * @returns {(target: NameCandidate, edge: EdgeToResolve) => boolean}
 */
export function buildCallScopeCheck(symbols) {
  const byId = new Map(symbols.map(symbol => [symbol.global_id, symbol]));
  /** @type {Map<string, Map<string, Array<NameCandidate & {name: string}>>>} */
  const byFile = new Map();
  for (const symbol of symbols) {
    let names = byFile.get(symbol.repo_rel_path);
    if (!names) byFile.set(symbol.repo_rel_path, names = new Map());
    const matches = names.get(symbol.name) || [];
    matches.push(symbol);
    names.set(symbol.name, matches);
  }
  return (target, edge) => {
    if (edge.kind !== "calls" || target.kind !== "function"
      || !["js", "ts"].includes(languageForPath(target.repo_rel_path))) return true;
    const owner = ownerName(target);
    if (!owner) return true;
    if (target.repo_rel_path !== edge.repo_rel_path) return false;
    const targetName = byId.get(target.global_id)?.name;
    if (!targetName) return false;
    const initialCaller = byId.get(edge.from_global_id);
    if (initialCaller && signatureMayShadow(initialCaller, targetName)) return false;
    if (target.global_id === edge.from_global_id) return true;
    const names = byFile.get(target.repo_rel_path);
    const owners = names?.get(owner);
    if (owners?.length !== 1) return false;
    const ownerId = owners[0].global_id;
    const visited = new Set();
    let caller = byId.get(edge.from_global_id);
    while (caller && caller.repo_rel_path === target.repo_rel_path
      && !visited.has(caller.global_id)) {
      if (caller.global_id === ownerId) return true;
      if (signatureMayShadow(caller, targetName)) return false;
      visited.add(caller.global_id);
      const parent = ownerName(caller);
      const matches = parent ? names?.get(parent) : undefined;
      caller = matches?.length === 1 ? matches[0] : undefined;
    }
    return false;
  };
}

/**
 * A target name in the parameter/signature portion is possible shadowing,
 * not evidence for a captured helper. Default expressions and type names can
 * also match: without a binding table, abstain rather than guess through them.
 * @param {NameCandidate} caller
 * @param {string} name
 */
function signatureMayShadow(caller, name) {
  const signature = caller.signature_text || "";
  const open = signature.indexOf("(");
  const parameters = open >= 0 ? signature.slice(open + 1) : signature;
  return parameters.split(/[^\p{ID_Continue}$]+/u).includes(name);
}
