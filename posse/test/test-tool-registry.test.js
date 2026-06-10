// Unit coverage for the ToolRegistry and the embedded runtime's attachment to
// it. Locks the registry-built handler map and function advertisement so the
// unified executor wiring stays in sync with the shared suite metadata.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../lib/classes/tools/ToolRegistry.js";
import {
  declareToolSuites,
  embeddedAdvertisedToolNames,
  getToolMetadataRegistry,
} from "../lib/functions/tools/tool-suites.js";
import { createStandardToolHandlerMap } from "../lib/domains/providers/functions/helpers/tool-runtime.js";

const EXPECTED_FUNCTION_ADVERTISED = [
  "bash",
  "chain_read",
  "chain_verdict",
  "clean_image",
  "edit_file",
  "extract_image_text",
  "generate_image",
  "git_history",
  "hash_file",
  "inspect_file",
  "list_files",
  "prune_artifact_output",
  "read_file",
  "read_image_metadata",
  "search_files",
  "validate_artifact_output",
  "write_file",
].sort();

const EXPECTED_EMBEDDED_HANDLERS = [
  ...EXPECTED_FUNCTION_ADVERTISED,
  "optimize_image",
  "pull_brief",
  "reencode_image",
  "resize_image",
].sort();

describe("ToolRegistry", () => {
  it("declares ids as suite.name and attaches executors by id or bare name", () => {
    const reg = new ToolRegistry();
    reg.declare({ suite: "tools", name: "demo", roles: ["dev"], mutatesWorktree: true, advertise: ["function"] });
    assert.ok(reg.has("tools.demo"));
    assert.ok(reg.has("demo"));
    assert.equal(reg.get("demo").mutatesWorktree, true);
    reg.attach("demo", () => "ok");
    assert.equal(reg.handlerMap().demo(), "ok");
    assert.deepEqual(reg.advertisedNames("function"), ["demo"]);
  });

  it("rejects unknown transports and attaching to undeclared tools", () => {
    const reg = new ToolRegistry();
    assert.throws(() => reg.declare({ suite: "tools", name: "x", advertise: ["telepathy"] }), /unknown transport/);
    assert.throws(() => reg.attach("nope", () => {}), /no declared tool/);
  });

  it("seeds the deterministic tools suite", () => {
    const reg = declareToolSuites(new ToolRegistry());
    assert.ok(reg.has("tools.read_file"));
    assert.equal(reg.get("write_file").mutatesWorktree, true);
    assert.equal(reg.get("read_file").mutatesWorktree, false);
  });
});

describe("embedded runtime registry attachment", () => {
  it("advertises exactly the function-transport tool set", () => {
    assert.deepEqual([...embeddedAdvertisedToolNames()].sort(), EXPECTED_FUNCTION_ADVERTISED);
    assert.deepEqual(getToolMetadataRegistry().advertisedNames("function").sort(), EXPECTED_FUNCTION_ADVERTISED);
  });

  it("builds the embedded handler map from the registry with the expected handlers", () => {
    // Stub executors: createStandardToolHandlerMap only wires references; the
    // handler bodies are not invoked here, so identity stubs are sufficient.
    const stub = () => "stub";
    const handlers = createStandardToolHandlerMap({
      deterministicReadFile: stub,
      deterministicWriteFile: stub,
      deterministicEditFile: stub,
      deterministicListFiles: stub,
      deterministicSearchFiles: stub,
      deterministicGitHistory: stub,
      deterministicInspectFile: stub,
      deterministicHashFile: stub,
      deterministicPullBrief: stub,
      deterministicResizeImage: stub,
      deterministicValidateArtifactOutput: stub,
      deterministicPruneArtifactOutput: stub,
      deterministicReadImageMetadata: stub,
      deterministicOptimizeImage: stub,
      deterministicReencodeImage: stub,
      deterministicCleanImage: stub,
      deterministicExtractImageText: stub,
      deterministicBash: stub,
      execGenerateImage: stub,
      safePath: (cwd, p) => p,
    });
    assert.deepEqual(Object.keys(handlers).sort(), EXPECTED_EMBEDDED_HANDLERS);
  });
});
