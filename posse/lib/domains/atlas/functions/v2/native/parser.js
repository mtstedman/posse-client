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
import {
  __atlasNativeManagerForTests,
  runAtlasNativeMethodAsync,
} from "./invoke.js";

/** @typedef {import("../contracts/schemas.js").ParseResult} ParseResult */

export const ATLAS_NATIVE_PARSE_BUFFER_METHOD = "parser.parseBuffer";

/** @type {import("./invoke.js").NativeMethodRunOptions | null} */
let parserNativeOptionsForTests = null;

/**
 * Narrow test hook for exercising the strict parser boundary against an
 * injected real debug binary. Production never sets this.
 *
 * @param {import("./invoke.js").NativeMethodRunOptions | null} opts
 */
export function __setParseBufferNativeOptionsForTests(opts) {
  parserNativeOptionsForTests = opts && typeof opts === "object" ? opts : null;
}

export function __parseBufferNativeManagerForTests() {
  // Match parseBufferNative's effective option precedence: a parser-specific
  // manager wins, then the process-wide Atlas test manager. Capability checks
  // must resolve the same binary that the eventual native parse call will use.
  return parserNativeOptionsForTests?.manager || __atlasNativeManagerForTests();
}

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
 * parser and does not fall back. Routed through the persistent worker —
 * one warm process parses every file instead of one spawn per file.
 *
 * @param {{
 *   bytes: Buffer | string,
 *   repo_rel_path: string,
 *   lang?: string,
 * }} args
 * @param {import("./invoke.js").NativeMethodRunOptions} [opts]
 * @returns {Promise<ParseResult>}
 */
export async function parseBufferNative(args, opts = {}) {
  const payload = buildParseBufferNativePayload(args);
  const runOptions = parserNativeOptionsForTests ? { ...parserNativeOptionsForTests, ...opts } : opts;
  const result = await runAtlasNativeMethodAsync(ATLAS_NATIVE_PARSE_BUFFER_METHOD, payload, runOptions);
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
 *   manager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ ok: true, node: unknown, native: unknown } | { ok: false, node: unknown, native: unknown, message: string }>}
 */
export async function diffParseBufferNativeParity(args, opts) {
  if (typeof opts?.nodeParseBuffer !== "function") {
    throw new TypeError("diffParseBufferNativeParity requires nodeParseBuffer");
  }
  const node = normalizeParseResultForNativeParity(opts.nodeParseBuffer(args));
  const native = normalizeParseResultForNativeParity(await parseBufferNative(args, opts));
  if (isDeepStrictEqual(native, node)) return { ok: true, node, native };
  return {
    ok: false,
    node,
    native,
    message: "ATLAS native parser output does not match Node parser output",
  };
}
