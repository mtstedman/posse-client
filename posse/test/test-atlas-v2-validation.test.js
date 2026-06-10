import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dispatch } from "../lib/domains/atlas/functions/v2/retrieval/dispatch.js";
import {
  ATLAS_TOOL_PARAM_SCHEMAS,
  normalizeAtlasToolCall,
  validateAtlasToolCall,
} from "../lib/domains/atlas/functions/v2/contracts/tool-schemas.js";
import { ATLAS_RUNTIME_INPUTS } from "../lib/domains/atlas/functions/v2/contracts/runtimes.js";
import { ATLAS_TOOL_DEFS } from "../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js";

describe("ATLAS v2 parameter validation", () => {
  it("rejects unsupported parameters before handlers run", () => {
    const result = dispatch(
      /** @type {any} */ ({
        action: "file.read",
        filePath: "package.json",
        sneaky: true,
      }),
      {
        versionId: "v1",
        readFile() {
          assert.fail("file.read handler should not run for invalid params");
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_params");
    assert.equal(result.error?.details?.errors?.[0]?.path, "$.sneaky");
  });

  it("rejects unbounded slice budgets before view mounting", () => {
    const result = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "debug auth",
        budget: {
          maxCards: 100_000,
          maxEstimatedTokens: 999_999_999,
        },
      }),
      { versionId: "v1" },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_params");
    assert.equal(result.error?.details?.errors?.some((entry) => entry.path === "$.budget.maxCards"), true);
  });

  it("accepts packed slice wire format and slice ETag params", () => {
    const valid = validateAtlasToolCall(/** @type {any} */ ({
      action: "slice.build",
      taskText: "debug auth",
      wireFormat: "packed",
      ifNoneMatch: "slice:abc",
      budget: { maxCards: 5, maxEstimatedTokens: 2000 },
    }));
    assert.equal(valid.ok, true);

    const invalid = validateAtlasToolCall(/** @type {any} */ ({
      action: "slice.build",
      taskText: "debug auth",
      wireFormat: "protobuf",
    }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.some((entry) => entry.path === "$.wireFormat"), true);
  });

  it("normalizes optional enum mistakes before dispatcher validation", () => {
    const normalized = normalizeAtlasToolCall(/** @type {any} */ ({
      action: "slice.build",
      taskText: "debug auth",
      cardDetail: "summary",
      wireFormat: "columnar",
      taskType: "made-up-task",
    }));
    assert.equal(/** @type {any} */ (normalized).cardDetail, "compact");
    assert.equal(/** @type {any} */ (normalized).wireFormat, "packed");
    assert.equal(Object.prototype.hasOwnProperty.call(normalized, "taskType"), false);
    assert.equal(validateAtlasToolCall(normalized).ok, true);

    const result = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "debug auth",
        cardDetail: "summary",
      }),
      { versionId: "v1" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "not_indexed");
  });

  it("validates workflow step arguments at the dispatcher boundary", () => {
    const result = dispatch(
      /** @type {any} */ ({
        action: "workflow",
        steps: [],
      }),
      { versionId: "v1" },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_params");
    assert.equal(result.error?.details?.errors?.[0]?.path, "$.steps");
  });

  it("rejects agent-supplied versionId for feedback params", () => {
    const result = dispatch(
      /** @type {any} */ ({
        action: "agent.feedback",
        versionId: "agent-supplied",
        sliceHandle: "sl_abc",
      }),
      { versionId: "runtime@1" },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_params");
    assert.equal(result.error?.details?.errors?.[0]?.path, "$.versionId");
  });

  it("keeps runtime aliases explicit in the schema", () => {
    assert.deepEqual(
      ATLAS_TOOL_PARAM_SCHEMAS["runtime.execute"].properties.runtime.enum,
      ATLAS_RUNTIME_INPUTS,
    );
    assert.deepEqual(
      ATLAS_TOOL_DEFS["runtime.execute"].parameters.properties.runtime.enum,
      ATLAS_RUNTIME_INPUTS,
    );

    assert.deepEqual(
      validateAtlasToolCall(/** @type {any} */ ({
        action: "runtime.execute",
        runtime: "javascript",
        code: "console.log('ok')",
        persistOutput: false,
      })),
      { ok: true },
    );

    const invalid = validateAtlasToolCall(/** @type {any} */ ({
      action: "runtime.execute",
      runtime: "made-up-runtime",
    }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors[0].path, "$.runtime");
  });

  it("accepts only numeric legacy strings for code.needWindow expectedLines", () => {
    const valid = validateAtlasToolCall(/** @type {any} */ ({
      action: "code.needWindow",
      file: "src/app.ts",
      reason: "Need focused implementation context",
      expectedLines: "40",
      identifiersToFind: ["handler"],
    }));
    assert.equal(valid.ok, true);

    const invalid = validateAtlasToolCall(/** @type {any} */ ({
      action: "code.needWindow",
      file: "src/app.ts",
      reason: "Need focused implementation context",
      expectedLines: "banana",
      identifiersToFind: ["handler"],
    }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.some((entry) => entry.path === "$.expectedLines" && entry.code === "pattern"), true);
  });
});
