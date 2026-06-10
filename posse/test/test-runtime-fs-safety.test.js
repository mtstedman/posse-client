import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isInsideRoot,
  resolvePathWithin,
} from "../lib/domains/runtime/functions/fs-safety.js";
import {
  resolvePathWithin as resolveScopedPathWithin,
} from "../lib/domains/worker/functions/helpers/scope.js";

describe("runtime fs safety helpers", () => {
  it("checks root containment with equal-path control", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fs-root-"));
    try {
      const child = path.join(root, "nested", "file.txt");
      const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);

      assert.equal(isInsideRoot(child, root), true);
      assert.equal(isInsideRoot(root, root), true);
      assert.equal(isInsideRoot(root, root, { allowEqual: false }), false);
      assert.equal(isInsideRoot(outside, root), false);
      assert.equal(resolvePathWithin(root, "nested/file.txt"), child);
      assert.equal(resolvePathWithin(root, "../escape.txt"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks symlink escapes, including missing children below the link", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fs-symlink-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fs-symlink-outside-"));
    try {
      fs.mkdirSync(path.join(root, "safe"), { recursive: true });
      const linkPath = path.join(root, "link");
      try {
        fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        t.skip(`symlink creation unavailable: ${err?.message || err}`);
        return;
      }

      const escapedExisting = path.join(linkPath, "secret.txt");
      const escapedMissing = path.join(linkPath, "new-file.txt");
      fs.writeFileSync(path.join(outside, "secret.txt"), "nope\n", "utf-8");

      assert.equal(isInsideRoot(escapedExisting, root), false);
      assert.equal(isInsideRoot(escapedMissing, root), false);
      assert.equal(isInsideRoot(escapedMissing, root, { followSymlinks: false }), true);
      assert.equal(resolvePathWithin(root, "link/new-file.txt"), null);
      assert.equal(resolveScopedPathWithin(root, "link/new-file.txt"), null);
      assert.equal(resolvePathWithin(root, "safe/new-file.txt"), path.join(root, "safe", "new-file.txt"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
