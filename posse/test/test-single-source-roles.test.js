import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { validateAdminSettingValue } from "../lib/domains/ui/classes/admin/settings-controller.js";
import { SpawnPolicy } from "../lib/shared/policies/classes/SpawnPolicy.js";
import {
  ROLE_CLASSES_BY_JOB_TYPE,
  ROLE_CLASSES_BY_ROLE_NAME,
  ROLE_CLASS_ROLE_NAME_COLLISIONS,
  assertRoleClassRegistryExhaustive,
  getRoleClassForRoleName,
  missingRoleClassJobTypes,
} from "../lib/domains/worker/classes/role-classes.js";
import {
  JOB_TYPES,
  NON_PROVIDER_JOB_TYPES,
} from "../lib/catalog/job.js";
import {
  JOB_TYPE_ROLE_REGISTRY,
  PROVIDER_ROLE_NAMES,
  PROVIDER_ROLE_SETTING_DEFS,
  delegationRoleForJobType,
  providerRoleForJobType,
  spawnPolicyRoleForJobType,
  workerRoleForJobType,
} from "../lib/domains/providers/functions/roles.js";
import { SETTINGS_CATALOG } from "../lib/domains/settings/functions/catalog.js";
import { spawnPolicyForRoleName } from "../lib/domains/worker/functions/helpers/role-spawn-policies.js";
import { buildCurrentRoleContract } from "../lib/domains/worker/functions/role-contract-view.js";
import {
  resetActivePromptBundleForTest,
  setActivePromptBundleForTest,
} from "../lib/domains/remote/functions/prompt-bundle.js";

const TEST_PROMPT_BUNDLE = {
  schema_version: 1,
  prompt_version: "single-source-roles-test",
  roles: {
    researcher: { markdown: "Researcher role prompt." },
    planner: { markdown: "Planner role prompt." },
    dev: { markdown: "Developer role prompt." },
    assessor: { markdown: "Assessor role prompt." },
    artificer: { markdown: "Artificer role prompt." },
    delegator: { markdown: "Delegator role prompt." },
    preflight: { markdown: "Preflight Routing role prompt." },
  },
};

