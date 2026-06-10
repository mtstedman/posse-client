import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isProtectedMutablePath,
  validateMutableRepoPath,
} from "../lib/domains/runtime/functions/protected-paths.js";
import { filterFileRequestsToOutOfScope } from "../lib/domains/worker/classes/Worker.js";

describe("protected mutable paths", () => {
  it("blocks agent runtime and Posse-owned prompt contract paths from mutation scope", () => {
    assert.equal(isProtectedMutablePath(".git/config"), true);
    assert.equal(isProtectedMutablePath(".posse/logs/jobs.log"), true);
    assert.equal(isProtectedMutablePath(".posse-worktrees/wi-1/file.js"), true);
    assert.equal(isProtectedMutablePath(".posse-test-suites/area/suite.test.js"), true);
    assert.equal(isProtectedMutablePath("node_modules/pkg/index.js"), true);
    assert.equal(isProtectedMutablePath("prompts/contracts/file-scope.md"), true);
    assert.equal(isProtectedMutablePath("prompts/researcher.md"), true);
    assert.equal(isProtectedMutablePath("prompts/product-copy.md"), false);
    assert.equal(isProtectedMutablePath(".posse/resources/artifacts/wi-1/report.md"), false);
    assert.equal(validateMutableRepoPath("src/app.js", "files_to_modify"), null);
  });

  it("drops malformed, protected, and already-scoped file requests", () => {
    const kept = filterFileRequestsToOutOfScope([
      { path: "../outside.js" },
      { path: "prompts/contracts/file-scope.md" },
      { path: "src/already.js" },
      { path: "src/new.js" },
    ], {
      files_to_modify: ["src/already.js"],
    }, [], process.cwd());

    assert.deepEqual(kept.map((request) => request.path), ["src/new.js"]);
  });
});
