import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/check-control-protocol-drift.mjs");

function runDriftCheck(paths) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      POSSE_PROTOCOL_DOC_PATHS: paths.join(","),
    },
  });
}

function withTempDocs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-protocol-drift-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("control protocol drift checker", () => {
  it("normalizes BOM and line endings before comparing docs", () => withTempDocs((root) => {
    const a = path.join(root, "a.md");
    const b = path.join(root, "b.md");
    fs.writeFileSync(a, "# Protocol\n\nsame body\n", "utf8");
    fs.writeFileSync(b, "\uFEFF# Protocol\r\n\r\nsame body\r\n", "utf8");

    const result = runDriftCheck([a, b]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK/);
  }));

  it("fails when any configured doc target is missing", () => withTempDocs((root) => {
    const a = path.join(root, "a.md");
    const missing = path.join(root, "missing.md");
    fs.writeFileSync(a, "# Protocol\n", "utf8");

    const result = runDriftCheck([a, missing]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing protocol doc target/);
  }));

  it("fails when normalized doc contents drift", () => withTempDocs((root) => {
    const a = path.join(root, "a.md");
    const b = path.join(root, "b.md");
    fs.writeFileSync(a, "# Protocol\n\none\n", "utf8");
    fs.writeFileSync(b, "# Protocol\n\ntwo\n", "utf8");

    const result = runDriftCheck([a, b]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DRIFT/);
  }));
});
