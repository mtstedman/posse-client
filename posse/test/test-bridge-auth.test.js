import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SETTING_KEYS } from "../lib/catalog/settings.js";
import {
  ensureBridgeInstanceId,
  ensureBridgeLocalToken,
  getBridgeConfig,
  getBridgeRelayUrl,
  setBridgeRelayToken,
  rotateBridgeLocalToken,
} from "../lib/domains/bridge/functions/auth.js";
import { getAccountSetting, setAccountSetting } from "../lib/domains/settings/functions/account-settings.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

describe("bridge auth settings", () => {
  it("stores local bridge token and instance id in account settings", () => withTempRuntimeDb((projectDir) => {
    const firstToken = ensureBridgeLocalToken();
    assert.ok(firstToken.length >= 32);
    assert.equal(ensureBridgeLocalToken(), firstToken);
    assert.equal(getAccountSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN), firstToken);

    const rotated = rotateBridgeLocalToken();
    assert.notEqual(rotated, firstToken);
    assert.equal(getAccountSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN), rotated);

    const instanceId = ensureBridgeInstanceId();
    assert.match(instanceId, /^posse-/);
    assert.equal(ensureBridgeInstanceId(), instanceId);

    setAccountSetting(SETTING_KEYS.BRIDGE_PORT, "7544");
    setBridgeRelayToken("relay-token");
    const config = getBridgeConfig(projectDir);
    assert.equal(config.port, 7544);
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.relayToken, "relay-token");
    assert.equal(config.relayUrl, "wss://app.yourposseai.com/v1/instance");
  }));

  it("rejects plaintext relay websocket URLs", () => withTempRuntimeDb(() => {
    setAccountSetting(SETTING_KEYS.BRIDGE_RELAY_URL, "ws://relay.example.test/v1/instance");

    assert.throws(
      () => getBridgeRelayUrl(),
      /bridge_relay_url must use wss:/,
    );
  }));
});
