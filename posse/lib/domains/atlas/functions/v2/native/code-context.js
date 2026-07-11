// @ts-check
//
// Strict native boundary for Rust-owned read-time code context. Callers may
// assemble materialized view rows and retrieval envelopes, but AST parsing,
// selection, rendering, occurrence matching, and window bounds stay native.

import { runAtlasNativeMethodAsync } from "./invoke.js";

/** @typedef {import("./invoke.js").NativeMethodRunOptions} NativeMethodRunOptions */

function requireObject(method, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ATLAS native ${method} returned a non-object result`);
  }
  return /** @type {Record<string, any>} */ (value);
}

function requireCodeResult(method, value, repoRelPath) {
  const result = requireObject(method, value);
  if (result.repo_rel_path !== repoRelPath) {
    throw new Error(
      `ATLAS native ${method} returned repo_rel_path ${JSON.stringify(result.repo_rel_path)}; expected ${JSON.stringify(repoRelPath)}`,
    );
  }
  return result;
}

export async function codeSkeletonNative(payload, opts = {}) {
  return requireCodeResult("code-skeleton", await runAtlasNativeMethodAsync("code-skeleton", payload, opts), payload.repo_rel_path);
}

export async function codeHotPathNative(payload, opts = {}) {
  return requireCodeResult("code-hotpath", await runAtlasNativeMethodAsync("code-hotpath", payload, opts), payload.repo_rel_path);
}

export async function codeWindowNative(payload, opts = {}) {
  return requireCodeResult(
    "code-window",
    await runAtlasNativeMethodAsync("code-window", normalizeWindowPayload(payload), opts),
    payload.repo_rel_path,
  );
}

function normalizeWindowPayload(payload) {
  return {
    ...payload,
    granularity: payload.granularity === "fileWindow" ? "file" : payload.granularity,
  };
}
