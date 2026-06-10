// @ts-check
//
// Compatibility alias for the pre-Atlas-Parse class name. New code should
// import ParseEngine directly; Warmer stays available for one release.

import { ParseEngine } from "./ParseEngine.js";

export class Warmer extends ParseEngine {}

export { ParseEngine };