describe("role and provider single-source guards", () => {
  before(() => {
    setActivePromptBundleForTest(TEST_PROMPT_BUNDLE);
  });

  after(() => {
    resetActivePromptBundleForTest();
  });

  it("catalogs and validates every provider role setting from the shared role list", () => {
    const catalogKeys = new Set(SETTINGS_CATALOG.map((setting) => setting.key));
    assert.deepEqual(
      PROVIDER_ROLE_SETTING_DEFS.map((setting) => setting.key),
      PROVIDER_ROLE_NAMES.map((role) => `provider_${role}`)
    );

    for (const role of PROVIDER_ROLE_NAMES) {
      const key = `provider_${role}`;
      assert.ok(catalogKeys.has(key), `${key} is missing from SETTINGS_CATALOG`);
      const result = validateAdminSettingValue(key, "openai");
      assert.equal(result.ok, true, `${key} should validate`);
      assert.equal(result.value, "openai", `${key} should preserve provider value`);
    }
  });

  it("uses the shared job-type provider role mapping for runtime roles", () => {
    assert.equal(providerRoleForJobType("research"), "researcher");
    assert.equal(providerRoleForJobType("plan"), "planner");
    assert.equal(providerRoleForJobType("fix"), "dev");
    assert.equal(providerRoleForJobType("preflight"), "preflight");
    assert.equal(delegationRoleForJobType("assess"), "assessor");
    assert.equal(workerRoleForJobType("promote"), "system");
    assert.equal(spawnPolicyRoleForJobType("summarize"), "summary");
  });

  it("builds contract previews from the same role class registry as Worker", () => {
    for (const [jobType, RoleClass] of Object.entries(ROLE_CLASSES_BY_JOB_TYPE)) {
      const preview = buildCurrentRoleContract({
        job: {
          id: 1,
          job_type: jobType,
          work_item_id: 1,
          payload_json: "{}",
          title: `${jobType}: preview`,
        },
        providerName: "claude",
        projectDir: process.cwd(),
      });

      assert.equal(preview.role, RoleClass.role, `${jobType} role preview drifted`);
      assert.equal(typeof preview.contract, "string", `${jobType} contract must be string`);
    }
  });

  it("derives SpawnPolicy from role class spawn declarations", () => {
    for (const [roleName, roleClasses] of ROLE_CLASSES_BY_ROLE_NAME.entries()) {
      // Ambiguous static role names are pinned in the collision test below;
      // per-job-type policy coverage lives in the reverse-direction test.
      if (roleClasses.length !== 1) continue;
      const policy = SpawnPolicy.for(roleName);
      const [RoleClass] = roleClasses;
      assert.deepEqual(policy.succeeds, [...new Set(RoleClass.spawnsOnSuccess || [])]);
      assert.deepEqual(policy.fails, [...new Set(RoleClass.spawnsOnFailure || [])]);
    }
  });

  it("keeps role-name registry collisions explicit", () => {
    assert.deepEqual(
      ROLE_CLASS_ROLE_NAME_COLLISIONS.map((entry) => ({
        roleName: entry.roleName,
        classNames: [...entry.classNames].sort(),
      })),
      [
        { roleName: "planner", classNames: ["PlannerRole", "SummaryRole"] },
        { roleName: "dev", classNames: ["DeveloperRole", "FixRole"] },
      ],
    );
    assert.deepEqual(
      ROLE_CLASSES_BY_ROLE_NAME.get("dev").map((RoleClass) => RoleClass.name).sort(),
      ["DeveloperRole", "FixRole"],
    );
    assert.deepEqual(
      ROLE_CLASSES_BY_ROLE_NAME.get("planner").map((RoleClass) => RoleClass.name).sort(),
      ["PlannerRole", "SummaryRole"],
    );
    assert.throws(() => getRoleClassForRoleName("dev"), /multiple job role classes/);
    assert.equal(getRoleClassForRoleName("assessor").name, "AssessorRole");
  });

  it("exposes the role-name registry as a read-only view", () => {
    assert.equal(typeof ROLE_CLASSES_BY_ROLE_NAME.set, "undefined");
    assert.equal(typeof ROLE_CLASSES_BY_ROLE_NAME.delete, "undefined");
    assert.equal(Object.isFrozen(ROLE_CLASSES_BY_ROLE_NAME), true);
    assert.throws(() => { ROLE_CLASSES_BY_ROLE_NAME.extra = true; }, /Cannot add property|not extensible|read only/i);
  });

  it("derives role class spawn declarations from the shared spawn policy source", () => {
    for (const [jobType, RoleClass] of Object.entries(ROLE_CLASSES_BY_JOB_TYPE)) {
      const policy = spawnPolicyForRoleName(spawnPolicyRoleForJobType(jobType));
      assert.deepEqual(RoleClass.spawnsOnSuccess, policy.succeeds, `${jobType} success spawns drifted`);
      assert.deepEqual(RoleClass.spawnsOnFailure, policy.fails, `${jobType} failure spawns drifted`);
    }
  });

  it("keeps job-type role registry aligned with registered worker role classes", () => {
    for (const [jobType, RoleClass] of Object.entries(ROLE_CLASSES_BY_JOB_TYPE)) {
      const registryEntry = JOB_TYPE_ROLE_REGISTRY[jobType];
      assert.ok(registryEntry, `${jobType} is missing from JOB_TYPE_ROLE_REGISTRY`);
      assert.equal(registryEntry.worker, RoleClass.role, `${jobType} worker role drifted`);
    }
  });

  it("has a worker role class or non-provider exemption for every job type", () => {
    assert.equal(assertRoleClassRegistryExhaustive(), true);
    assert.deepEqual(missingRoleClassJobTypes(), []);

    const providerJobTypes = JOB_TYPES.filter((jobType) => !NON_PROVIDER_JOB_TYPES.has(jobType));
    for (const jobType of providerJobTypes) {
      assert.ok(ROLE_CLASSES_BY_JOB_TYPE[jobType], `${jobType} is missing a worker role class`);
    }
  });
});
