import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyAtlasFailure, isTransientAtlasError } from "../lib/domains/integrations/functions/atlas-embedded.js";
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

  it("classifies self-resolving conditions as transient (retry, not fallback)", () => {
    assert.equal(isTransientAtlasError("Error: ATLAS tool symbol.search failed via atlas-v2: ATLAS v2 view is not current: view wi-137@1 is behind ledger head wi-137@23"), true);
    assert.equal(isTransientAtlasError("Error: ATLAS v2 view is not ready"), true);
    assert.equal(isTransientAtlasError("Error: database is locked"), true);
    assert.equal(isTransientAtlasError("Error: SQLITE_BUSY: database is locked"), true);
  });

  it("never treats hard failures or non-errors as transient", () => {
    assert.equal(isTransientAtlasError("Error: database disk image is malformed (corrupt)"), false);
    assert.equal(isTransientAtlasError("Error: ATLAS tool x skipped: ATLAS is disabled by configuration."), false);
    assert.equal(isTransientAtlasError("Error: ATLAS is disabled for this repository: boot_reindex_failed"), false);
    assert.equal(isTransientAtlasError("Error: Invalid ATLAS parameters for slice.build"), false);
    assert.equal(isTransientAtlasError("view is not current"), false, "non-Error output is a success payload");
  });
});
