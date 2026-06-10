// Parity invariants binding the shared tool metadata to the executors each
// runtime attaches. Mirrors the boot-time assertions so drift fails in CI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../lib/classes/tools/ToolRegistry.js";
import {
  declareToolSuites,
  getToolMetadataRegistry,
} from "../lib/functions/tools/tool-suites.js";
import {
  READ_ONLY_ROLES,
  assertMutationRoleSafety,
  assertAdvertisedHaveExecutors,
} from "../lib/functions/tools/tool-parity.js";
import { createStandardToolHandlerMap } from "../lib/domains/providers/functions/helpers/tool-runtime.js";

const STUB_DEPS = Object.fromEntries(
  [
    "deterministicReadFile", "deterministicWriteFile", "deterministicEditFile",
    "deterministicListFiles", "deterministicSearchFiles", "deterministicGitHistory",
    "deterministicInspectFile", "deterministicHashFile", "deterministicPullBrief",
    "deterministicResizeImage", "deterministicValidateArtifactOutput",
    "deterministicPruneArtifactOutput", "deterministicReadImageMetadata",
    "deterministicOptimizeImage", "deterministicReencodeImage", "deterministicCleanImage",
    "deterministicExtractImageText", "deterministicBash", "execGenerateImage",
  ].map((k) => [k, () => "stub"]),
);
STUB_DEPS.safePath = (cwd, p) => p;

describe("tool parity", () => {
  it("no worktree-mutating tool is allowed for a read-only role", () => {
    // Real metadata registry. (getToolMetadataRegistry asserts this at boot too.)
    assert.doesNotThrow(() => assertMutationRoleSafety(getToolMetadataRegistry()));
  });

  it("the mutation/role invariant actually catches a violation", () => {
    const reg = new ToolRegistry();
    reg.declare({ suite: "tools", name: "bad", roles: ["researcher"], mutatesWorktree: true, advertise: [] });
    assert.throws(() => assertMutationRoleSafety(reg), /mutates the worktree.*read-only/s);
  });

  it("every function-advertised tool has an embedded executor", () => {
    const handlers = createStandardToolHandlerMap(STUB_DEPS);
    const registry = declareToolSuites(new ToolRegistry());
    assert.doesNotThrow(() => assertAdvertisedHaveExecutors(registry, Object.keys(handlers), "function"));
  });

  it("the advertised/executor invariant catches a missing executor", () => {
    const reg = declareToolSuites(new ToolRegistry());
    // read_file is function-advertised; an empty executor set must fail.
    assert.throws(() => assertAdvertisedHaveExecutors(reg, [], "function"), /without an attached executor/);
  });

  it("read-only roles never receive write/edit/bash-mutation tools in the catalog", () => {
    const reg = getToolMetadataRegistry();
    for (const entry of reg.all()) {
      if (!entry.mutatesWorktree) continue;
      for (const role of entry.roles) {
        assert.ok(!READ_ONLY_ROLES.includes(role), `${entry.id} -> ${role}`);
      }
    }
  });
});
