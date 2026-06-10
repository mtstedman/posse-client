// @ts-check

import { getAtlasParseBandMaxRows } from "../../../settings/functions/tunables.js";
import { renderParseBand as renderParseBandRows } from "./helpers/parse-progress.js";

/**
 * @typedef {Object} ParseBandState
 * @property {Array<Record<string, unknown>>} [rows]
 * @property {Record<string, unknown>} [summary]
 * @property {number} [width]
 * @property {number} [maxRows]
 */

/**
 * @param {ParseBandState} [state]
 * @param {{ width?: number, maxRows?: number }} [opts]
 */
export function renderParseBand(state = {}, opts = {}) {
  return renderParseBandRows({
    rows: state.rows || [],
    summary: state.summary || {},
    width: opts.width || state.width || 100,
    maxRows: opts.maxRows || state.maxRows || getAtlasParseBandMaxRows(),
  });
}
