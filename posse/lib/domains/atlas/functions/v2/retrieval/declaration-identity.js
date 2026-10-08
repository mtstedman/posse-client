import { parseBufferNative } from "../native/parser.js";
import { normalizedQualifiedIdentifier, resolveRequestedIdentifierSymbols } from "./identifier-resolution.js";
import { staleSymbolSource } from "./source-freshness.js";

// Reconcile producer rows against current syntax only when every row claims the
// same declaration. This is not name recovery: scope, kind, content and source
// overlap must all agree, and the parser must find exactly one declaration.
export async function proveDeclarationIdentity(selection, params, readFile, parse = parseBufferNative) {
  if (selection?.status !== "ambiguous_symbol_ref" || !params.symbolRef) return selection;
  const rows = selection.targets || [];
  if (rows.length < 2) return selection;
  const first = rows[0];
  const requestedFile = params.file ?? params.symbolRef.file;
  if (requestedFile != null && requestedFile !== first.repo_rel_path) return selection;
  const normalize = value => normalizedQualifiedIdentifier(value, {caseSensitive: true});
  if (!first.content_hash || rows.some(row => row.repo_rel_path !== first.repo_rel_path
    || row.content_hash !== first.content_hash || row.kind !== first.kind
    || normalize(row.qualified_name || row.name) !== normalize(first.qualified_name || first.name)
    || !Number.isSafeInteger(row.range_start) || !Number.isSafeInteger(row.range_end)
    || row.range_start < 0 || row.range_end <= row.range_start)) return selection;
  try {
    const source = readFile(first.repo_rel_path);
    if (source == null || staleSymbolSource(first, source)
      || rows.some(row => row.range_end > Buffer.byteLength(source, "utf8"))) return selection;
    const parsed = await parse({bytes: source, repo_rel_path: first.repo_rel_path});
    if (parsed.hasError !== false) return selection;
    const matches = resolveRequestedIdentifierSymbols((parsed.symbols || []).filter(row => row.kind === first.kind),
      params.symbolRef.name, {caseSensitive: true}).matches;
    if (matches.length !== 1) return selection;
    const current = matches[0];
    if (resolveRequestedIdentifierSymbols([current], first.qualified_name || first.name,
      {caseSensitive: true}).matches.length !== 1) return selection;
    if (params.symbolRef.exportedOnly === true && ["private", "protected"].includes(current.visibility)) return selection;
    if (!Number.isSafeInteger(current.range_start) || !Number.isSafeInteger(current.range_end)
      || current.range_start < 0 || current.range_end <= current.range_start
      || current.range_end > Buffer.byteLength(source, "utf8")
      || !Number.isSafeInteger(current.range_start_line) || !Number.isSafeInteger(current.range_end_line)
      || current.range_start_line < 1 || current.range_end_line < current.range_start_line) return selection;
    // An identifier-only index row may lie inside the parser's complete body,
    // or an index row may include leading decorators. Disjoint or crossing
    // ranges cannot establish equivalence.
    const contains = (a, b) => a.range_start <= b.range_start && a.range_end >= b.range_end;
    if (!rows.every(row => contains(current, row) || contains(row, current))) return selection;
    const target = [...rows].sort((a, b) => (b.range_end - b.range_start) - (a.range_end - a.range_start))[0];
    return {status: "selected", target: {...target,
      range_start: current.range_start, range_end: current.range_end,
      range_start_line: current.range_start_line, range_end_line: current.range_end_line,
    }};
  } catch { return selection; }
}
