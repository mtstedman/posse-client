import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyAtlasFailure } from "../lib/domains/integrations/functions/atlas-embedded.js";
import { shouldAtlasPrefetchUseDeterministicFallback } from "../lib/domains/handoff/functions/index.js";

describe("ATLAS failure classification", () => {
  it("does not report contract errors as backend outages", () => {
    assert.equal(
      classifyAtlasFailure("Invalid ATLAS parameters for slice.build: $.cardDetail must be one of: minimal, compact"),
      "ATLAS bad parameters",
    );
    assert.equal(shouldAtlasPrefetchUseDeterministicFallback("ATLAS bad parameters"), false);
  });

  it("separates view freshness and ledger mismatch from unavailable", () => {
    assert.equal(
      classifyAtlasFailure("View branch wi-108 is not present in ledger branch_heads"),
      "ATLAS view/ledger mismatch",
    );
    assert.equal(
      classifyAtlasFailure("ATLAS view is not current for branch wi-108"),
      "ATLAS view not current",
    );
    assert.equal(shouldAtlasPrefetchUseDeterministicFallback("ATLAS view/ledger mismatch"), true);
  });
});
