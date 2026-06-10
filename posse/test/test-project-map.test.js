import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureProjectMap,
  generateProjectMap,
  getCachedProjectMap,
} from "../lib/domains/project/functions/map.js";

function fakeGitHead(_cmd, _args, _opts) {
  return { status: 0, stdout: "abc123\n", stderr: "" };
}

describe("project map cache shape", () => {
  it("distinguishes top-level directories from files", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-project-map-shape-"));
    try {
      fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo\n", "utf8");

      const map = generateProjectMap(projectDir, { execImpl: fakeGitHead });

      assert.ok(map.top_level.includes("lib/"));
      assert.ok(map.top_level.includes("README.md"));
      assert.equal(map.top_level.includes("lib"), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("ignores malformed cached maps and regenerates them", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-project-map-cache-"));
    try {
      const cachePath = path.join(projectDir, ".posse", "project-map.json");
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ head_sha: "abc123" }), "utf8");

      assert.equal(getCachedProjectMap(projectDir), null);

      const map = ensureProjectMap(projectDir, { execImpl: fakeGitHead });
      assert.equal(map.head_sha, "abc123");
      assert.deepEqual(getCachedProjectMap(projectDir), map);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
