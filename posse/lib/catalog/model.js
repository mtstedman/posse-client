// Model-domain catalogue.
//
// Cost tiers shared by every provider. Note: a separate, identically-valued
// `JOB_MODEL_TIERS` lives in `lib/catalog/job.js` for the jobs.model_tier
// CHECK constraint; the two are kept distinct so the schema enum can evolve
// independently of provider tier-routing semantics if needed.

export const MODEL_TIERS = Object.freeze(["cheap", "standard", "strong"]);
