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
/**
 * Identity of one indexed declaration: two rows for the same name in the same
 * file are different bearers when they start at different lines.
 *
 * @param {{content_hash?: string, local_id?: number, range_start_line?: number}} symbol
 * @returns {string}
 */
const CONTAINER_KINDS = new Set(["module", "namespace", "file"]);

// A file's module container can share its name with the class it declares
// (PHP-DI ObjectCreator.php: module s2 at 1-203 beside class s3 at 26-203).
// Answering with both sent the class text twice, once inside the whole file
// (Atlas533 PHP_DI_H1: 47% of its delivered lines were repeats). A declaration
// bearer answers the request; the container is kept only when it is alone.
function declarationsOverContainers(symbols) {
  const declarations = symbols.filter((symbol) => !CONTAINER_KINDS.has(String(symbol?.kind || "").toLowerCase()));
  return declarations.length > 0 ? declarations : symbols;
}

const MAX_NEAREST_FILE_DECLARATIONS = 8;

function segmentsOf(value) {
  return normalizedQualifiedIdentifier(value).split(".").filter(Boolean);
}

function isAnonymousDeclaration(symbol) {
  return /^<anonymous/u.test(String(symbol?.name || ""));
}

async function visibleFileDeclarations(view, file, exportedOnly) {
  if (typeof view?.query?.symbolsInFile !== "function") return [];
  let rows;
  try {
    rows = await view.query.symbolsInFile(file);
  } catch {
    return [];
  }
  return declarationsOverContainers(Array.isArray(rows) ? rows : [])
    .filter((symbol) => !isAnonymousDeclaration(symbol))
    .filter((symbol) => !exportedOnly || !["private", "protected"].includes(String(symbol.visibility || "").toLowerCase()));
}

