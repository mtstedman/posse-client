// lib/domains/atlas/functions/v2/parse/conductor-git-routes.js
//
// Native Git grants a conductor op must hold before it runs.

import { ATLAS_SCIP_WARM_PURPOSES } from "../../../../../catalog/atlas.js";
import { GIT_MUTATE_ROUTE, GIT_READ_ROUTE } from "../../../../../catalog/binary.js";

/**
 * SCIP staging hashes each language's fileset with `git ls-tree`, which the
 * native encoder classifies as git:mutate, and the SCIP sanitizer needs an
 * exact tracked-file manifest; both run as synchronous native calls that fail
 * on a cold route instead of waiting. A main warm that lacked the grant could
 * not compute the fileset hash, fell back to "head_changed", and re-indexed
 * every language on each merge, including languages the merge never touched.
 *
 * @param {string} op conductor op name
 * @param {string} [purpose] warm job purpose, for the `warm` op
 * @returns {string[]} routes to prewarm before running the op
 */
export function conductorGitRoutes(op, purpose = "") {
  if (op === "stage") return [GIT_READ_ROUTE, GIT_MUTATE_ROUTE];
  if (op === "warm" && ATLAS_SCIP_WARM_PURPOSES.includes(String(purpose || ""))) {
    return [GIT_READ_ROUTE, GIT_MUTATE_ROUTE];
  }
  return [];
}
