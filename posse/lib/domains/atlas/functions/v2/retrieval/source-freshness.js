// @ts-check
import { isUtf8 } from "node:buffer";
import { getDecodedSourceHashes } from "../../../classes/v2/DecodedSourceHashes.js";
import { sha256Hex } from "../hash.js";

/**
 * Decode source bytes exactly as the native parser does before computing
 * indexed ranges (posse-bin `source_encoding.rs` `decode_source_bytes`): honor
 * a UTF-16 byte-order mark, strip a UTF-8 one, otherwise decode UTF-8 with
 * replacement characters. The index hashes the raw bytes, so when the text
 * does not re-encode to them, record which byte hash it came from.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function decodeIndexedSource(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(bytes.subarray(2));
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder("utf-16be", { ignoreBOM: true }).decode(bytes.subarray(2));
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = bytes.subarray(3).toString("utf8");
  } else if (isUtf8(bytes)) {
    return bytes.toString("utf8");
  } else {
    text = bytes.toString("utf8");
  }
  getDecodedSourceHashes().record(sha256Hex(text), sha256Hex(bytes));
  return text;
}

/**
 * Never apply indexed ranges to different source bytes. A target that carries
 * no indexed content hash (a synthetic or file-only target) has nothing to
 * compare against and is not drift; only a recorded hash that disagrees with
 * the bytes on disk is.
 */
export function staleSymbolSource(target, source) {
  if (!target || source == null) return null;
  if (typeof target.content_hash !== "string" || !target.content_hash) return null;
  const actualHash = sha256Hex(source);
  if (target.content_hash === actualHash) return null;
  if (getDecodedSourceHashes().has(actualHash, target.content_hash)) return null;
  return {
    code: "index_drift",
    message: "Indexed symbol does not match the current file. Refresh the WI index or use a file-based code.lens lookup; stale symbol ranges were not read.",
    details: { file: target.repo_rel_path, name: target.qualified_name || target.name, indexedHash: target.content_hash, actualHash },
  };
}
