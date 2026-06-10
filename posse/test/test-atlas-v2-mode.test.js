import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeAtlasScipMode } from "../lib/domains/integrations/functions/atlas-v2-mode.js";

describe("atlas v2 mode normalization", () => {
  it("defaults missing and unknown SCIP modes to off", () => {
    assert.equal(normalizeAtlasScipMode(), "off");
    assert.equal(normalizeAtlasScipMode(""), "off");
    assert.equal(normalizeAtlasScipMode("not-a-mode"), "off");
  });

  it("preserves supported SCIP modes and the legacy consume alias", () => {
    assert.equal(normalizeAtlasScipMode("on"), "on");
    assert.equal(normalizeAtlasScipMode("on-demand"), "on-demand");
    assert.equal(normalizeAtlasScipMode("both"), "both");
    assert.equal(normalizeAtlasScipMode("consume"), "on");
  });
});
