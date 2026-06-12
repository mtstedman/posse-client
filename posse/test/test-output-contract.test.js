import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isTransientCommitInfraFailure,
  validateDeclaredOutputContract,
} from "../lib/domains/worker/classes/Worker.js";

describe("declared output contract", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-output-contract-"));
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "Tests", "Media"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "app.js"), "export {};\n");
    fs.writeFileSync(path.join(tmpDir, "src", "other.js"), "export {};\n");
    fs.writeFileSync(path.join(tmpDir, "Tests", "Media", "UploadTest.php"), "<?php\n");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const devJob = { job_type: "dev" };

  it("treats files_to_modify as allowed scope: unmodified declared files do not fail", async () => {
    const result = await validateDeclaredOutputContract({
      job: devJob,
      payload: { files_to_modify: ["src/app.js", "src/other.js"] },
      filesCommitted: ["src/app.js"],
      cwd: tmpDir,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.untouchedModifies, []);
    assert.deepEqual(result.unmodifiedDeclaredScope, ["src/other.js"]);
  });

  it("fails when a must_modify path is left uncommitted", async () => {
    const result = await validateDeclaredOutputContract({
      job: devJob,
      payload: {
        files_to_modify: ["src/app.js", "Tests/Media/UploadTest.php"],
        must_modify: ["Tests/Media/UploadTest.php"],
      },
      filesCommitted: ["src/app.js"],
      cwd: tmpDir,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.untouchedModifies, ["Tests/Media/UploadTest.php"]);
    assert.deepEqual(result.unmodifiedDeclaredScope, []);
  });

  it("enforces must_modify even when not duplicated into files_to_modify", async () => {
    const untouched = await validateDeclaredOutputContract({
      job: devJob,
      payload: { must_modify: ["Tests/Media/UploadTest.php"] },
      filesCommitted: [],
      cwd: tmpDir,
    });
    assert.equal(untouched.ok, false);
    assert.deepEqual(untouched.untouchedModifies, ["Tests/Media/UploadTest.php"]);

    const committed = await validateDeclaredOutputContract({
      job: devJob,
      payload: { must_modify: ["Tests/Media/UploadTest.php"] },
      filesCommitted: ["Tests/Media/UploadTest.php"],
      cwd: tmpDir,
    });
    assert.equal(committed.ok, true);
  });

  it("preserves declared path casing in reported paths", async () => {
    const result = await validateDeclaredOutputContract({
      job: devJob,
      payload: {
        files_to_modify: ["src/app.js", "Tests/Media/UploadTest.php"],
      },
      filesCommitted: ["src/app.js"],
      cwd: tmpDir,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unmodifiedDeclaredScope, ["Tests/Media/UploadTest.php"]);
  });

  it("still fails when a declared create is missing or uncommitted", async () => {
    const missing = await validateDeclaredOutputContract({
      job: devJob,
      payload: { files_to_create: ["src/created.js"] },
      filesCommitted: [],
      cwd: tmpDir,
    });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missingCreates, ["src/created.js"]);

    fs.writeFileSync(path.join(tmpDir, "src", "created.js"), "export {};\n");
    const uncommitted = await validateDeclaredOutputContract({
      job: devJob,
      payload: { files_to_create: ["src/created.js"] },
      filesCommitted: [],
      cwd: tmpDir,
    });
    assert.equal(uncommitted.ok, false);
    assert.deepEqual(uncommitted.untouchedCreates, ["src/created.js"]);
  });

  it("matches must_modify case-insensitively on win32 while reporting declared casing", async () => {
    const result = await validateDeclaredOutputContract({
      job: devJob,
      payload: {
        files_to_modify: ["Tests/Media/UploadTest.php"],
        must_modify: ["tests/media/uploadtest.php"],
      },
      filesCommitted: [],
      cwd: tmpDir,
    });
    if (process.platform === "win32") {
      assert.equal(result.ok, false);
      assert.deepEqual(result.untouchedModifies, ["Tests/Media/UploadTest.php"]);
    } else {
      // Case-sensitive platforms treat the differently-cased must_modify
      // entry as a distinct declaration — still a hard requirement, so the
      // untouched lowercase path fails the contract under its own casing.
      assert.equal(result.ok, false);
      assert.deepEqual(result.untouchedModifies, ["tests/media/uploadtest.php"]);
      assert.deepEqual(result.unmodifiedDeclaredScope, ["Tests/Media/UploadTest.php"]);
    }
  });

  it("keeps honoring the explicit opt-outs", async () => {
    const result = await validateDeclaredOutputContract({
      job: devJob,
      payload: { files_to_modify: ["src/app.js"], declared_output_contract: false },
      filesCommitted: [],
      cwd: tmpDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  });
});

describe("transient commit infra classification", () => {
  it("classifies identity/heartbeat faults as transient", () => {
    assert.equal(isTransientCommitInfraFailure(new Error("posse_key heartbeat failed")), true);
    assert.equal(isTransientCommitInfraFailure({ message: "commit rejected", stderr: "pulse token renewal timed out" }), true);
    assert.equal(isTransientCommitInfraFailure({ message: "identity heartbeat expired" }), true);
  });

  it("never classifies scope, hook, or content failures as transient", () => {
    assert.equal(isTransientCommitInfraFailure(new Error("nothing to commit")), false);
    assert.equal(isTransientCommitInfraFailure({
      message: "posse_key heartbeat failed",
      hookOutput: "pre-commit lint failed",
    }), false);
    assert.equal(isTransientCommitInfraFailure({
      message: "posse_key heartbeat failed",
      createdOutOfScope: ["src/escape.js"],
    }), false);
    assert.equal(isTransientCommitInfraFailure({ message: "merge conflict in src/app.js" }), false);
  });
});
