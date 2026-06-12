import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  __testAtlasExecCoalesceKey as coalesceKey,
  __testAtlasExecCoalesceEnabled as coalesceEnabled,
  __testAtlasSharedReadKey as sharedReadKey,
  __testAtlasSharedReadCacheSeed as sharedReadSeed,
  __testAtlasSharedReadCacheState as sharedReadState,
  __testResetAtlasJobCache as resetAtlasCaches,
  invalidateAtlasSharedReadCache,
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

describe("atlas shared read cache (tree.overview / repo.status)", () => {
  afterEach(() => resetAtlasCaches());

  const base = {
    enabled: true,
    action: "tree.overview",
    assetKey: "atlas:/repo/a",
    versionId: "head:abc123",
    payload: {},
  };

  it("keys only the shared-read actions, scoped to asset + version + args", () => {
    const k1 = sharedReadKey(base);
    const k2 = sharedReadKey({ ...base, payload: {} });
    assert.ok(k1, "expected a key for tree.overview");
    assert.equal(k1, k2, "same inputs → same key");
    assert.ok(sharedReadKey({ ...base, action: "repo.status" }), "repo.status is shared-cacheable");
    assert.notEqual(k1, sharedReadKey({ ...base, versionId: "head:def456" }), "different version → different key");
    assert.notEqual(k1, sharedReadKey({ ...base, assetKey: "atlas:/repo/b" }), "different asset → different key");
  });

  it("refuses non-shared actions, missing scope, and disabled coalescing", () => {
    assert.equal(sharedReadKey({ ...base, action: "slice.build" }), null);
    assert.equal(sharedReadKey({ ...base, action: "tree.scope" }), null);
    assert.equal(sharedReadKey({ ...base, assetKey: null }), null);
    assert.equal(sharedReadKey({ ...base, versionId: null }), null);
    assert.equal(sharedReadKey({ ...base, enabled: false }), null);
  });

  it("invalidation clears entries and bumps the epoch (post-reindex void)", () => {
    const key = sharedReadKey(base);
    sharedReadSeed(key, "{\"tree\":\"...\"}");
    const before = sharedReadState();
    assert.equal(before.size, 1);
    assert.ok(before.keys.includes(key));

    invalidateAtlasSharedReadCache();
    const after = sharedReadState();
    assert.equal(after.size, 0, "reindex success voids cached entries");
    assert.equal(after.epoch, before.epoch + 1, "epoch bump rejects in-flight promotions started pre-reindex");
  });
});
