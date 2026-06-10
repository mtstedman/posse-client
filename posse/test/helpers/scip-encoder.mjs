// @ts-check
//
// Test helper: minimal protobuf encoder for synthesizing .scip fixtures.
// Not exhaustive — covers the field types the SCIP consumer reads.

/**
 * Encode an unsigned varint into a list of byte values.
 *
 * @param {number | bigint} value
 * @returns {number[]}
 */
export function varint(value) {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) v += 1n << 64n;
  /** @type {number[]} */
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/**
 * Encode an int32 as a varint (matching protobuf int32 semantics: sign
 * extended to 64 bits).
 *
 * @param {number} value
 * @returns {number[]}
 */
export function int32Varint(value) {
  if (value >= 0) return varint(value);
  // Sign-extend to 64 bits.
  const bigUnsigned = BigInt(value) + (1n << 64n);
  return varint(bigUnsigned);
}

/**
 * Combine a field number + wire type into the tag byte sequence.
 *
 * @param {number} fieldNumber
 * @param {number} wireType
 * @returns {number[]}
 */
export function tag(fieldNumber, wireType) {
  return varint((fieldNumber << 3) | wireType);
}

/**
 * Encode a string field.
 *
 * @param {number} fieldNumber
 * @param {string} value
 * @returns {number[]}
 */
export function strField(fieldNumber, value) {
  const buf = Buffer.from(value, "utf-8");
  return [...tag(fieldNumber, 2), ...varint(buf.length), ...buf];
}

/**
 * Encode an int32 varint field.
 *
 * @param {number} fieldNumber
 * @param {number} value
 * @returns {number[]}
 */
export function int32Field(fieldNumber, value) {
  return [...tag(fieldNumber, 0), ...int32Varint(value)];
}

/**
 * Encode a packed repeated int32 field (the SCIP `Occurrence.range` shape).
 *
 * @param {number} fieldNumber
 * @param {number[]} values
 * @returns {number[]}
 */
export function packedInt32Field(fieldNumber, values) {
  const inner = [];
  for (const v of values) inner.push(...int32Varint(v));
  return [...tag(fieldNumber, 2), ...varint(inner.length), ...inner];
}

/**
 * Encode a sub-message field.
 *
 * @param {number} fieldNumber
 * @param {number[]} subBytes
 * @returns {number[]}
 */
export function msgField(fieldNumber, subBytes) {
  return [...tag(fieldNumber, 2), ...varint(subBytes.length), ...subBytes];
}

/**
 * Build a complete ToolInfo message.
 *
 * @param {{ name: string, version: string, arguments?: string[] }} info
 * @returns {number[]}
 */
export function encodeToolInfo({ name, version, arguments: args = [] }) {
  const out = [...strField(1, name), ...strField(2, version)];
  for (const a of args) out.push(...strField(3, a));
  return out;
}

/**
 * Build a Metadata sub-message.
 *
 * @param {{ tool_info: ReturnType<typeof encodeToolInfo>, project_root: string, text_document_encoding?: number }} args
 * @returns {number[]}
 */
export function encodeMetadata(args) {
  const out = [
    ...msgField(2, args.tool_info),
    ...strField(3, args.project_root),
  ];
  if (args.text_document_encoding != null) out.push(...int32Field(4, args.text_document_encoding));
  return out;
}

/**
 * Build an Occurrence sub-message.
 *
 * @param {{ range: number[], symbol: string, symbol_roles?: number, syntax_kind?: number, enclosing_range?: number[] }} args
 * @returns {number[]}
 */
export function encodeOccurrence(args) {
  const out = [
    ...packedInt32Field(1, args.range),
    ...strField(2, args.symbol),
  ];
  if (args.symbol_roles) out.push(...int32Field(3, args.symbol_roles));
  if (args.syntax_kind) out.push(...int32Field(5, args.syntax_kind));
  if (args.enclosing_range) out.push(...packedInt32Field(7, args.enclosing_range));
  return out;
}

/**
 * Build a SymbolInformation sub-message (subset).
 *
 * @param {{ symbol: string, display_name?: string, documentation?: string[], kind?: number }} args
 * @returns {number[]}
 */
export function encodeSymbolInformation(args) {
  const out = [...strField(1, args.symbol)];
  if (args.documentation) {
    for (const d of args.documentation) out.push(...strField(3, d));
  }
  if (args.kind) out.push(...int32Field(5, args.kind));
  if (args.display_name) out.push(...strField(6, args.display_name));
  return out;
}

/**
 * Build a Document sub-message.
 *
 * @param {{
 *   language: string,
 *   relative_path: string,
 *   text?: string,
 *   position_encoding?: number,
 *   occurrences?: Array<Parameters<typeof encodeOccurrence>[0]>,
 *   symbols?: Array<Parameters<typeof encodeSymbolInformation>[0]>,
 * }} args
 * @returns {number[]}
 */
export function encodeDocument(args) {
  const out = [
    ...strField(1, args.relative_path),
  ];
  for (const occ of args.occurrences || []) out.push(...msgField(2, encodeOccurrence(occ)));
  for (const sym of args.symbols || []) out.push(...msgField(3, encodeSymbolInformation(sym)));
  out.push(...strField(4, args.language));
  if (args.text != null) out.push(...strField(5, args.text));
  if (args.position_encoding != null) out.push(...int32Field(6, args.position_encoding));
  return out;
}

/**
 * Build a top-level Index message and return it as a Buffer.
 *
 * @param {{
 *   metadata?: Parameters<typeof encodeMetadata>[0],
 *   documents?: Array<Parameters<typeof encodeDocument>[0]>,
 *   external_symbols?: Array<Parameters<typeof encodeSymbolInformation>[0]>,
 * }} args
 * @returns {Buffer}
 */
export function encodeIndex(args) {
  /** @type {number[]} */
  const out = [];
  if (args.metadata) out.push(...msgField(1, encodeMetadata(args.metadata)));
  for (const doc of args.documents || []) out.push(...msgField(2, encodeDocument(doc)));
  for (const ext of args.external_symbols || []) out.push(...msgField(3, encodeSymbolInformation(ext)));
  return Buffer.from(out);
}
