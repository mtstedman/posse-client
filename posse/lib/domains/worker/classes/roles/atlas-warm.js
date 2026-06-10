// ATLAS v2 warm role.
//
// `atlas_warm` is a deterministic job — no LLM call, no model tier, no
// reasoning effort. The role class exists primarily for parity with the
// rest of posse's role registry; its `run()` delegates to the deterministic
// executor in lib/domains/worker/functions/execution/atlas-warm-job.js, which lives
// outside the BaseRole.providerClient.call() flow.

import { BaseRole } from "../BaseRole.js";
import { runAtlasWarmJob } from "../../functions/execution/atlas-warm-job.js";
import { ATLAS_WARM_JOB_POLICY } from "../../../atlas/functions/v2/contracts/jobs.js";

export class AtlasWarmRole extends BaseRole {
  static role = "atlas-warm";
  static spawnsOnSuccess = [];
  static spawnsOnFailure = [];
  static deterministic = true;
  static jobPolicy = ATLAS_WARM_JOB_POLICY;

  constructor(args = {}) {
    // Allow construction without a providerClient since this role never
    // calls a provider — installs a no-op shim that satisfies BaseRole's
    // constructor assertion.
    super({
      ...args,
      providerClient: args.providerClient || {
        call() {
          throw new Error("AtlasWarmRole must not invoke providerClient.call");
        },
      },
    });
  }

  hasCustomRun() {
    return true;
  }

  // Bypass the LLM template entirely. The deterministic executor handles
  // attempt accounting, lease release, and result storage.
  async run(job, _ctx = {}) {
    if (!this.context) {
      throw new Error("AtlasWarmRole.run requires a worker context");
    }
    const worker = this.context;
    return runAtlasWarmJob(worker, job, /* wrappedJob */ null, {
      leaseToken: job?._leaseToken ?? null,
      abortSignal: job?._abortSignal ?? null,
    });
  }

  buildContract() {
    return "";
  }

  buildOpts(job) {
    return {
      role: this.getRole(),
      modelTier: job?.model_tier || "standard",
    };
  }
}
