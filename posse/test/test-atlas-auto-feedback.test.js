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

  it("counts relevant chain verdicts as touched files and drops irrelevant ones", () => {
    const searchObservation = {
      observation_type: "tool.atlas",
      detail: {
        kind: "atlas",
        ok: true,
        action: "symbol.search",
        args: {},
        atlas_artifacts: {
          versionId: "v1",
          symbols: [
            { symbolId: symbolA, filePath: "src/auth.ts" },
            { symbolId: symbolB, filePath: "src/other.ts" },
          ],
        },
      },
    };
    const candidate = buildAtlasAutoFeedbackCandidate([
      searchObservation,
      { observation_type: "tool.chain_verdict", detail: { path: "src/auth.ts", verdict: "relevant" } },
      { observation_type: "tool.chain_read", detail: { path: "src/other.ts" } },
      { observation_type: "tool.chain_verdict", detail: { path: "src/other.ts", verdict: "irrelevant" } },
    ], {
      jobType: "research",
      outcome: "succeeded",
    });

    assert.equal(candidate.ok, true);
    assert.deepEqual(candidate.payload.usefulSymbols, [symbolA]);
  });

  it("merges resolver-provided extra symbols into the useful set", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      { observation_type: "tool.chain_verdict", detail: { path: "src/auth.ts", verdict: "relevant" } },
    ], {
      jobType: "research",
      outcome: "succeeded",
      extraUsefulSymbols: [symbolA, "not-a-symbol"],
    });

    assert.equal(candidate.ok, true);
    assert.deepEqual(candidate.payload.usefulSymbols, [symbolA]);
  });

  it("captures tree outputs (candidates, metrics) in result artifacts", () => {
    const envelope = JSON.stringify({
      ok: true,
      action: "tree.scope",
      versionId: "master@275",
      data: {
        available: true,
        candidateFiles: [
          { path: "src/auth.ts", score: 0.91, exactSeed: true },
          { path: "src/gen/routeTree.gen.ts", score: 0.4, generated: true },
        ],
        candidateDirs: [{ path: "src/flows", score: 0.8, fileCount: 12 }],
        metrics: { candidateFileCount: 2, scopeRisk: "low", confidence: 0.9 },
        warnings: [],
        refinementCandidates: [{ path: "src/x.ts" }],
      },
    });
    const artifacts = extractAtlasResultArtifacts(envelope, { action: "tree.scope", args: {} });
    assert.ok(artifacts);
    assert.equal(artifacts.versionId, "master@275");
    assert.equal(artifacts.tree.candidate_file_count, 2);
    assert.equal(artifacts.tree.candidate_files[0].path, "src/auth.ts");
    assert.equal(artifacts.tree.candidate_files[0].exact_seed, true);
    assert.equal(artifacts.tree.candidate_files[1].generated, true);
    assert.equal(artifacts.tree.candidate_dirs[0].file_count, 12);
    assert.equal(artifacts.tree.metrics.scopeRisk, "low");
    assert.equal(artifacts.tree.refinementCandidates_count, 1);
  });

  it("captures unavailable tree responses with their reason", () => {
    const envelope = JSON.stringify({
      ok: true,
      action: "tree.grow",
      versionId: "master@275",
      data: { available: false, reason: "tree_not_built" },
    });
    const artifacts = extractAtlasResultArtifacts(envelope, { action: "tree.grow", args: {} });
    assert.ok(artifacts);
    assert.equal(artifacts.tree.available, false);
    assert.equal(artifacts.tree.reason, "tree_not_built");
  });

  it("emits feedback without a slice handle (tree-first retrieval)", () => {
    const candidate = buildAtlasAutoFeedbackCandidate([
      {
        observation_type: "tool.atlas",
        detail: {
          kind: "atlas",
          ok: true,
          action: "symbol.getCard",
          args: { symbolId: symbolA },
          atlas_artifacts: {
            versionId: "master@275",
            symbols: [{ symbolId: symbolA, filePath: "src/auth.ts" }],
          },
        },
      },
    ], {
      jobType: "dev",
      taskText: "Fix auth flow",
      outcome: "succeeded",
    });

    assert.equal(candidate.ok, true);
    assert.deepEqual(candidate.payload.usefulSymbols, [symbolA]);
    assert.equal(Object.hasOwn(candidate.payload, "sliceHandle"), false);
    assert.equal(candidate.diagnostics.sliceHandle, null);
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
