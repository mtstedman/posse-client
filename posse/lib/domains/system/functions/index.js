// @ts-check
//
// Trusted in-process system operations and system-domain helper exports.

import * as atlas from "./atlas.js";
import * as git from "./git.js";

export * from "./atlas.js";
export * from "./dependency-sync.js";
export * from "./git.js";
export * from "./preflight-probes.js";

export { atlas, git };

export const system = Object.freeze({
  atlas,
  git,
});
