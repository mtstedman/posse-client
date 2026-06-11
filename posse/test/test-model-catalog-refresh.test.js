// Model catalog refresh flow: fetch via an injected fake client, persistence
// to a temp account DB, TTL gating, failure backoff, and the rule that a
// malformed fetch never clobbers the previously persisted catalog.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
  __resetModelCatalogRefreshForTests,
  maybeRefreshModelCatalog,
  refreshRemoteModelCatalog,
} from "../lib/domains/remote/functions/model-catalog-refresh.js";
import {
  __resetRemoteModelCatalogStoreForTests,
  ensureRemoteCatalogLoaded,
  getRemoteCatalog,
} from "../lib/domains/providers/functions/model-catalog-store.js";
import { __resetModelCatalogValidationForTests } from "../lib/domains/providers/functions/model-catalog-validate.js";
import {
  getAccountSetting,
  setAccountSetting,
  setAccountSettingsDbPathForTests,
} from "../lib/domains/settings/functions/account-settings.js";

function rawCatalog(version = "2026.06.11-test") {
  return {
    schema_version: 1,
    catalog_version: version,
    generated_at: "2026-06-11T00:00:00Z",
    providers: {
      claude: {
        tier_defaults: {},
        text_models: [{ id: "claude-fable-5", tier: "strong", pricing: { input_per_million_usd: 10, output_per_million_usd: 50 } }],
        image_models: [],
        listing: { source: "anthropic", checked_at: null, live: false },
      },
    },
  };
}

function fakeClient(payloadOrError) {
  let calls = 0;
  return {
    calls: () => calls,
    getModelCatalog: async () => {
      calls += 1;
      if (payloadOrError instanceof Error) throw payloadOrError;
      return typeof payloadOrError === "function" ? payloadOrError() : payloadOrError;
    },
  };
}

describe("model catalog refresh", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-catalog-refresh-"));
    setAccountSettingsDbPathForTests(path.join(tmpDir, "account.db"));
    __resetRemoteModelCatalogStoreForTests();
    __resetModelCatalogRefreshForTests();
    __resetModelCatalogValidationForTests();
  });

  after(() => {
    setAccountSettingsDbPathForTests(null);
    __resetRemoteModelCatalogStoreForTests();
    __resetModelCatalogRefreshForTests();
    __resetModelCatalogValidationForTests();
  });

  it("fetches, installs, and persists a catalog; reload survives invalidation", async () => {
    const client = fakeClient(rawCatalog());
    const result = await refreshRemoteModelCatalog({ client });
    assert.equal(result.ok, true);
    assert.equal(result.catalogVersion, "2026.06.11-test");
    assert.ok(getAccountSetting("model_catalog_json").includes("claude-fable-5"));
    assert.ok(getAccountSetting("model_catalog_fetched_at"));

    __resetRemoteModelCatalogStoreForTests();
    const reloaded = await ensureRemoteCatalogLoaded();
    assert.equal(reloaded?.catalogVersion, "2026.06.11-test");
  });

  it("keeps the previous catalog when a fetch fails or is malformed", async () => {
    await refreshRemoteModelCatalog({ client: fakeClient(rawCatalog("v1")) });
    const persistedBefore = getAccountSetting("model_catalog_json");

    const failed = await refreshRemoteModelCatalog({ client: fakeClient(new Error("boom")) });
    assert.equal(failed.ok, false);
    assert.equal(failed.catalogVersion, "v1", "in-memory catalog survives a failed fetch");

    const malformed = await refreshRemoteModelCatalog({ client: fakeClient({ schema_version: 99 }) });
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /malformed or unsupported/);
    assert.equal(getAccountSetting("model_catalog_json"), persistedBefore);
    assert.equal(getRemoteCatalog()?.catalogVersion, "v1");
  });

  it("TTL-gates refreshes and honors force", async () => {
    const client = fakeClient(rawCatalog());
    const first = await maybeRefreshModelCatalog({ client, force: true });
    assert.equal(first.attempted, true);
    assert.equal(first.ok, true);
    assert.equal(client.calls(), 1);

    // Within the TTL the gate skips without touching the client.
    const second = await maybeRefreshModelCatalog({ client });
    assert.deepEqual(second, { attempted: false, skipped: "fresh" });
    assert.equal(client.calls(), 1);

    // Expire the timestamp → the next gate attempt fetches again.
    setAccountSetting("model_catalog_fetched_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString());
    const third = await maybeRefreshModelCatalog({ client, nowMs: Date.now() + 120_000 });
    assert.equal(third.attempted, true);
    assert.equal(client.calls(), 2);
  });

  it("backs off after a failed attempt instead of retrying every tick", async () => {
    const failing = fakeClient(new Error("remote down"));
    const first = await maybeRefreshModelCatalog({ client: failing, force: true });
    assert.equal(first.attempted, true);
    assert.equal(first.ok, false);
    assert.equal(failing.calls(), 1);

    const second = await maybeRefreshModelCatalog({ client: failing });
    assert.deepEqual(second, { attempted: false, skipped: "backoff" });
    assert.equal(failing.calls(), 1);

    // After the backoff window the gate allows another attempt.
    const third = await maybeRefreshModelCatalog({ client: failing, nowMs: Date.now() + 16 * 60 * 1000 });
    assert.equal(third.attempted, true);
    assert.equal(failing.calls(), 2);
  });

  it("skips persistence when the catalog version is unchanged", async () => {
    await refreshRemoteModelCatalog({ client: fakeClient(rawCatalog("stable")) });
    const firstFetchedAt = getAccountSetting("model_catalog_fetched_at");
    const jsonBefore = getAccountSetting("model_catalog_json");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await refreshRemoteModelCatalog({ client: fakeClient(rawCatalog("stable")) });
    assert.equal(again.ok, true);
    assert.equal(getAccountSetting("model_catalog_json"), jsonBefore);
    assert.notEqual(getAccountSetting("model_catalog_fetched_at"), firstFetchedAt, "freshness timestamp still advances");
  });
});
