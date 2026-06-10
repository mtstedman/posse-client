import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SETTING_KEYS } from "../lib/catalog/settings.js";
import { runPairCommand, runServeCommand } from "../lib/domains/cli/functions/commands/serve.js";
import {
  closeAccountSettingsDb,
  getAccountSetting,
  setAccountSettingsDbPathForTests,
} from "../lib/domains/settings/functions/account-settings.js";

const originalFetch = globalThis.fetch;
const C = new Proxy({}, { get: () => "" });

describe("posse serve --pair", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeAccountSettingsDb();
    setAccountSettingsDbPathForTests(null);
  });

  it("retries pending confirmation with the same code without minting a new QR token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-serve-pair-"));
    setAccountSettingsDbPathForTests(path.join(tmp, "account.db"));
    const calls = [];
    const promptCodes = ["ABCD"];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(url).endsWith("/start")) {
        return jsonResponse(200, {
          qr_token: "qr-token-1",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (calls.filter((call) => call.url.endsWith("/confirm")).length === 1) {
        return jsonResponse(409, { error: { code: "confirmation_pending" } });
      }
      return jsonResponse(200, {
        bridge_token: "bridge-token-1",
        instance: { id: "inst-1", label: "Fixture" },
      });
    };

    try {
      const { result } = await captureConsole(() => runPairCommand(
        { relayUrl: "wss://relay.example.test/proxy/v1/instance", label: "Fixture" },
        { C, promptCode: async () => promptCodes.shift(), retryDelayMs: 0 },
      ));

      assert.equal(result.ok, true);
      assert.equal(getAccountSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN), "bridge-token-1");
      assert.deepEqual(
        calls.map((call) => new URL(call.url).pathname),
        [
          "/proxy/v1/bridge-pair/start",
          "/proxy/v1/bridge-pair/confirm",
          "/proxy/v1/bridge-pair/confirm",
        ],
      );
      const confirmBodies = calls
        .filter((call) => call.url.endsWith("/confirm"))
        .map((call) => call.body);
      assert.deepEqual(confirmBodies.map((body) => body.qr_token), ["qr-token-1", "qr-token-1"]);
      assert.deepEqual(confirmBodies.map((body) => body.confirmation_code), ["ABCD", "ABCD"]);
    } finally {
      closeAccountSettingsDb();
      setAccountSettingsDbPathForTests(null);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-prompts mismatched confirmation codes without minting a new QR token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-serve-pair-mismatch-"));
    setAccountSettingsDbPathForTests(path.join(tmp, "account.db"));
    const calls = [];
    const promptCodes = ["ABCD", "EFGH"];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(url).endsWith("/start")) {
        return jsonResponse(200, {
          qr_token: "qr-token-1",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (calls.filter((call) => call.url.endsWith("/confirm")).length === 1) {
        return jsonResponse(409, { error: { code: "confirmation_mismatch" } });
      }
      return jsonResponse(200, {
        bridge_token: "bridge-token-1",
        instance: { id: "inst-1", label: "Fixture" },
      });
    };

    try {
      const { result } = await captureConsole(() => runPairCommand(
        { relayUrl: "wss://relay.example.test/proxy/v1/instance", label: "Fixture" },
        { C, promptCode: async () => promptCodes.shift(), retryDelayMs: 0 },
      ));

      assert.equal(result.ok, true);
      assert.equal(getAccountSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN), "bridge-token-1");
      assert.deepEqual(
        calls.map((call) => new URL(call.url).pathname),
        [
          "/proxy/v1/bridge-pair/start",
          "/proxy/v1/bridge-pair/confirm",
          "/proxy/v1/bridge-pair/confirm",
        ],
      );
      const confirmBodies = calls
        .filter((call) => call.url.endsWith("/confirm"))
        .map((call) => call.body);
      assert.deepEqual(confirmBodies.map((body) => body.qr_token), ["qr-token-1", "qr-token-1"]);
      assert.deepEqual(confirmBodies.map((body) => body.confirmation_code), ["ABCD", "EFGH"]);
    } finally {
      closeAccountSettingsDb();
      setAccountSettingsDbPathForTests(null);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an invalid scripted confirmation code before calling confirm", async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse(200, {
        qr_token: "qr-token-2",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    };

    const { result } = await captureConsole(() => runPairCommand(
      { relayUrl: "wss://relay.example.test/v1/instance", label: "Fixture" },
      { C, argv: ["--confirmation-code", "O0I1"] },
    ));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_confirmation_code");
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/bridge-pair/start"]);
  });

  it("maps qr_token_already_used to a friendly pair failure", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/start")) {
        return jsonResponse(200, {
          qr_token: "qr-token-3",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return jsonResponse(409, { error: { code: "qr_token_already_used" } });
    };

    const { result, lines } = await captureConsole(() => runPairCommand(
      { relayUrl: "wss://relay.example.test/v1/instance", label: "Fixture" },
      { C, argv: ["--confirmation-code", "ABCD"] },
    ));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "qr_token_already_used");
    assert.ok(lines.some((line) => line.includes("Another phone already used this QR")));
  });

  it("does not print the bridge bearer in the normal serve banner", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-serve-token-banner-"));
    setAccountSettingsDbPathForTests(path.join(tmp, "account.db"));
    class FakeBridge {
      async start() {
        return {
          url: "http://127.0.0.1:7531",
          instanceId: "posse-test",
          label: "Fixture",
          token: "secret-bridge-token",
          relayEnabled: false,
        };
      }
    }

    try {
      const { result, lines } = await captureConsole(() => runServeCommand([], {
        projectDir: tmp,
        C,
        wait: false,
        BridgeClass: FakeBridge,
      }));

      assert.equal(result.ok, true);
      assert.equal(lines.join("\n").includes("secret-bridge-token"), false);
      assert.ok(lines.some((line) => line.includes("hidden (use --show-token or --show-lan-token)")));
    } finally {
      closeAccountSettingsDb();
      setAccountSettingsDbPathForTests(null);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

async function captureConsole(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = originalLog;
  }
}
