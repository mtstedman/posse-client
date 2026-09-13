import assert from "node:assert/strict";
import { test } from "node:test";

import { SETTING_KEYS } from "../lib/catalog/settings.js";
import { applyIntakeRoutingMode } from "../lib/domains/research/functions/routing.js";
import { getCatalogEntry, validateCatalogSettingValue } from "../lib/domains/settings/functions/catalog.js";

test("research-first intake replaces preflight and direct-plan candidates", () => {
  for (const bucket of ["preplan", "ambiguous", "no_research", "oneshot_candidate"]) {
    const original = { bucket, reason: "classifier reason", budget: "high" };
    const routed = applyIntakeRoutingMode(original, "research_first");
    assert.equal(routed.bucket, "solo");
    assert.equal(routed.budget, "high");
    assert.match(routed.reason, /Research-first intake/);
    assert.equal(original.bucket, bucket);
    assert.equal(applyIntakeRoutingMode(original, "auto"), original);
  }
});

test("research-first intake preserves specialized and existing research routes", () => {
  for (const bucket of ["oneshot", "web_only_answer", "solo", "fanout_clear"]) {
    const routing = { bucket, reason: "existing route" };
    assert.equal(applyIntakeRoutingMode(routing, "research_first"), routing);
  }
});

test("intake routing setting is a validated repository option", () => {
  const entry = getCatalogEntry(SETTING_KEYS.INTAKE_ROUTING_MODE);
  assert.equal(entry.scope, "repo");
  assert.equal(entry.default, "auto");
  assert.equal(validateCatalogSettingValue(entry.key, "research_first").ok, true);
  assert.equal(validateCatalogSettingValue(entry.key, "invalid").ok, false);
});
