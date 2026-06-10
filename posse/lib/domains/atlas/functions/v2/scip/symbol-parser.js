// @ts-check
//
// SCIP symbol string parser. Implements the grammar from scip.proto's
// symbol-syntax block, ported from the algorithm sourcegraph/scip uses
// (parseSymbol / new SymbolParser). The grammar is:
//
//   <symbol>         ::= <scheme> ' ' <package> ' ' <descriptor>+
//                     |  'local ' <local-id>
//   <package>        ::= <manager> ' ' <package-name> ' ' <version>
//   <descriptor>     ::= <namespace> | <type> | <term> | <method>
//                     |  <type-parameter> | <parameter> | <meta>
//   <namespace>      ::= <name> '/'
//   <type>           ::= <name> '#'
//   <term>           ::= <name> '.'
//   <method>         ::= <name> '(' <disambiguator>? ').'
//   <type-parameter> ::= '[' <name> ']'
//   <parameter>      ::= '(' <name> ')'
//   <meta>           ::= <name> ':'
//   <name>           ::= <identifier> | '`' <escaped-identifier> '`'
//   <identifier>     ::= one or more chars in [A-Za-z0-9_$+-]
//
// Inside scheme / manager / package-name / version, two spaces encode one
// literal space. Inside backticks the only escape is `` `` `` (two backticks)
// → one backtick. Outside backticks the suffix character (`/`, `#`, `.`, `(`,
// `[`, `]`, ` `, `:`) terminates the name.
//
// Local symbols (`local 0`, `local 1`, ...) have no package fields and are
// document-scoped — they're the SCIP equivalent of an unexported binding.

/**
 * @typedef {Object} ScipDescriptor
 * @property {"namespace"|"type"|"term"|"method"|"macro"|"type_parameter"|"parameter"|"meta"} kind
 * @property {string} name
 * @property {string} [disambiguator]
 */

/**
 * @typedef {Object} ScipParsedSymbol
 * @property {boolean} local                 True for `local N` symbols.
 * @property {string}  local_id              When `local`, the trailing integer string. "" otherwise.
 * @property {string}  scheme                "" for local symbols.
 * @property {string}  manager               "" when missing or local.
 * @property {string}  package_name          "" when local.
 * @property {string}  package_version       "" when missing or local.
 * @property {ScipDescriptor[]} descriptors
 * @property {string}  raw                   Verbatim input.
 */

/**
 * Parse a SCIP symbol string.
 *
 * @param {string} symbol
 * @returns {ScipParsedSymbol}
 */
export function parseScipSymbol(symbol) {
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new RangeError("parseScipSymbol: symbol must be a non-empty string");
  }

  if (symbol.startsWith("local ")) {
    return {
      local: true,
      local_id: symbol.slice("local ".length),
      scheme: "",
      manager: "",
      package_name: "",
      package_version: "",
      descriptors: [],
      raw: symbol,
    };
  }

  const cursor = { s: symbol, i: 0 };
  const scheme = readPackageField(cursor, false);
  if (!consumeChar(cursor, " ")) {
    throw new RangeError(`parseScipSymbol: missing space after scheme: '${symbol}'`);
  }
  const manager = readPackageField(cursor, true);
  if (!consumeChar(cursor, " ")) {
    throw new RangeError(`parseScipSymbol: missing space after manager: '${symbol}'`);
  }
  const packageName = readPackageField(cursor, true);
  if (!consumeChar(cursor, " ")) {
    throw new RangeError(`parseScipSymbol: missing space after package_name: '${symbol}'`);
  }
  const packageVersion = readPackageField(cursor, true);
  if (!consumeChar(cursor, " ")) {
    throw new RangeError(`parseScipSymbol: missing space after package_version: '${symbol}'`);
  }

  /** @type {ScipDescriptor[]} */
  const descriptors = [];
  while (cursor.i < cursor.s.length) {
    descriptors.push(readDescriptor(cursor));
  }
  if (descriptors.length === 0) {
    throw new RangeError(`parseScipSymbol: missing descriptor in '${symbol}'`);
  }
  return {
    local: false,
    local_id: "",
    scheme,
    manager: packageFieldSentinel(manager),
    package_name: packageFieldSentinel(packageName),
    package_version: packageFieldSentinel(packageVersion),
    descriptors,
    raw: symbol,
  };
}

/**
 * SCIP encodes "no manager" / "no version" as the literal string `.`. The
 * external_symbols schema uses `''` for these so UNIQUE actually dedupes;
 * normalize both forms to `''` here.
 *
 * @param {string} value
 * @returns {string}
 */
function packageFieldSentinel(value) {
  return value === "." ? "" : value;
}

/**
 * @param {{ s: string, i: number }} cursor
 * @returns {ScipDescriptor}
 */
