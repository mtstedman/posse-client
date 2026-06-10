import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  __testAtlasExecCoalesceKey as coalesceKey,
  __testAtlasExecCoalesceEnabled as coalesceEnabled,
} from "../lib/domains/integrations/functions/atlas-embedded.js";

const base = {
  enabled: true,
  action: "slice.build",
  assetKey: "atlas:/repo/a",
  versionId: "main@42",
  payload: { editedFiles: ["a.js"], maxCards: 8 },
};

describe("atlas embedded coalesce-key eligibility", () => {
  it("builds a stable key for cacheable read actions with repo + version", () => {
    const k1 = coalesceKey(base);
    const k2 = coalesceKey({ ...base, payload: { editedFiles: ["a.js"], maxCards: 8 } });
    assert.ok(k1, "expected a key");
    assert.equal(k1, k2, "same inputs → same key");
    assert.ok(k1.includes("atlas:/repo/a"));
    assert.ok(k1.includes("main@42"));
    assert.ok(k1.includes("slice.build"));
  });

  it("changes the key when args, version, or repo differ (no cross-state sharing)", () => {
    const k = coalesceKey(base);
    assert.notEqual(k, coalesceKey({ ...base, payload: { editedFiles: ["b.js"], maxCards: 8 } }), "different args");
    assert.notEqual(k, coalesceKey({ ...base, versionId: "main@43" }), "different version");
    assert.notEqual(k, coalesceKey({ ...base, assetKey: "atlas:/repo/b" }), "different repo");
  });

  it("refuses to coalesce non-cacheable / write actions", () => {
    assert.equal(coalesceKey({ ...base, action: "index.refresh" }), null);
    assert.equal(coalesceKey({ ...base, action: "edit.plan" }), null);
    assert.equal(coalesceKey({ ...base, action: "memory.store" }), null);
  });

  it("refuses to coalesce without a repo asset key or a version", () => {
    assert.equal(coalesceKey({ ...base, assetKey: null }), null);
    assert.equal(coalesceKey({ ...base, versionId: null }), null);
  });

  it("returns null when disabled", () => {
    assert.equal(coalesceKey({ ...base, enabled: false }), null);
  });
});

describe("atlas embedded coalesce enable flag", () => {
  const original = process.env.POSSE_ATLAS_EMBEDDED_COALESCE;
  afterEach(() => {
    if (original === undefined) delete process.env.POSSE_ATLAS_EMBEDDED_COALESCE;
    else process.env.POSSE_ATLAS_EMBEDDED_COALESCE = original;
  });

  it("defaults on", () => {
    delete process.env.POSSE_ATLAS_EMBEDDED_COALESCE;
    assert.equal(coalesceEnabled({}), true);
  });

  it("honors the env off-switch", () => {
    for (const off of ["off", "false", "0", "no"]) {
      process.env.POSSE_ATLAS_EMBEDDED_COALESCE = off;
      assert.equal(coalesceEnabled({}), false, `expected disabled for "${off}"`);
    }
  });

  it("honors an explicit config disable", () => {
    delete process.env.POSSE_ATLAS_EMBEDDED_COALESCE;
    assert.equal(coalesceEnabled({ embeddedCoalesceEnabled: false }), false);
  });
});
