// scripts/run-tests.mjs — npm test entry point.
//
// Runs core.test.js plus every handwritten root-level .test.js file.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POSSE_REMOTE_DEFAULT_URL } from "../lib/domains/remote/functions/mode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const TEST_DIR = path.join(ROOT, "test");

const files = ["test/core.test.js"];
for (const entry of fs.readdirSync(TEST_DIR).sort()) {
  if (!entry.endsWith(".test.js")) continue;
  if (entry === "core.test.js") continue;
  files.push(`test/${entry}`);
}

// Key-gated native methods require heartbeat auth on every call. Fetch the
// central public key once and expose it to every test process via env so all
// tests (and the orchestrator subprocesses they spawn) can authenticate the
// native binaries without each suite having to seed account settings. The env
// fallbacks are read by nativeHeartbeatAuthFromSettings. No-op without POSSE_KEY.
async function heartbeatEnv() {
  if (!String(process.env.POSSE_KEY || "").trim()) return {};
  const base = String(POSSE_REMOTE_DEFAULT_URL || "").trim().replace(/\/+$/, "");
  if (!base) return {};
  try {
    const response = await fetch(`${base}/v1/native/public-key`);
    if (!response.ok) return {};
    const body = await response.json();
    const publicKey = String(body.public_key || body.publicKey || "").trim();
    if (!publicKey) return {};
    return {
      POSSE_NATIVE_HEARTBEAT_URL: `${base}/v1/native/heartbeat`,
      POSSE_NATIVE_HEARTBEAT_JWT_PUBLIC_KEY: publicKey,
      POSSE_NATIVE_HEARTBEAT_JWT_PUBLIC_KEY_SHA256: String(body.public_key_sha256 || body.publicKeySha256 || "").trim(),
      POSSE_NATIVE_HEARTBEAT_JWT_AUDIENCE: String(body.audience || "").trim(),
    };
  } catch {
    return {};
  }
}

const hbEnv = await heartbeatEnv();
const args = ["--disable-warning=DEP0040", "--test", ...files];
const proc = spawn(process.execPath, args, {
  stdio: "inherit",
  cwd: ROOT,
  env: { ...process.env, ...hbEnv },
});
proc.on("exit", (code) => process.exit(code ?? 1));