function readDescriptor(cursor) {
  // Special-case `[name]` and `(name)` first — they're recognized by an
  // opening bracket, not by a name preceding a suffix character.
  const ch = cursor.s[cursor.i];
  if (ch === "[") {
    cursor.i++;
    const name = readName(cursor, "]");
    if (!consumeChar(cursor, "]")) {
      throw new RangeError(`parseScipSymbol: type_parameter not terminated near index ${cursor.i}`);
    }
    return { kind: "type_parameter", name };
  }
  if (ch === "(") {
    cursor.i++;
    const name = readName(cursor, ")");
    if (!consumeChar(cursor, ")")) {
      throw new RangeError(`parseScipSymbol: parameter not terminated near index ${cursor.i}`);
    }
    return { kind: "parameter", name };
  }

  // Otherwise: read a name, then look at the suffix character.
  const name = readName(cursor, null);
  const suffix = cursor.s[cursor.i];
  cursor.i++;
  switch (suffix) {
    case "/": return { kind: "namespace", name };
    case "#": return { kind: "type", name };
    case ":": return { kind: "meta", name };
    case ".": return { kind: "term", name };
    case "!": return { kind: "macro", name };
    case "(": {
      // method: name(disambiguator?).
      const disambiguator = readName(cursor, ")", true);
      if (!consumeChar(cursor, ")")) {
        throw new RangeError(`parseScipSymbol: method disambiguator not terminated near index ${cursor.i}`);
      }
      if (!consumeChar(cursor, ".")) {
        throw new RangeError(`parseScipSymbol: method suffix must end with '.' near index ${cursor.i}`);
      }
      const descriptor = /** @type {ScipDescriptor} */ ({ kind: "method", name });
      if (disambiguator) descriptor.disambiguator = disambiguator;
      return descriptor;
    }
    case undefined:
      throw new RangeError("parseScipSymbol: descriptor missing suffix");
    default:
      throw new RangeError(`parseScipSymbol: unexpected descriptor suffix '${suffix}'`);
  }
}

/**
 * Read a <name>. Either an identifier (chars in [A-Za-z0-9_$+-]) or a
 * backtick-quoted name where `` `` `` is the escape for a literal `.
 *
 * `terminator` is the character that ends an identifier (used only inside
 * `[...]` / `(...)` to disambiguate `]`/`)` from a name character). When
 * `null`, name reads until any non-identifier character.
 *
 * @param {{ s: string, i: number }} cursor
 * @param {string | null} terminator
 * @param {boolean} [allowEmpty]
 * @returns {string}
 */
function readName(cursor, terminator, allowEmpty = false) {
  if (cursor.s[cursor.i] === "`") {
    cursor.i++;
    let out = "";
    while (cursor.i < cursor.s.length) {
      const ch = cursor.s[cursor.i];
      if (ch === "`") {
        if (cursor.s[cursor.i + 1] === "`") {
          out += "`";
          cursor.i += 2;
          continue;
        }
        cursor.i++;
        return out;
      }
      out += ch;
      cursor.i++;
    }
    throw new RangeError("parseScipSymbol: unterminated backtick-quoted name");
  }
  let out = "";
  while (cursor.i < cursor.s.length) {
    const ch = cursor.s[cursor.i];
    if (terminator != null && ch === terminator) break;
    if (!isIdentifierChar(ch)) break;
    out += ch;
    cursor.i++;
  }
  if (!out && !allowEmpty) {
    throw new RangeError(`parseScipSymbol: empty identifier near index ${cursor.i}`);
  }
  return out;
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isIdentifierChar(ch) {
  const c = ch.charCodeAt(0);
  // A-Z, a-z, 0-9, _, $, +, -
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 0x5f || c === 0x24 || c === 0x2b || c === 0x2d
  );
}

/**
 * Read a SCIP package-side field. A single space is the field delimiter; a
 * doubled space is decoded to one literal space in the field value.
 *
 * @param {{ s: string, i: number }} cursor
 * @param {boolean} allowEmpty
 * @returns {string}
 */
function readPackageField(cursor, allowEmpty) {
  let out = "";
  while (cursor.i < cursor.s.length) {
    const ch = cursor.s[cursor.i];
    if (ch === " ") {
      if (cursor.s[cursor.i + 1] === " ") {
        out += " ";
        cursor.i += 2;
        continue;
      }
      break;
    }
    out += ch;
    cursor.i++;
  }
  if (!allowEmpty && !out) {
    throw new RangeError(`parseScipSymbol: empty field at index ${cursor.i}`);
  }
  return out;
}

/**
 * @param {{ s: string, i: number }} cursor
 * @param {string} ch
 * @returns {boolean}
 */
function consumeChar(cursor, ch) {
  if (cursor.s[cursor.i] === ch) { cursor.i++; return true; }
  return false;
}

/**
 * Concatenate descriptors into a `qualified_name` suitable for the ATLAS
 * symbol row. We use the descriptor name only and join with '.' so the
 * format matches what tree-sitter-derived TS/JS qualified_names look like.
 *
 * @param {ScipDescriptor[]} descriptors
 * @returns {string}
 */
export function descriptorsToQualifiedName(descriptors) {
  return descriptors.map((d) => d.name).join(".");
}

/**
 * Display-name for an external moniker — last descriptor's name, falling
 * back to a stringified chain when the last entry is anonymous.
 *
 * @param {ScipParsedSymbol} parsed
 * @returns {string}
 */
export function externalDisplayName(parsed) {
  if (parsed.local || parsed.descriptors.length === 0) return parsed.raw;
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  return last.name || descriptorsToQualifiedName(parsed.descriptors);
}
