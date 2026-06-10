import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scrubSecrets } from "../lib/shared/telemetry/classes/logging/secret-scrub.js";

describe("telemetry secret scrubbing", () => {
  it("redacts provider API keys via SECRET_PATTERNS", () => {
    const out = scrubSecrets("calling with sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa done");
    assert.ok(!out.includes("sk-ant-api03"), `provider key leaked: ${out}`);
  });

  // Regression: the bridge domain redacts transport-shaped tokens but the
  // telemetry scrubber did not reuse those patterns, so OAuth bearer tokens,
  // JWTs, Google AIza keys, fine-grained GitHub PATs, and credentialed URLs
  // leaked into the file logs.
  it("redacts Bearer tokens", () => {
    const out = scrubSecrets("Authorization: Bearer abcDEF123456.token-value");
    assert.ok(!out.includes("abcDEF123456"), `bearer token leaked: ${out}`);
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = scrubSecrets(`token=${jwt}`);
    assert.ok(!out.includes(jwt), `jwt leaked: ${out}`);
  });

  it("redacts Google AIza API keys", () => {
    const out = scrubSecrets("using AIzaSyA1234567890abcdefghijk for maps");
    assert.ok(!out.includes("AIzaSyA1234567890abcdefghijk"), `google key leaked: ${out}`);
  });

  it("redacts fine-grained GitHub PATs", () => {
    const out = scrubSecrets("cloning with github_pat_11ABCDEFG0123456789_xyz");
    assert.ok(!out.includes("github_pat_11ABCDEFG0123456789"), `github pat leaked: ${out}`);
  });

  it("redacts URL userinfo credentials", () => {
    const out = scrubSecrets("fetch https://user:hunter2@internal.example.com/repo.git failed");
    assert.ok(!out.includes("hunter2"), `url credentials leaked: ${out}`);
    assert.ok(out.includes("internal.example.com"), `host should survive: ${out}`);
  });
});