// A name that misses inside a named file is usually right about the member
// and wrong about its spelling around it: httpx's Client._build_request_auth
// is declared on BaseClient, bytes' BytesMut::drop sits in `impl Drop for
// BytesMut`, express's req.fresh is a defineGetter `fresh`, and a kind hint of
// "const" named zod's arrow-function _safeParse. When the file declares that
// member exactly once (or once under the named owner), that declaration is the
// one asked for.
function sameFileMemberTarget(fileSymbols, name) {
  const requested = segmentsOf(name);
  const member = requested.at(-1);
  if (!member) return null;
  const bearers = new Map();
  for (const symbol of fileSymbols) {
    const segments = segmentsOf(symbol.qualified_name || symbol.name);
    if (segments.at(-1) === member) bearers.set(symbolTargetIdentity(symbol), symbol);
  }
  const candidates = [...bearers.values()];
  const owner = requested.length > 1 ? requested.at(-2) : null;
  if (owner) {
    const owned = candidates.filter((symbol) => segmentsOf(symbol.qualified_name || symbol.name).slice(0, -1).includes(owner));
    if (owned.length === 1) return owned[0];
    if (owned.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

// The file's own declarations closest to the missed member name, so the next
// request can name one that exists instead of guessing again.
function nearestFileDeclarations(fileSymbols, name) {
  const member = segmentsOf(name).at(-1);
  if (!member) return [];
  const rows = new Map();
  for (const symbol of fileSymbols) {
    const display = String(symbol.qualified_name || symbol.name || "").trim();
    const tail = segmentsOf(display).at(-1);
    if (!display || !tail || rows.has(display)) continue;
    const distance = tail.includes(member) || member.includes(tail)
      ? Math.abs(tail.length - member.length) / 2
      : editDistance(tail, member);
    rows.set(display, { name: display, line: Number(symbol.range_start_line || 0), distance: distance / Math.max(tail.length, member.length) });
  }
  return [...rows.values()]
    .sort((a, b) => a.distance - b.distance || a.line - b.line)
    .slice(0, MAX_NEAREST_FILE_DECLARATIONS)
    .map(({ name: display, line }) => ({ name: display, line }));
}

function symbolTargetIdentity(symbol) {
  return [
    String(symbol?.content_hash || ""),
    String(symbol?.local_id ?? ""),
    String(symbol?.range_start_line ?? ""),
  ].join(":");
}


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
  // Apply the file selector before the backend limit so other files cannot
  // crowd a requested declaration out of an otherwise exact name lookup.
  /** @type {import("../contracts/api.js").SymbolSearchOptions} */
  const opts = { fuzzy: false, limit: 500, scope: "name",
    ...(requestedFile ? { pathPrefix: requestedFile } : {}) };
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
    const names = new Set(resolution.ambiguousBearers.map(normalizedQualifiedIdentifier));
    return { status: "ambiguous_symbol_ref", bearers: resolution.ambiguousBearers,
      targets: uniqueResolutionSymbols(exported).filter(symbol => names.has(
        normalizedQualifiedIdentifier(symbol.qualified_name || symbol.name),
      )).sort(compareSymbolTargets) };
  }
  const matches = uniqueResolutionSymbols(resolution.matches).sort(compareSymbolTargets);
  let fileDeclarations = [];
  if (matches.length === 0 && requestedFile) {
    const fileSymbols = await visibleFileDeclarations(view, requestedFile, symbolRef.exportedOnly === true);
    const member = sameFileMemberTarget(fileSymbols, name);
    if (member) return { status: "selected", target: member };
    fileDeclarations = nearestFileDeclarations(fileSymbols, name);
  }
  if (matches.length === 0) {
    const recovery = [...eligible];
    if (symbolRef.kind || requestedFile) {
      for (const candidate of [...new Set([name, ...requestedIdentifierCandidates(name)])]) {
        recovery.push(...await view.query.findSymbol(candidate, { fuzzy: false, limit: 500, scope: "name" }));
      }
    }
    const visibleRecovery = symbolRef.exportedOnly === true
      ? recovery.filter(symbol => !["private", "protected"].includes(String(symbol.visibility || "").toLowerCase()))
      : recovery;
    const fallbackResolution = resolveRequestedIdentifierSymbols(uniqueResolutionSymbols(visibleRecovery), name);
    const recoveryNames = new Set(fallbackResolution.ambiguousBearers.map(normalizedQualifiedIdentifier));
    const recoveryTargets = fallbackResolution.matches.length > 0 ? fallbackResolution.matches
      : uniqueResolutionSymbols(visibleRecovery).filter(symbol => recoveryNames.has(
        normalizedQualifiedIdentifier(symbol.qualified_name || symbol.name),
      ));
    return {
      status: "symbol_ref_not_found",
      requestedFile,
      fileDeclarations,
      bearers: symbolRefRecoveryBearers(fallbackResolution.matches || []),
      targets: recoveryTargets.sort(compareSymbolTargets),
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
  // One name can be borne twice in one file: a TypeScript interface beside the
  // const that implements it, a declaration beside its definition. Keeping only
  // the first match per path silently answered with whichever sorted first,
  // which is how a caller asking for a value received a three-line type. Report
  // every bearer instead; the caller gets all of them, not a coin flip.
  if (requestedFile) {
    const inFile = declarationsOverContainers(matches.filter((symbol) => symbol.repo_rel_path === requestedFile));
    const distinct = new Map(inFile.map((symbol) => [symbolTargetIdentity(symbol), symbol]));
    if (distinct.size === 1) return { status: "selected", target: [...distinct.values()][0] };
    if (distinct.size > 1) {
      return {
        status: "ambiguous_symbol_ref",
        requestedFile,
        bearers: [...bearers.values()].sort(),
        targets: [...distinct.values()].sort(compareSymbolTargets),
      };
    }
  }
  const byPath = new Map();
  for (const match of matches) {
    if (!byPath.has(match.repo_rel_path)) byPath.set(match.repo_rel_path, match);
  }
  const targets = [...byPath.values()].sort(compareSymbolTargets);
  if (targets.length === 1) return { status: "selected", target: targets[0] };
  return { status: "ambiguous", targets };
}
