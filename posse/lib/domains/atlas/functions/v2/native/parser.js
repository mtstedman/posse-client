// @ts-check
//
// Native mirror for parser/adapter parseBuffer.
//
// Migration discipline:
//   1. Rust implements ATLAS_NATIVE_PARSE_BUFFER_METHOD.
//   2. diffParseBufferNativeParity compares Rust output against the Node
//      parser oracle until parity is exact for the target language/corpus.
//   3. The call site switches to parseBufferNative.
//   4. The matching Node parser code is deleted in the same change.

import { isDeepStrictEqual } from "node:util";

import { sha256Hex } from "../hash.js";
import { isCanonicalRepoPath } from "../paths.js";
import { runAtlasNativeMethod } from "./invoke.js";

/** @typedef {import("../contracts/schemas.js").ParseResult} ParseResult */

export const ATLAS_NATIVE_PARSE_BUFFER_METHOD = "parser.parseBuffer";

/**
 * @param {Buffer | string} bytes
 * @returns {Buffer}
 */
function toBuffer(bytes) {
  return typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
}

/**
 * @param {{
 *   bytes: Buffer | string,
 *   repo_rel_path: string,
 *   lang?: string,
 * }} args
 */
export function buildParseBufferNativePayload(args) {
  if (!args || typeof args !== "object") {
    throw new TypeError("buildParseBufferNativePayload: args are required");
  }
  const repoRelPath = String(args.repo_rel_path || "");
  if (!isCanonicalRepoPath(repoRelPath)) {
    throw new RangeError(
      `buildParseBufferNativePayload: repo_rel_path must be canonical, got ${JSON.stringify(repoRelPath)}`,
    );
  }
  const buf = toBuffer(args.bytes);
  const contentHash = sha256Hex(buf);
  return {
    repo_rel_path: repoRelPath,
    lang: args.lang ? String(args.lang) : null,
    content_hash: contentHash,
    bytes_base64: buf.toString("base64"),
  };
}

/**
 * @param {unknown} value
 * @param {{ repo_rel_path: string, content_hash: string, lang?: string | null }} expected
 * @returns {ParseResult}
 */
function parseNativeParseResult(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ATLAS native parser returned a non-object result");
  }
  const result = /** @type {ParseResult} */ (value);
  if (result.repo_rel_path !== expected.repo_rel_path) {
    throw new Error(
      `ATLAS native parser returned repo_rel_path ${JSON.stringify(result.repo_rel_path)}; expected ${JSON.stringify(expected.repo_rel_path)}`,
    );
  }
  if (result.content_hash !== expected.content_hash) {
    throw new Error(
      `ATLAS native parser returned content_hash ${JSON.stringify(result.content_hash)}; expected ${expected.content_hash}`,
    );
  }
  if (expected.lang && result.lang !== expected.lang) {
    throw new Error(
      `ATLAS native parser returned lang ${JSON.stringify(result.lang)}; expected ${JSON.stringify(expected.lang)}`,
    );
  }
  if (!Array.isArray(result.symbols)) {
    throw new Error("ATLAS native parser result must include symbols[]");
  }
  if (!Array.isArray(result.edges)) {
    throw new Error("ATLAS native parser result must include edges[]");
  }
  return result;
}

/**
 * Strict Rust-owned parseBuffer implementation. This does not call the Node
 * parser and does not fall back.
 *
 * @param {{
 *   bytes: Buffer | string,
 *   repo_rel_path: string,
 *   lang?: string,
 * }} args
 * @param {import("./invoke.js").NativeMethodRunOptions} [opts]
 * @returns {ParseResult}
 */
export function parseBufferNative(args, opts = {}) {
  const payload = buildParseBufferNativePayload(args);
  const result = runAtlasNativeMethod(ATLAS_NATIVE_PARSE_BUFFER_METHOD, payload, opts);
  return parseNativeParseResult(result, payload);
}

/**
 * JSON-safe canonical form for strict A/B comparison. Optional `undefined`
 * fields vanish the same way they do across the process boundary.
 *
 * @param {unknown} result
 * @returns {unknown}
 */
export function normalizeParseResultForNativeParity(result) {
  return JSON.parse(JSON.stringify(result));
}

/**
 * Run the Rust mirror and compare it against a supplied Node oracle. The oracle
 * is injected so this file never imports the Node parser it is helping delete.
 *
 * @param {{
 *   bytes: Buffer | string,
 *   repo_rel_path: string,
 *   lang?: string,
 * }} args
 * @param {{
 *   nodeParseBuffer: (args: { bytes: Buffer | string, repo_rel_path: string, lang?: string }) => ParseResult,
 *   manager?: import("../../../../../classes/tools/BinaryManager.js").BinaryManager,
 *   timeoutMs?: number,
 * }} opts
 * @returns {{ ok: true, node: unknown, native: unknown } | { ok: false, node: unknown, native: unknown, message: string }}
 */
export function diffParseBufferNativeParity(args, opts) {
  if (typeof opts?.nodeParseBuffer !== "function") {
    throw new TypeError("diffParseBufferNativeParity requires nodeParseBuffer");
  }
  const node = normalizeParseResultForNativeParity(opts.nodeParseBuffer(args));
  const native = normalizeParseResultForNativeParity(parseBufferNative(args, opts));
  if (isDeepStrictEqual(native, node)) return { ok: true, node, native };
  return {
    ok: false,
    node,
    native,
    message: "ATLAS native parser output does not match Node parser output",
  };
}
