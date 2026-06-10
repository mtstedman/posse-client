import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const orchestrator = path.join(repoRoot, "orchestrator.js");

describe("admin CLI", () => {
  it("aliases admin settings set to admin set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-cli-"));
    try {
      const setResult = runAdmin(["settings", "set", "scheduler_concurrency", "4"], tmp);
      assert.equal(setResult.status, 0, setResult.stderr || setResult.stdout);
      assert.match(setResult.stdout, /Updated scheduler_concurrency=4/);

      const getResult = runAdmin(["get", "scheduler_concurrency"], tmp);
      assert.equal(getResult.status, 0, getResult.stderr || getResult.stdout);
      assert.match(getResult.stdout, /scheduler_concurrency=4/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown admin settings sub-actions instead of dumping settings", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-cli-"));
    try {
      const result = runAdmin(["settings", "bogus"], tmp);
      assert.equal(result.status, 2);
      assert.match(result.stdout, /Unknown admin settings action/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to print hidden settings via admin get", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-cli-"));
    try {
      const setResult = runAdmin(["set", "bridge_local_token", "super-secret-token"], tmp);
      assert.equal(setResult.status, 0, setResult.stderr || setResult.stdout);
      assert.match(setResult.stdout, /bridge_local_token=\[hidden\]/);
      assert.doesNotMatch(setResult.stdout, /super-secret-token/);

      const getResult = runAdmin(["get", "bridge_local_token"], tmp);
      assert.equal(getResult.status, 2);
      assert.match(getResult.stdout, /Hidden setting/);
      assert.doesNotMatch(getResult.stdout, /super-secret-token/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects extra positional args for admin settings set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-cli-"));
    try {
      const result = runAdmin(["settings", "set", "scheduler_concurrency", "4", "extra"], tmp);
      assert.equal(result.status, 2);
      assert.match(result.stdout, /Unexpected extra argument/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function runAdmin(args, cwd) {
  return spawnSync(process.execPath, [orchestrator, "admin", ...args], {
    cwd,
    env: {
      ...process.env,
      POSSE_ACCOUNT_DB_PATH: path.join(cwd, "account.db"),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
}
