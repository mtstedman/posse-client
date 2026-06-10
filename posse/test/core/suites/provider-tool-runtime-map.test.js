import {
  it,
  assert,
  path,
  suite,
} from "../support/core-harness.js";

let db;

suite("Provider tool runtime map", () => {
  it("returns a deterministic parse error for invalid tool JSON arguments", async () => {
    const toolRuntime = await import("../../../lib/domains/providers/functions/helpers/tool-runtime.js");
    const result = await toolRuntime.executeToolWithMap("read_file", "{bad-json", {}, {
      handlers: {},
    });

    assert.match(result, /Could not parse tool arguments as JSON/);
  });

  it("routes known tools through the map and falls back for unknown tools", async () => {
    const toolRuntime = await import("../../../lib/domains/providers/functions/helpers/tool-runtime.js");
    const result = await toolRuntime.executeToolWithMap("known_tool", "{\"value\":42}", { cwd: "C:/tmp" }, {
      handlers: {
        known_tool: (args, ctx) => `ok:${args.value}:${ctx.cwd}`,
      },
      onUnknown: (name, args) => `fallback:${name}:${args?.value ?? "none"}`,
    });
    const unknown = await toolRuntime.executeToolWithMap("unknown_tool", "{\"value\":7}", {}, {
      handlers: {
        known_tool: () => "ok",
      },
      onUnknown: (name, args) => `fallback:${name}:${args?.value ?? "none"}`,
    });

    assert.equal(result, "ok:42:C:/tmp");
    assert.equal(unknown, "fallback:unknown_tool:7");
  });

  it("rethrows async gate contention errors instead of stringifying them", async () => {
    const toolRuntime = await import("../../../lib/domains/providers/functions/helpers/tool-runtime.js");
    const gateErr = new Error("provider native tool queue wait timed out");
    gateErr.code = "ASYNC_GATE_TIMEOUT";

    await assert.rejects(
      toolRuntime.executeToolWithMap("known_tool", "{\"value\":42}", { cwd: "C:/tmp" }, {
        handlers: {
          known_tool: () => {
            throw gateErr;
          },
        },
      }),
      (err) => err === gateErr && err.code === "ASYNC_GATE_TIMEOUT",
    );
  });

  it("summarizes observed provider tool-use consistently", async () => {
    const toolRuntime = await import("../../../lib/domains/providers/functions/helpers/tool-runtime.js");
    const grep = toolRuntime.summarizeObservedToolUse("Grep", { pattern: "auth", path: "src" });
    const fallback = toolRuntime.summarizeObservedToolUse("CustomTool", { path: "src/app.js" });
    const atlas = toolRuntime.summarizeObservedToolUse("atlas_code", { action: "code.getSkeleton", file: "src/app.js" });
    const prefixedAtlas = toolRuntime.summarizeObservedToolUse("mcp__posse_gateway__atlas_code_getSkeleton", { file: "src/legacy.js" });

    assert.equal(grep.target, "\"auth\" in src");
    assert.equal(grep.summary, "Grep: \"auth\" in src");
    assert.equal(atlas.target, "src/app.js");
    assert.equal(atlas.summary, "atlas code.getSkeleton: src/app.js");
    assert.equal(prefixedAtlas.summary, "atlas code.getSkeleton: src/legacy.js");
    assert.match(fallback.summary, /CustomTool:/);
  });
});
