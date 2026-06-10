// ATLAS v2 descriptor/retrieval contract harness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ATLAS_TOOL_ACTIONS } from "../lib/domains/atlas/functions/v2/contracts/tool-params.js";
import { ATLAS_TOOL_DEFS } from "../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import {
  collectRetrievalParityMetrics,
  createRetrievalParityFixture,
  destroyRetrievalParityFixture,
} from "./helpers/atlas-v2-parity-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RETRIEVAL_BASELINE = path.resolve(
  __dirname,
  "fixtures",
  "atlas-v2-parity",
  "retrieval-baseline.json",
);

const HIGH_IMPACT_PARITY_ACTIONS = Object.freeze([
  "repo.register",
  "repo.status",
  "index.refresh",
  "repo.overview",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "tree.overview",
  "symbol.search",
  "symbol.getCard",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "delta.get",
  "code.needWindow",
  "code.getSkeleton",
  "code.getHotPath",
  "pr.risk.analyze",
  "agent.feedback",
  "agent.feedback.query",
  "file.read",
  "memory.store",
  "memory.query",
  "memory.remove",
  "memory.surface",
  "policy.get",
  "policy.set",
  "usage.stats",
  "runtime.execute",
  "runtime.queryOutput",
  "scip.ingest",
]);

const NATIVE_OMITTED_OR_REPLACED_ACTIONS = Object.freeze({
  "file.write": "Use scoped write_file/edit_file; successful edits push ATLAS live buffers and follow the native refresh path.",
});

describe("ATLAS v2 descriptor parity", () => {
  it("registers every high-impact parity action in Posse contracts and descriptors", () => {
    for (const action of HIGH_IMPACT_PARITY_ACTIONS) {
      assert.ok(ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (action)), `${action} missing from ATLAS_TOOL_ACTIONS`);
      assert.ok(ATLAS_TOOL_DEFS[action], `${action} missing from ATLAS_TOOL_DEFS`);
      assert.equal(ATLAS_TOOL_DEFS[action].name.startsWith("atlas_"), true, `${action} has no provider-safe name`);
      assert.equal(ATLAS_TOOL_DEFS[action].parameters?.additionalProperties, false, `${action} schema is not strict`);
    }
  });

  it("keeps replaced/deferred actions out of the native v2 action list", () => {
    for (const action of Object.keys(NATIVE_OMITTED_OR_REPLACED_ACTIONS)) {
      assert.equal(ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (action)), false, `${action} must not be exposed as native v2`);
    }
  });
});

describe("ATLAS v2 retrieval parity baseline", () => {
  it("captures current high-impact retrieval metrics for skeleton, hotpath, and slice", () => {
    const fixture = createRetrievalParityFixture();
    try {
      const actual = collectRetrievalParityMetrics(fixture);
      const expected = JSON.parse(fs.readFileSync(RETRIEVAL_BASELINE, "utf8"));
      assert.deepEqual(actual, expected);
    } finally {
      destroyRetrievalParityFixture(fixture);
    }
  });

  it("keeps the fixed retrieval parity behaviors explicit", () => {
    const expected = JSON.parse(fs.readFileSync(RETRIEVAL_BASELINE, "utf8"));
    assert.equal(expected.skeleton.hasBodyElisionMarker, true, "baseline should show skeleton is AST-elided");
    assert.equal(expected.skeleton.identifiersFilterHonored, true, "baseline should show identifiersToFind is honored");
    assert.deepEqual(expected.hotPath.falsePositiveIdentifiers, []);
    assert.equal(expected.slice.hasFrontier, true, "baseline should show slice.build exposes a frontier");
    assert.equal(expected.slice.includesLowConfidenceInTotal, false, "baseline should show default minConfidence filters weak edges");
  });
});
