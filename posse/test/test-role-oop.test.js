import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BaseRole } from "../lib/domains/worker/classes/BaseRole.js";
import { RoleRegistry } from "../lib/domains/worker/classes/RoleRegistry.js";

function makeProviderClient() {
  return { call: async () => ({ output: "ok", stats: {} }) };
}

describe("BaseRole", () => {
  it("requires an injected provider client", () => {
    assert.throws(
      () => new BaseRole(),
      /BaseRole requires providerClient/,
    );
  });

  it("exposes role identity from the concrete agent class", () => {
    class ExampleRole extends BaseRole {
      static role = "example";
      buildContract() {
        return "";
      }
    }

    const role = new ExampleRole({ providerClient: makeProviderClient() });

    assert.equal(role.getRole(), "example");
  });

  it("requires concrete roles to implement buildContract for the template method", async () => {
    class ExampleRole extends BaseRole {
      static role = "example";
    }
    const role = new ExampleRole({ providerClient: makeProviderClient() });

    await assert.rejects(
      () => role.run({ id: 1, work_item_id: 2 }),
      /ExampleRole\.buildContract\(\) must be implemented by subclasses/,
    );
  });

  it("passes provider identity and agent role through the template method", async () => {
    const calls = [];
    class ExampleRole extends BaseRole {
      static role = "example";
      async assembleContext() {
        return "context body";
      }
      buildContract({ providerName }) {
        return `contract for ${providerName}`;
      }
      async processOutput(output) {
        return output;
      }
    }
    const providerClient = {
      call: async (prompt, opts, meta) => {
        calls.push({ prompt, opts, meta });
        return { output: "done", stats: {} };
      },
    };
    const role = new ExampleRole({
      providerClient,
      context: { projectDir: "/tmp/project" },
    });

    const result = await role.run({ id: 1, work_item_id: 2, provider: "openai" }, { tier: "cheap" });

    assert.equal(result, "done");
    assert.equal(calls[0].prompt, "contract for openai\n\ncontext body");
    assert.equal(calls[0].opts.role, "example");
    assert.equal(calls[0].opts.modelTier, "cheap");
    assert.equal(calls[0].meta.jobProvider, "openai");
    assert.equal(calls[0].meta.cwd, "/tmp/project");
  });

  it("awaits async prompt composition before provider execution", async () => {
    const calls = [];
    class ExampleRole extends BaseRole {
      static role = "example";
      buildContract({ providerName }) {
        return `contract for ${providerName}`;
      }
      async composePrompt({ contract }) {
        await Promise.resolve();
        return `${contract}\nasync prompt`;
      }
    }
    const role = new ExampleRole({
      providerClient: {
        call: async (prompt) => {
          calls.push(prompt);
          return { output: "done", stats: {} };
        },
      },
    });

    await role.run({ id: 1, work_item_id: 2, provider: "openai" });

    assert.deepEqual(calls, ["contract for openai\nasync prompt"]);
  });

  it("builds provider fallback prompts through the async composition path", async () => {
    const prompts = [];
    class ExampleRole extends BaseRole {
      static role = "example";
      buildContract({ providerName }) {
        return `contract for ${providerName}`;
      }
      async composePrompt({ contract }) {
        await Promise.resolve();
        return `${contract}\nasync prompt`;
      }
    }
    const role = new ExampleRole({
      providerClient: {
        call: async (prompt, opts) => {
          prompts.push(prompt);
          prompts.push(await opts.buildFallbackPrompt({ providerName: "grok" }));
          return { output: "done", stats: {} };
        },
      },
    });

    await role.run({ id: 1, work_item_id: 2, provider: "openai" });

    assert.deepEqual(prompts, [
      "contract for openai\nasync prompt",
      "contract for grok\nasync prompt",
    ]);
  });

  it("runs teardown even when provider execution fails", async () => {
    let tornDown = false;
    class ExampleRole extends BaseRole {
      static role = "example";
      buildContract() {
        return "contract";
      }
      async teardown() {
        tornDown = true;
      }
    }
    const role = new ExampleRole({
      providerClient: {
        call: async () => { throw new Error("provider failed"); },
      },
    });

    await assert.rejects(
      () => role.run({ id: 1, work_item_id: 2 }),
      /provider failed/,
    );
    assert.equal(tornDown, true);
  });

  it("fails before provider execution when a role produces an empty prompt", async () => {
    class ExampleRole extends BaseRole {
      static role = "example";
      buildContract() {
        return "";
      }
    }
    let called = false;
    const role = new ExampleRole({
      providerClient: {
        call: async () => {
          called = true;
          return { output: "unexpected", stats: {} };
        },
      },
    });

    await assert.rejects(
      () => role.run({ id: 1, work_item_id: 2 }),
      /ExampleRole produced empty prompt/,
    );
    assert.equal(called, false);
  });

  it("can skip prompt construction for deterministic provider results", async () => {
    const calls = [];
    class ExampleRole extends BaseRole {
      static role = "example";
      async assembleContext(_job, ctx) {
        ctx.providerResult = {
          output: "deterministic",
          skipPromptBuild: true,
          stats: { deterministic: true },
        };
        return "context";
      }
      buildContract() {
        calls.push("buildContract");
        return "contract";
      }
      composePrompt() {
        calls.push("composePrompt");
        return "prompt";
      }
      async processOutput(output, stats) {
        calls.push(["processOutput", output, stats]);
        return output;
      }
    }
    const role = new ExampleRole({
      providerClient: {
        call: async () => {
          calls.push("provider");
          return { output: "unexpected", stats: {} };
        },
      },
    });

    const result = await role.run({ id: 1, work_item_id: 2 });

    assert.equal(result, "deterministic");
    assert.deepEqual(calls, [["processOutput", "deterministic", { deterministic: true }]]);
  });

  it("checks success and failure spawn pools on the concrete role class", () => {
    class ExampleRole extends BaseRole {
      static spawnsOnSuccess = ["dev"];
      static spawnsOnFailure = ["human_input"];
    }

    const role = new ExampleRole({ providerClient: makeProviderClient() });

    assert.equal(role.canSpawn("dev", "succeeded"), true);
    assert.equal(role.canSpawn("human_input", "succeeded"), false);
    assert.equal(role.canSpawn("human_input", "failed"), true);
    assert.equal(role.canSpawn("dev", "failed"), false);
    assert.throws(
      () => role.canSpawn("human_input", "stalled"),
      /outcome must be "succeeded" or "failed"/,
    );
  });
});

describe("RoleRegistry", () => {
  it("instantiates registered roles with shared DI and resolves them by job type", () => {
    const providerClient = makeProviderClient();
    const context = { projectDir: "/tmp/project" };
    const deps = { marker: true };
    class ExampleRole extends BaseRole {}

    const registry = new RoleRegistry({ providerClient, context, deps });
    const role = registry.register("research", ExampleRole);

    assert.equal(registry.has("research"), true);
    assert.equal(registry.has("missing"), false);
    assert.equal(registry.get("research"), role);
    assert.equal(registry.get("missing"), null);
    assert.equal(role.providerClient, providerClient);
    assert.equal(role.context, context);
    assert.equal(role.deps, deps);
  });
});
