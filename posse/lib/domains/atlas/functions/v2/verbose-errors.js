// @ts-check
//
// Verbose-error helpers for ATLAS v2 indexing.
//
// ATLAS v2 is intentionally best-effort: warm jobs catch parser failures,
// missing parsers, busted views, etc. and degrade to "skipped" records
// rather than fail loudly. That keeps the pipeline running when the
// index is incomplete, but it also hides real bugs — an operator who
// runs `posse run` and sees nothing indexed has no easy way to find out
// WHY.
//
// The DB-backed `atlas_verbose_errors` setting flips a switch that:
//   * logs every caught error to stderr WITH the full Error object so
//     stacks are visible;
//   * appends a one-line stack abbreviation to "skipped" / "failed"
//     messages so the same context shows up in event logs / artifacts;
//
// The default (no flag set) preserves the legacy quiet behavior — only
// short message strings, no stack traces, no extra stderr output.

import { getAccountSetting } from "../../../settings/functions/account-settings.js";

const TRUTHY_RE = /^(1|true|yes|on)$/i;

/**
 * @returns {boolean}
 */
export function isVerboseAtlasErrors() {
  try {
    return TRUTHY_RE.test(String(getAccountSetting("atlas_verbose_errors") || ""));
  } catch {
    return false;
  }
}

/**
 * Format an error for inclusion in a user-facing message (a skipped
 * record, event log, etc.). In verbose mode, appends the stack; in
 * default mode, returns the bare message.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function formatAtlasError(err) {
  if (!err) return "(no error)";
  const e = /** @type {any} */ (err);
  const msg = typeof e?.message === "string" ? e.message : String(err);
  if (!isVerboseAtlasErrors()) return msg;
  const stack = typeof e?.stack === "string" ? e.stack : null;
  if (!stack) return msg;
  // Stack already includes the message on the first line; just use it.
  return stack;
}

/**
 * Log an error to stderr at full fidelity. Suppressed entirely in
 * default mode so we don't spam the log on every parse error.
 *
 * @param {string} prefix    Tag identifying the call site, e.g. "[atlas-warm]".
 * @param {unknown} err
 * @returns {void}
 */
export function logAtlasError(prefix, err) {
  if (!isVerboseAtlasErrors()) return;
  // eslint-disable-next-line no-console
  console.error(prefix, err);
}
