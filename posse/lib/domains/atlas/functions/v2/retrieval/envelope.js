// @ts-check
//
// Result-envelope helpers used by every retrieval handler.

/** @typedef {import("../contracts/tool-params.js").AtlasToolAction} AtlasToolAction */
/** @typedef {import("../contracts/tool-results.js").ToolError} ToolError */
/** @typedef {import("../contracts/tool-results.js").ToolMeta} ToolMeta */

/**
 * @template T
 * @param {{
 *   action: AtlasToolAction,
 *   versionId: string,
 *   data: T,
 *   meta?: ToolMeta,
 * }} input
 * @returns {{ ok: true, action: AtlasToolAction, versionId: string, data: T, meta?: ToolMeta }}
 */
export function okEnvelope({ action, versionId, data, meta }) {
  /** @type {any} */
  const env = { ok: true, action, versionId, data };
  if (meta) env.meta = meta;
  return env;
}

/**
 * @param {{
 *   action: AtlasToolAction,
 *   versionId: string,
 *   code: string,
 *   message: string,
 *   details?: Record<string, unknown>,
 *   meta?: ToolMeta,
 * }} input
 * @returns {{ ok: false, action: AtlasToolAction, versionId: string, error: ToolError, meta?: ToolMeta }}
 */
export function errorEnvelope({ action, versionId, code, message, details, meta }) {
  /** @type {ToolError} */
  const error = { code, message };
  if (details) error.details = details;
  /** @type {any} */
  const env = { ok: false, action, versionId, error };
  if (meta) env.meta = meta;
  return env;
}

/**
 * Versioned envelope for "not modified" — server skips data when an
 * ifNoneMatch header matches the resource's current etag.
 *
 * @template T
 * @param {{
 *   action: AtlasToolAction,
 *   versionId: string,
 *   etag: string,
 * }} input
 * @returns {{ ok: true, action: AtlasToolAction, versionId: string, meta: ToolMeta }}
 */
export function notModifiedEnvelope({ action, versionId, etag }) {
  return {
    ok: true,
    action,
    versionId,
    meta: { etag, notModified: true, cached: true },
  };
}
