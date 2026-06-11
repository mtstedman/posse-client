import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { SETTING_KEYS } from "../lib/catalog/settings.js";
import {
  ensureBridgeInstanceId,
  ensureBridgeLocalToken,
  getBridgeConfig,
  getBridgePort,
  getBridgeRelayUrl,
  setBridgePort,
  setBridgeRelayToken,
  rotateBridgeLocalToken,
} from "../lib/domains/bridge/functions/auth.js";
import {
  getAccountRepoSetting,
  getAccountSetting,
  setAccountSetting,
} from "../lib/domains/settings/functions/account-settings.js";
import { getDefaultAccountSettings } from "../lib/domains/settings/classes/AccountSettings.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

function seedLegacyGlobalIdentity({ instanceId, relayToken, label = "", port = "" }) {
  // Bridge identity keys are repo-scoped in the catalog now, so legacy
  // account-level rows must be written directly (set() would delete them).
  const db = getDefaultAccountSettings().open();
  const upsert = db.prepare(
    `INSERT INTO account_settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
  );
  upsert.run(SETTING_KEYS.BRIDGE_INSTANCE_ID, instanceId);
  if (relayToken) upsert.run(SETTING_KEYS.BRIDGE_RELAY_TOKEN, relayToken);
  if (label) upsert.run(SETTING_KEYS.BRIDGE_LABEL, label);
  if (port) upsert.run(SETTING_KEYS.BRIDGE_PORT, port);
  getDefaultAccountSettings().invalidate();
}

describe("bridge auth settings", () => {
  it("stores local token globally and bridge identity per repo", () => withTempRuntimeDb((projectDir) => {
    const firstToken = ensureBridgeLocalToken();
    assert.ok(firstToken.length >= 32);
    assert.equal(ensureBridgeLocalToken(), firstToken);
    assert.equal(getAccountSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN), firstToken);

    const rotated = rotateBridgeLocalToken();
    assert.notEqual(rotated, firstToken);
    assert.equal(getAccountSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN), rotated);

    const instanceId = ensureBridgeInstanceId(projectDir);
    assert.match(instanceId, /^posse-/);
    assert.equal(ensureBridgeInstanceId(projectDir), instanceId);
    assert.equal(
      getAccountRepoSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID, projectDir),
      instanceId,
    );

    setBridgePort(7544, projectDir);
    setBridgeRelayToken("relay-token", projectDir);
    const config = getBridgeConfig(projectDir);
    assert.equal(config.port, 7544);
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.relayToken, "relay-token");
    assert.equal(config.relayUrl, "wss://app.yourposseai.com/v1/instance");
  }));

  it("gives each repo its own identity, token, and port", () => withTempRuntimeDb((projectDir) => {
    const repoA = path.join(projectDir, "repo-a");
    const repoB = path.join(projectDir, "repo-b");

    const idA = ensureBridgeInstanceId(repoA);
    const idB = ensureBridgeInstanceId(repoB);
    assert.notEqual(idA, idB);

    setBridgeRelayToken("token-a", repoA);
    setBridgeRelayToken("token-b", repoB);
    assert.equal(getBridgeConfig(repoA).relayToken, "token-a");
    assert.equal(getBridgeConfig(repoB).relayToken, "token-b");

    setBridgePort(7531, repoA);
    assert.equal(getBridgePort(repoA), 7531);
    assert.equal(getBridgePort(repoB), null, "unset repo port auto-picks at bind");
  }));

  it("first repo claims the legacy machine-global identity exactly once", () => withTempRuntimeDb((projectDir) => {
    const repoA = path.join(projectDir, "repo-a");
    const repoB = path.join(projectDir, "repo-b");
    seedLegacyGlobalIdentity({
      instanceId: "posse-legacy-1",
      relayToken: "legacy-relay-token",
      label: "Lappy Tappy",
      port: "7531",
    });

    // First repo inherits the legacy identity, so the machine's existing
    // relay pairing keeps working.
    const configA = getBridgeConfig(repoA);
    assert.equal(configA.instanceId, "posse-legacy-1");
    assert.equal(configA.relayToken, "legacy-relay-token");
    assert.equal(configA.label, "Lappy Tappy");
    assert.equal(configA.port, 7531);
    assert.equal(
      getAccountSetting(SETTING_KEYS.BRIDGE_IDENTITY_MIGRATED_TO),
      repoA,
    );

    // Second repo mints a fresh identity and must pair on its own.
    const configB = getBridgeConfig(repoB);
    assert.notEqual(configB.instanceId, "posse-legacy-1");
    assert.match(configB.instanceId, /^posse-/);
    assert.equal(configB.relayToken, "");
    assert.equal(configB.port, null);

    // Re-reading repo A keeps the claimed identity stable.
    assert.equal(getBridgeConfig(repoA).instanceId, "posse-legacy-1");
  }));

  it("rejects plaintext relay websocket URLs", () => withTempRuntimeDb(() => {
    setAccountSetting(SETTING_KEYS.BRIDGE_RELAY_URL, "ws://relay.example.test/v1/instance");

    assert.throws(
      () => getBridgeRelayUrl(),
      /bridge_relay_url must use wss:/,
    );
  }));
});
