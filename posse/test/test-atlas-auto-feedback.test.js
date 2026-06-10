import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAtlasAutoFeedbackCandidate,
  resolveAtlasAutoFeedbackMode,
} from "../lib/domains/integrations/functions/atlas-auto-feedback.js";
import { extractAtlasResultArtifacts } from "../lib/domains/atlas/functions/v2/signal-extraction.js";

describe("ATLAS auto feedback", () => {
  const symbolA = `${"a".repeat(64)}:1`;
  const symbolB = `${"b".repeat(64)}:2`;

  it("defaults to write and recognizes explicit modes", () => {
    assert.equal(resolveAtlasAutoFeedbackMode({}), "write");
    assert.equal(resolveAtlasAutoFeedbackMode({ autoFeedbackMode: "dry-run" }), "dry-run");
    assert.equal(resolveAtlasAutoFeedbackMode({ autoFeedbackMode: "write" }), "write");
    assert.equal(resolveAtlasAutoFeedbackMode({ autoFeedbackMode: "true" }), "write");
    assert.equal(resolveAtlasAutoFeedbackMode({ autoFeedbackMode: "off" }), "off");
  });

  it("builds useful-symbol feedback from ATLAS artifacts tied to touched files", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      {
        observation_type: "tool.atlas",
        detail: {
          kind: "atlas",
          ok: true,
          action: "slice.build",
          args: {},
          atlas_artifacts: {
            versionId: "v1",
            sliceHandle: "slice-1",
            symbols: [
              { symbolId: symbolA, filePath: "src/auth.ts" },
              { symbolId: symbolB, filePath: "src/other.ts" },
            ],
          },
        },
      },
      {
        observation_type: "tool.read",
        detail: { path: "src/auth.ts" },
      },
    ], {
      jobType: "dev",
      taskText: "Fix auth flow",
      outcome: "succeeded",
    });

    assert.equal(candidate.ok, true);
    assert.deepEqual(candidate.payload.usefulSymbols, [symbolA]);
    assert.equal(candidate.payload.taskType, "implement");
    assert.deepEqual(candidate.payload.taskTags, ["role:dev", "outcome:succeeded"]);
    assert.equal(candidate.payload.versionId, undefined);
    assert.equal(candidate.diagnostics.versionId, "v1");
    assert.equal(candidate.payload.sliceHandle, "slice-1");
  });

  it("uses direct evidence actions without requiring a touched file", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      {
        observation_type: "tool.atlas",
        detail: {
          kind: "atlas",
          ok: true,
          action: "atlas_code_get_hot_path",
          args: { symbolId: symbolA },
          atlas_artifacts: {
            versionId: "v1",
            sliceHandle: "slice-1",
            symbols: [{ symbolId: symbolA, filePath: "src/auth.ts" }],
          },
        },
      },
    ]);

    assert.equal(candidate.ok, true);
    assert.deepEqual(candidate.payload.usefulSymbols, [symbolA]);
  });

  it("reports no useful symbols before missing optional ATLAS metadata", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      {
        observation_type: "tool.read",
        detail: { path: "src/auth.ts" },
      },
    ]);

    assert.equal(candidate.ok, false);
    assert.equal(candidate.reason, "no_useful_symbols");
    assert.equal(candidate.diagnostics.atlasObservationCount, 0);
    assert.equal(candidate.diagnostics.versionId, null);
  });

  it("builds feedback with slice handle without sending a version", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      {
        observation_type: "tool.atlas",
        detail: {
          kind: "atlas",
          ok: true,
          action: "code.getHotPath",
          args: { symbolId: symbolA },
          atlas_artifacts: {
            sliceHandle: "slice-1",
            symbols: [{ symbolId: symbolA, filePath: "src/auth.ts" }],
          },
        },
      },
    ], {
      jobType: "fix",
      outcome: "succeeded",
    });

    assert.equal(candidate.ok, true);
    assert.equal(Object.hasOwn(candidate.payload, "versionId"), false);
    assert.equal(candidate.payload.sliceHandle, "slice-1");
    assert.deepEqual(candidate.payload.usefulSymbols, [symbolA]);
    assert.deepEqual(candidate.payload.taskTags, ["role:dev", "outcome:succeeded"]);
  });

  it("extracts version, slice handle, and symbol paths from v2 result envelopes", () => {
    const artifacts = extractAtlasResultArtifacts({
      ok: true,
      action: "slice.build",
      versionId: "main@42",
      data: {
        sliceHandle: "sl_42",
        cards: [{
          symbolId: symbolA,
          name: "run",
          location: { repo_rel_path: "src/workers/scraper.py", startLine: 1, endLine: 4 },
        }],
      },
    }, { action: "slice.build", args: {} });

    assert.equal(artifacts.versionId, "main@42");
    assert.equal(artifacts.sliceHandle, "sl_42");
    assert.deepEqual(artifacts.symbols, [{ symbolId: symbolA, filePath: "src/workers/scraper.py" }]);
  });

  it("ignores fabricated path-shaped symbol IDs", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      {
        observation_type: "tool.atlas",
        detail: {
          kind: "atlas",
          ok: true,
          action: "code.getHotPath",
          args: { symbolId: "src/auth.ts" },
          atlas_artifacts: {
            versionId: "v1",
            sliceHandle: "slice-1",
            symbols: [{ symbolId: "src/auth.ts", filePath: "src/auth.ts" }],
          },
        },
      },
    ]);

    assert.equal(candidate.ok, false);
    assert.equal(candidate.reason, "no_useful_symbols");
  });
});
