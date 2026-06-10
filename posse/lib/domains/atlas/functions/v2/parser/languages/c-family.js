// @ts-check
//
// Shared extractor for C and C++. Differences are minor enough that one
// extractor with a `cpp` flag covers both. Captures:
//   - function definitions / prototypes
//   - C++ classes/structs with inheritance
//   - C structs/unions/enums
//   - typedef aliases
//   - #include directives (only the basename — repo-relative resolution
//     happens at the resolver pass, which v1 doesn't run yet)

import { scanAll, createExtractor, matchBraceEnd, findEnclosingBody } from "./common.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("../../contracts/schemas.js").SymbolKind} SymbolKind */

/**
 * @param {{
 *   content_hash: string,
 *   repo_rel_path: string,
 *   source: string,
 *   lang: "c" | "cpp",
 * }} args
 * @returns {{ symbols: SymbolRow[], edges: EdgeRow[] }}
 */
export function extractCFamily(args) {
  const ctx = createExtractor({ ...args, lang: args.lang });
  const { stripped, source } = ctx;
  const isCpp = args.lang === "cpp";

  // C++ class / struct with inheritance. Track body byte-ranges so
  // member function definitions land with parent_local_id.
  /** @type {import("./common.js").BodySpan<SymbolRow>[]} */
  const types = [];
  if (isCpp) {
    const cppClassRe =
      /\b(class|struct)\s+([A-Za-z_][\w]*)(?:\s+final)?(?:\s*:\s*([^{]+))?\s*\{/g;
    for (const { match, start, end } of scanAll(cppClassRe, stripped)) {
      const kind = match[1] === "class" ? "class" : "struct";
      const name = match[2];
      const sym = ctx.addSymbol({
        kind,
        name,
        signature: match[0].replace(/\s*\{\s*$/, ""),
        range_start: start,
        range_end: end,
      });
      if (match[3]) {
        for (const part of match[3].split(",").map((s) => s.trim()).filter(Boolean)) {
          const cleaned = part.replace(/^(?:public|private|protected|virtual)\s+/g, "").trim();
          if (!cleaned) continue;
          ctx.addEdge({
            from_local_id: sym.local_id,
            to_name: cleaned,
            kind: "extends",
            range_start: start,
            range_end: end,
            confidence: 85,
          });
        }
      }
      const braceOffset = end - 1;
      if (stripped[braceOffset] === "{") {
        const closing = matchBraceEnd(stripped, braceOffset);
        if (closing > braceOffset) {
          types.push({ sym, bodyStart: braceOffset + 1, bodyEnd: closing });
        }
      }
    }
  } else {
    // C struct / union / enum
    const structRe = /\b(struct|union|enum)\s+([A-Za-z_][\w]*)\s*\{/g;
    for (const { match, start, end } of scanAll(structRe, stripped)) {
      const kind =
        match[1] === "struct" ? "struct"
        : match[1] === "union" ? "struct"
        : "enum";
      ctx.addSymbol({
        kind,
        name: match[2],
        signature: match[0].replace(/\s*\{\s*$/, ""),
        range_start: start,
        range_end: end,
      });
    }
  }

  // typedef. Two shapes:
  //   `typedef <type> Name;`              (alias form — name at end)
  //   `typedef <ret> (*Name)(<args>);`    (function-pointer form)
  const typedefRe = /\btypedef\s+[^;]+?\s([A-Za-z_][\w]*)\s*;/g;
  for (const { match, start, end } of scanAll(typedefRe, stripped)) {
    ctx.addSymbol({
      kind: "type",
      name: match[1],
      signature: match[0].replace(/\s*;\s*$/, ""),
      range_start: start,
      range_end: end,
    });
  }
  const typedefFnPtrRe = /\btypedef\s+[^;]+?\(\s*\*\s*([A-Za-z_][\w]*)\s*\)\s*\([^;]*\)\s*;/g;
  for (const { match, start, end } of scanAll(typedefFnPtrRe, stripped)) {
    ctx.addSymbol({
      kind: "type",
      name: match[1],
      signature: match[0].replace(/\s*;\s*$/, ""),
      range_start: start,
      range_end: end,
    });
  }

  // Function definitions: returntype name(...) {
  const fnRe =
    /(?:^|[\s;}])(?:(?:static|extern|inline|virtual|explicit|constexpr|noexcept)\s+)*([A-Za-z_][\w:<>*&,\s\[\]]*?)\s+([A-Za-z_~][\w]*)\s*\(([^)]*)\)\s*(?:const\s+)?(?:noexcept[^{;]*)?(?:throw\s*\([^)]*\)\s*)?[{;]/g;
  for (const { match, start, end } of scanAll(fnRe, stripped)) {
    const name = match[2];
    if (!name) continue;
    if (RESERVED.has(name)) continue;
    const parent = isCpp ? findEnclosingBody(types, start) : null;
    // Destructors (`~Foo`) only make sense as class methods. Outside
    // any tracked class body they're meaningless lexical noise — skip
    // rather than emit an orphan method-kind symbol with null parent.
    if (name.startsWith("~") && !parent) continue;
    /** @type {SymbolKind} */
    const kind = parent ? "method" : "function";
    ctx.addSymbol({
      kind,
      name,
      parent_local_id: parent ? parent.sym.local_id : null,
      qualified_name: parent ? `${parent.sym.name}::${name}` : null,
      signature: match[0].trim().replace(/\s*[{;]\s*$/, ""),
      range_start: start,
      range_end: end,
    });
  }

  // #include "foo.h" / <foo.h>  — scan ORIGINAL source: '#' is treated
  // as a line-comment leader by some pre-strip passes, so go to the raw
  // bytes for the include directive.
  const includeRe = /^[ \t]*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  for (const { match, start, end } of scanAll(includeRe, source)) {
    ctx.addEdge({
      from_local_id: ctx.MODULE_LEVEL,
      to_name: match[1],
      kind: "imports",
      range_start: start,
      range_end: end,
      confidence: 80,
    });
  }

  return ctx.finalize();
}

const RESERVED = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "return", "goto",
  "sizeof", "typedef", "struct", "union", "enum", "void", "int", "long",
  "short", "char", "float", "double", "signed", "unsigned", "const",
  "volatile", "static", "extern", "register", "inline", "auto",
]);
