// @ts-check
//
// SCIP protobuf → typed JS records. We only decode the subset of fields
// the consumer actually uses; everything else is silently skipped.
//
// Wire schema (subset; see scip.proto in sourcegraph/scip):
//
//   message Index {
//     Metadata metadata = 1;
//     repeated Document documents = 2;
//     repeated SymbolInformation external_symbols = 3;
//   }
//   message Metadata {
//     ProtocolVersion version = 1;
//     ToolInfo tool_info = 2;
//     string project_root = 3;
//     TextEncoding text_document_encoding = 4;
//   }
//   message ToolInfo {
//     string name = 1; string version = 2; repeated string arguments = 3;
//   }
//   message Document {
  //     string relative_path = 1;
  //     repeated Occurrence occurrences = 2;
  //     repeated SymbolInformation symbols = 3;
  //     string language = 4;
//     string text = 5;
//     PositionEncoding position_encoding = 6;
//   }
//   message Occurrence {
//     repeated int32 range = 1;  // packed [sl, sc, ec] or [sl, sc, el, ec]
//     string symbol = 2;
//     int32 symbol_roles = 3;    // bitfield: Definition=1, Import=2, Write=4, Read=8, Generated=16, Test=32, ForwardDef=64
//     SyntaxKind syntax_kind = 5;
//   }
//   message SymbolInformation {
//     string symbol = 1;
//     repeated string documentation = 3;
//     Kind kind = 5;
//     string display_name = 6;
//   }

import { createProtoReader, readAllFields } from "./proto-reader.js";

const STOP_TOP_LEVEL_DECODE = Symbol("stop-top-level-scip-decode");

/** @typedef {Object} ScipToolInfo
 *  @property {string} name
 *  @property {string} version
 *  @property {string[]} arguments
 */

/** @typedef {Object} ScipMetadata
 *  @property {ScipToolInfo} tool_info
 *  @property {string} project_root
 *  @property {number} text_document_encoding
 *  @property {number} protocol_version
 */

/** @typedef {Object} ScipOccurrence
 *  @property {number[]} range           // raw int32 array from the wire
 *  @property {string} symbol            // SCIP symbol string
 *  @property {number} symbol_roles      // bitfield
 *  @property {number} syntax_kind
 *  @property {number[]} enclosing_range // raw int32 array from field 7
 */

/** @typedef {Object} ScipSymbolInformation
 *  @property {string} symbol
 *  @property {string[]} documentation
 *  @property {number} kind
 *  @property {string} display_name
 */

/** @typedef {Object} ScipDocument
 *  @property {string} language
 *  @property {string} relative_path
 *  @property {ScipOccurrence[]} occurrences
 *  @property {ScipSymbolInformation[]} symbols
 *  @property {string} text
 *  @property {number} position_encoding
 *  @property {Uint8Array} [source_bytes]  Populated by the ingester when Document.text is hydrated from disk.
 *  @property {string} [atlas_skip_reason]   Internal ingester diagnostic for documents that should not be consumed.
 *  @property {string} [atlas_skip_message]
 */

/** @typedef {Object} ScipIndex
 *  @property {ScipMetadata} metadata
 *  @property {ScipDocument[]} documents
 *  @property {ScipSymbolInformation[]} external_symbols
 */

/**
 * Decode an entire .scip Index from a Buffer. Streaming over documents is
 * possible but for v1 (consume-only TS/JS) the file fits in memory; we
 * eagerly decode everything and let the cache build per-doc indices.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {ScipIndex}
 */
export function decodeScipIndex(bytes) {
  const reader = createProtoReader(bytes);
  /** @type {ScipIndex} */
  const idx = {
    metadata: emptyMetadata(),
    documents: [],
    external_symbols: [],
  };
  try {
    readAllFields(reader, (r, field, wire) => {
      switch (field) {
        case 1: { // metadata
          if (wire !== 2) return false;
          let sub;
          try {
            sub = r.readSubMessage();
          } catch {
            throw STOP_TOP_LEVEL_DECODE;
          }
          try {
            idx.metadata = decodeMetadata(sub);
          } catch {
            idx.metadata = emptyMetadata();
          }
          return true;
        }
        case 2: { // documents
          if (wire !== 2) return false;
          let sub;
          try {
            sub = r.readSubMessage();
          } catch {
            throw STOP_TOP_LEVEL_DECODE;
          }
          idx.documents.push(decodeDocument(sub));
          return true;
        }
        case 3: { // external_symbols
          if (wire !== 2) return false;
          let sub;
          try {
            sub = r.readSubMessage();
          } catch {
            throw STOP_TOP_LEVEL_DECODE;
          }
          try {
            idx.external_symbols.push(decodeSymbolInformation(sub));
          } catch {
            // External symbol frames are auxiliary; a torn documentation string
            // must not poison otherwise-decodable documents.
          }
          return true;
        }
        default: return false;
      }
    });
  } catch (err) {
    if (err !== STOP_TOP_LEVEL_DECODE && !isProtoReaderError(err)) throw err;
  }
  return idx;
}

function isProtoReaderError(err) {
  return err instanceof Error && String(err.message || "").startsWith("proto-reader:");
}

function emptyMetadata() {
  return {
    tool_info: { name: "", version: "", arguments: [] },
    project_root: "",
    text_document_encoding: 0,
    protocol_version: 0,
  };
}

