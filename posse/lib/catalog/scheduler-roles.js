// @ts-check
import { readonlySet } from "./readonly-collections.js";



// Job types whose attempts run a tiered model. Every other job type (promote,
// atlas_warm, human_input, ...) is killed for runtime purely as stuck work.
export const MODEL_TIER_ROLES = readonlySet(["researcher", "planner", "dev", "assessor", "artificer"]);
