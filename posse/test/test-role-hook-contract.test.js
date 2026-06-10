import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BaseRole } from "../lib/domains/worker/classes/BaseRole.js";
import { AssessorRole } from "../lib/domains/worker/classes/roles/assessor.js";
import { ArtificerRole } from "../lib/domains/worker/classes/roles/artificer.js";
import { DelegateRole } from "../lib/domains/worker/classes/roles/delegate.js";
import { DeveloperRole } from "../lib/domains/worker/classes/roles/developer.js";
import { FixRole } from "../lib/domains/worker/classes/roles/fix.js";
import { PlannerRole } from "../lib/domains/worker/classes/roles/planner.js";
import { PreflightRole } from "../lib/domains/worker/classes/roles/preflight.js";
import { ResearcherRole } from "../lib/domains/worker/classes/roles/researcher.js";
import { SummaryRole } from "../lib/domains/worker/classes/roles/summary.js";

const ROLE_CLASSES = [
  AssessorRole,
  ArtificerRole,
  DelegateRole,
  DeveloperRole,
  FixRole,
  PlannerRole,
  PreflightRole,
  ResearcherRole,
  SummaryRole,
];

const TEMPLATE_HOOKS = [
  "assembleContext",
  "buildContract",
  "composePrompt",
  "processOutput",
];

const REQUIRED_ROLE_OVERRIDES = [
  "assembleContext",
  "buildContract",
  "processOutput",
];

function createRole(RoleClass) {
  return new RoleClass({
    providerClient: {
      call: async () => ({ output: "ok", stats: {} }),
    },
    context: {
      projectDir: process.cwd(),
      emit() {},
      parsePayload: (job) => JSON.parse(job?.payload_json || "{}"),
    },
    deps: {},
  });
}

describe("role hook contract", () => {
  it("keeps every role on the BaseRole run template", () => {
    for (const RoleClass of ROLE_CLASSES) {
      const role = createRole(RoleClass);
      const label = RoleClass.name;

      assert.equal(RoleClass.prototype instanceof BaseRole, true, `${label} should extend BaseRole`);
      assert.equal(Object.hasOwn(RoleClass.prototype, "run"), false, `${label} should not override run()`);
      assert.equal(role.hasCustomRun(), false, `${label} should use BaseRole.run()`);

      for (const hook of TEMPLATE_HOOKS) {
        assert.equal(typeof role[hook], "function", `${label}.${hook} should be callable`);
      }

      for (const hook of REQUIRED_ROLE_OVERRIDES) {
        assert.notEqual(
          RoleClass.prototype[hook],
          BaseRole.prototype[hook],
          `${label}.${hook} should be owned by the role`,
        );
      }
    }
  });
});
