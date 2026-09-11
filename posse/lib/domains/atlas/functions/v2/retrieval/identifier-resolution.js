// @ts-check
// Qualified name resolution over indexed rows and current native source facts.
import { parseBufferNative } from "../native/parser.js";
import { resolveLanguage } from "../parser/languages/index.js";
import { ATLAS_IDENTIFIER_BEARER_LIMIT } from "../../../../../catalog/atlas.js";

export function normalizedQualifiedIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\?\./gu, ".")
    .replace(/\[\s*["']?([a-z_$][\w$-]*)["']?\s*\]/giu, ".$1")
    .replace(/\([^)]*\)/gu, "")
    .replace(/::/gu, ".")
    .replace(/[\\/#]/gu, ".")
    .replace(/(^|\.)prototype(?=\.|$)/gu, ".")
    .replace(/^(?:this|self|super)\./gu, "")
    .replace(/\.+/gu, ".")
    .replace(/^\.|\.$/gu, "");
}

export function requestedIdentifierCandidates(value) {
  const normalized = normalizedQualifiedIdentifier(value);
  if (!normalized) return [];
  const segments = normalized.split(".").filter(Boolean);
  return [...new Set([
    normalized,
    ...(segments.length > 1 ? [segments.at(-1)] : []),
  ].filter(Boolean))];
}

function symbolResolutionKey(symbol) {
  if (symbol?.global_id != null) return `global:${symbol.global_id}`;
  if (symbol?.content_hash && symbol?.local_id != null) {
    return `local:${symbol.content_hash}:${symbol.local_id}`;
  }
  return [
    normalizedQualifiedIdentifier(symbol?.qualified_name || symbol?.name),
    String(symbol?.repo_rel_path || ""),
    Number(symbol?.range_start_line || 0),
    String(symbol?.kind || ""),
  ].join(":");
}

export function uniqueResolutionSymbols(symbols) {
  const seen = new Set();
  return (Array.isArray(symbols) ? symbols : []).filter((symbol) => {
    const key = symbolResolutionKey(symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function strictIdentifierMatches(symbol, requested) {
  const name = normalizedQualifiedIdentifier(symbol?.name);
  const qualifiedName = normalizedQualifiedIdentifier(symbol?.qualified_name);
  const qualifiedRequest = requested.includes(".");
  if (!qualifiedRequest) {
    return name === requested
      || qualifiedName === requested
      || Boolean(qualifiedName && qualifiedName.endsWith(`.${requested}`));
  }
  return name === requested
    || qualifiedName === requested
    || Boolean(qualifiedName && qualifiedName.endsWith(`.${requested}`));
}

/**
 * Resolve a requested qualified identifier without silently binding its bare
 * tail to an unrelated bearer. Tail candidates provide ambiguity diagnostics
 * only; a sole different owner is still not the requested declaration.
 */
export function resolveRequestedIdentifierSymbols(symbols, identifier, { allowNamespacePrefix = true } = {}) {
  const requested = normalizedQualifiedIdentifier(identifier);
  if (!requested) return { matches: [], ambiguousBearers: [], matchKind: "none" };
  const candidates = uniqueResolutionSymbols(symbols);
  const exact = candidates.filter((symbol) => strictIdentifierMatches(symbol, requested));
  if (exact.length > 0) {
    return { matches: exact, ambiguousBearers: [], matchKind: "qualified" };
  }
  // Some producers omit an outer package namespace. Preserve that existing
  // spelling compatibility only when the complete indexed owner AND member
  // are a suffix of the request. A bare member never proves its owner.
  const relative = allowNamespacePrefix ? candidates.filter((symbol) => {
    const qualifiedName = normalizedQualifiedIdentifier(symbol?.qualified_name);
    return qualifiedName.includes(".") && requested.endsWith(`.${qualifiedName}`);
  }) : [];
  if (relative.length > 0) {
    const longest = Math.max(...relative.map(symbol => normalizedQualifiedIdentifier(symbol.qualified_name).length));
    return {
      matches: relative.filter(symbol => normalizedQualifiedIdentifier(symbol.qualified_name).length === longest),
      ambiguousBearers: [],
      matchKind: "qualified",
    };
  }
  const segments = requested.split(".").filter(Boolean);
  if (segments.length < 2) return { matches: [], ambiguousBearers: [], matchKind: "none" };
  const tail = segments.at(-1);
  const tailMatches = candidates.filter((symbol) => {
    const name = normalizedQualifiedIdentifier(symbol?.name);
    const qualifiedName = normalizedQualifiedIdentifier(symbol?.qualified_name);
    return name === tail
      || qualifiedName === tail
      || Boolean(qualifiedName && qualifiedName.endsWith(`.${tail}`));
  });
  const bearers = new Map();
  for (const symbol of tailMatches) {
    const display = String(symbol?.qualified_name || symbol?.name || tail).trim();
    const qualifiedName = normalizedQualifiedIdentifier(symbol?.qualified_name);
    // A parser can emit both a file/module container and its same-named
    // callable. Bare qualified names carry no owner beyond their file, so use
    // that file scope for both shapes. Otherwise the same declaration surface
    // (for example the `fastify` module and function in fastify.js) becomes two
    // indistinguishable ambiguity candidates.
    const bareName = normalizedQualifiedIdentifier(symbol?.name || qualifiedName || tail);
    const key = qualifiedName.includes(".")
      ? qualifiedName
      : `${bareName}@${String(symbol?.repo_rel_path || "")}`;
    if (!bearers.has(key)) bearers.set(key, display);
  }
  return {
    matches: [],
    ambiguousBearers: bearers.size > 1 ? [...bearers.values()].sort().slice(0, ATLAS_IDENTIFIER_BEARER_LIMIT) : [],
    matchKind: bearers.size > 1 ? "ambiguous_tail" : "none",
  };
}

export function symbolMatchesRequestedIdentifier(symbol, identifier) {
  const requested = normalizedQualifiedIdentifier(identifier);
  if (!requested) return false;
  return strictIdentifierMatches(symbol, requested);
}

/**
 * Indexed qualified names may use producer-specific ownership notation.
 * Ask the existing native parser for current source facts only when the
 * indexed name did not resolve. These transient rows are window anchors,
 * never stored view identities or graph references.
 */
export async function resolveSourceIdentifierFallbacks(identifiers, symbols, source, repoRelPath) {
  const pending = identifiers.filter((identifier) => (
    normalizedQualifiedIdentifier(identifier).includes(".")
    && resolveRequestedIdentifierSymbols(symbols, identifier).matchKind !== "qualified"
  ));
  const resolved = new Map();
  if (pending.length === 0) return resolved;
  const extension = repoRelPath.slice(repoRelPath.lastIndexOf("."));
  if (!resolveLanguage(extension)?.supported) return resolved;
  const parsed = await parseBufferNative({ bytes: source, repo_rel_path: repoRelPath });
  if (parsed.hasError !== false) return resolved;
  for (const identifier of pending) {
    const current = resolveRequestedIdentifierSymbols(parsed.symbols, identifier, { allowNamespacePrefix: false });
    if (current.matchKind !== "qualified") continue;
    if (current.matches.length === 1) {
      resolved.set(identifier, current);
    } else {
      // Two trait implementations can share the parser's type-qualified
      // name. Distinct source declarations are not a unique recovery.
      resolved.set(identifier, {
        matches: [],
        ambiguousBearers: current.matches.slice(0, ATLAS_IDENTIFIER_BEARER_LIMIT).map((symbol) => (
          `${symbol.qualified_name || symbol.name} (${repoRelPath}:${symbol.range_start_line})`
        )),
        matchKind: "ambiguous_tail",
      });
    }
  }
  return resolved;
}