/** @param {import("./proto-reader.js").ProtoReader} r */
function decodeMetadata(r) {
  const out = emptyMetadata();
  readAllFields(r, (rr, field, wire) => {
    switch (field) {
      case 1: { if (wire !== 0) return false; out.protocol_version = rr.readInt32(); return true; }
      case 2: { if (wire !== 2) return false; out.tool_info = decodeToolInfo(rr.readSubMessage()); return true; }
      case 3: { if (wire !== 2) return false; out.project_root = rr.readString(); return true; }
      case 4: { if (wire !== 0) return false; out.text_document_encoding = rr.readInt32(); return true; }
      default: return false;
    }
  });
  return out;
}

/** @param {import("./proto-reader.js").ProtoReader} r */
function decodeToolInfo(r) {
  /** @type {ScipToolInfo} */
  const out = { name: "", version: "", arguments: [] };
  readAllFields(r, (rr, field, wire) => {
    switch (field) {
      case 1: { if (wire !== 2) return false; out.name = rr.readString(); return true; }
      case 2: { if (wire !== 2) return false; out.version = rr.readString(); return true; }
      case 3: { if (wire !== 2) return false; out.arguments.push(rr.readString()); return true; }
      default: return false;
    }
  });
  return out;
}

/** @param {import("./proto-reader.js").ProtoReader} r */
function decodeDocument(r) {
  /** @type {ScipDocument} */
  const out = {
    language: "",
    relative_path: "",
    occurrences: [],
    symbols: [],
    text: "",
    position_encoding: 0,
  };
  try {
    readAllFields(r, (rr, field, wire) => {
      switch (field) {
        case 1: { if (wire !== 2) return false; out.relative_path = rr.readString(); return true; }
        case 2: { if (wire !== 2) return false; out.occurrences.push(decodeOccurrence(rr.readSubMessage())); return true; }
        case 3: { if (wire !== 2) return false; out.symbols.push(decodeSymbolInformation(rr.readSubMessage())); return true; }
        case 4: { if (wire !== 2) return false; out.language = rr.readString(); return true; }
        case 5: { if (wire !== 2) return false; out.text = rr.readString(); return true; }
        case 6: { if (wire !== 0) return false; out.position_encoding = rr.readInt32(); return true; }
        default: return false;
      }
    });
  } catch (err) {
    out.atlas_skip_reason = "scip_decode_error";
    out.atlas_skip_message = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** @param {import("./proto-reader.js").ProtoReader} r */
function decodeOccurrence(r) {
  /** @type {ScipOccurrence} */
  const out = { range: [], symbol: "", symbol_roles: 0, syntax_kind: 0, enclosing_range: [] };
  readAllFields(r, (rr, field, wire) => {
    switch (field) {
      case 1: {
        // `range` is `repeated int32 [packed=true]` in scip.proto. Real
        // indexers emit it packed (wire type 2, length-delimited payload
        // of varints) but the protobuf spec also allows unpacked-mixed
        // form (wire type 0, one varint per occurrence). Handle both.
        if (wire === 2) {
          const sub = rr.readSubMessage();
          while (!sub.done()) out.range.push(sub.readInt32());
          return true;
        }
        if (wire === 0) { out.range.push(rr.readInt32()); return true; }
        return false;
      }
      case 2: { if (wire !== 2) return false; out.symbol = rr.readString(); return true; }
      case 3: { if (wire !== 0) return false; out.symbol_roles = rr.readInt32(); return true; }
      case 5: { if (wire !== 0) return false; out.syntax_kind = rr.readInt32(); return true; }
      case 7: {
        if (wire === 2) {
          const sub = rr.readSubMessage();
          while (!sub.done()) out.enclosing_range.push(sub.readInt32());
          return true;
        }
        if (wire === 0) { out.enclosing_range.push(rr.readInt32()); return true; }
        return false;
      }
      default: return false;
    }
  });
  return out;
}

/** @param {import("./proto-reader.js").ProtoReader} r */
function decodeSymbolInformation(r) {
  /** @type {ScipSymbolInformation} */
  const out = { symbol: "", documentation: [], kind: 0, display_name: "" };
  readAllFields(r, (rr, field, wire) => {
    switch (field) {
      case 1: { if (wire !== 2) return false; out.symbol = rr.readString(); return true; }
      case 3: { if (wire !== 2) return false; out.documentation.push(rr.readString()); return true; }
      case 5: { if (wire !== 0) return false; out.kind = rr.readInt32(); return true; }
      case 6: { if (wire !== 2) return false; out.display_name = rr.readString(); return true; }
      default: return false;
    }
  });
  return out;
}

// SCIP SymbolRoles bitfield (per scip.proto).
export const SCIP_ROLE_DEFINITION = 0x1;
export const SCIP_ROLE_IMPORT = 0x2;
export const SCIP_ROLE_WRITE_ACCESS = 0x4;
export const SCIP_ROLE_READ_ACCESS = 0x8;
export const SCIP_ROLE_GENERATED = 0x10;
export const SCIP_ROLE_TEST = 0x20;
export const SCIP_ROLE_FORWARD_DEFINITION = 0x40;

/**
 * @param {number} roles
 * @returns {boolean}
 */
export function scipRoleIsDefinition(roles) {
  return (roles & SCIP_ROLE_DEFINITION) !== 0;
}

/**
 * @param {number} roles
 * @returns {boolean}
 */
export function scipRoleIsImport(roles) {
  return (roles & SCIP_ROLE_IMPORT) !== 0;
}
