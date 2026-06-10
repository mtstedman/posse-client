import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveNativeHeartbeatPublicKeyUrl,
  ensureNativeHeartbeatPublicKey,
  nativeHeartbeatUrlsFromSettings,
  parseNativeHeartbeatPublicKeyResponse,
} from "../scripts/native-heartbeat-public-key.mjs";

describe("native heartbeat public-key script", () => {
  it("derives public-key URLs from native heartbeat URLs", () => {
    assert.equal(
      deriveNativeHeartbeatPublicKeyUrl("https://auth.example.invalid/v1/native/heartbeat"),
      "https://auth.example.invalid/v1/native/public-key",
    );
  });

  it("defaults to shared native heartbeat routes", () => {
    assert.deepEqual(
      nativeHeartbeatUrlsFromSettings({ defaultRemoteUrl: "https://remote.example.invalid" }),
      {
        heartbeatUrl: "https://remote.example.invalid/v1/native/heartbeat",
        publicKeyUrl: "https://remote.example.invalid/v1/native/public-key",
        heartbeatUrlDerived: true,
      },
    );
  });

  it("fetches public keys for Git-only key-gated native selections", async () => {
    const settings = new Map();
    const writes = [];
    const fetched = [];
    const result = await ensureNativeHeartbeatPublicKey({
      selectedBinaries: ["git"],
      getSettingFn: (key) => settings.get(key) || "",
      setSettingFn: (key, value) => {
        settings.set(key, value);
        writes.push([key, value]);
      },
      fetchFn: async (url) => {
        fetched.push(url);
        return new Response(JSON.stringify({
          alg: "EdDSA",
          public_key: "public-key",
          public_key_sha256: "a".repeat(64),
          audience: "posse-native-binaries",
        }));
      },
      defaultRemoteUrl: "https://remote.example.invalid",
      logFn: () => {},
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(fetched, ["https://remote.example.invalid/v1/native/public-key"]);
    assert.deepEqual(writes, [
      ["posse_native_heartbeat_url", "https://remote.example.invalid/v1/native/heartbeat"],
      ["posse_native_heartbeat_jwt_public_key", "public-key"],
      ["posse_native_heartbeat_jwt_public_key_sha256", "a".repeat(64)],
      ["posse_native_heartbeat_jwt_audience", "posse-native-binaries"],
    ]);
  });

  it("parses JSON and raw public-key responses", () => {
    assert.deepEqual(parseNativeHeartbeatPublicKeyResponse("raw-key"), {
      publicKey: "raw-key",
      publicKeySha256: "",
      audience: "",
    });
    assert.deepEqual(parseNativeHeartbeatPublicKeyResponse(JSON.stringify({
      alg: "Ed25519",
      public_key: "json-key",
      public_key_sha256: "b".repeat(64),
      audience: "posse-native-binaries",
    })), {
      publicKey: "json-key",
      publicKeySha256: "b".repeat(64),
      audience: "posse-native-binaries",
    });
  });
});
