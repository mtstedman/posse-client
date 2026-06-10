import {
  assert,
  fs,
  it,
  os,
  path,
  runtimeModules,
  suite,
} from "../support/core-harness.js";
import { withTempRuntimeDb } from "../../helpers/regression-test-harness.js";
import { getDb } from "../../../lib/shared/storage/functions/index.js";
import {
  buildScopePredicates,
  createDeterministicToolkit,
  safePath,
} from "../../../lib/functions/toolkit/index.js";

function parseToolResult(text) {
  assert.doesNotMatch(String(text), /^Error:/);
  return JSON.parse(text);
}

suite("Registered test tools", () => {
  it("worker scratch GC only removes sentinel-owned project scratch dirs", () => {
    const {
      cleanupOldJobScratchDirs,
      jobScratchDirForJob,
      jobScratchRootForProject,
      writeJobScratchSentinel,
    } = runtimeModules.workerMod;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scratch-gc-"));
    try {
      const projectDir = path.join(tmpRoot, "project");
      const runtimeRoot = path.join(projectDir, ".posse");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const scratchRoot = jobScratchRootForProject({ tmpDir: tmpRoot, projectDir, runtimeRoot });

      const ownedExpired = jobScratchDirForJob(123, { tmpDir: tmpRoot, projectDir, runtimeRoot });
      fs.mkdirSync(ownedExpired, { recursive: true });
      writeJobScratchSentinel(ownedExpired, { projectDir, runtimeRoot });

      const activeExpired = jobScratchDirForJob(456, { tmpDir: tmpRoot, projectDir, runtimeRoot });
      fs.mkdirSync(activeExpired, { recursive: true });
      writeJobScratchSentinel(activeExpired, { projectDir, runtimeRoot });

      const unownedExpired = path.join(scratchRoot, "posse-job-789");
      fs.mkdirSync(unownedExpired, { recursive: true });
      const legacyGlobalMatch = path.join(tmpRoot, "posse-job-999");
      fs.mkdirSync(legacyGlobalMatch, { recursive: true });

      const old = new Date(Date.now() - 10_000);
      for (const dir of [ownedExpired, activeExpired, unownedExpired, legacyGlobalMatch]) {
        fs.utimesSync(dir, old, old);
      }

      const result = cleanupOldJobScratchDirs({
        tmpDir: tmpRoot,
        projectDir,
        runtimeRoot,
        retentionMs: 1,
        activeJobIds: [456],
        nowMs: Date.now() + 20_000,
      });

      assert.equal(result.removed, 1);
      assert.equal(fs.existsSync(ownedExpired), false);
      assert.equal(fs.existsSync(activeExpired), true);
      assert.equal(fs.existsSync(unownedExpired), true);
      assert.equal(fs.existsSync(legacyGlobalMatch), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("creates suites, rejects failing registrations, and runs registered tests", () => withTempRuntimeDb((projectDir) => {
    const toolkit = createDeterministicToolkit({ safePath, skipObservationLogging: true });
    const scope = buildScopePredicates(projectDir, {});

    const suiteResult = parseToolResult(toolkit.execCreateTestSuite({
      name: "Queue Lease Safety",
      explanation: "Checks focused lease and queue behavior while developing scheduler code.",
    }, projectDir, scope, {}, { role: "dev" }));

    assert.equal(suiteResult.ok, true);
    assert.equal(suiteResult.created, true);
    assert.equal(suiteResult.suite.slug, "queue-lease-safety");
    assert.equal(
      fs.existsSync(path.join(projectDir, ".posse-test-suites", "suites", "queue-lease-safety", "suite.json")),
      true,
    );

    const passingSource = `
      async ({ assert, fs, path, tmp, workspace, targetFiles, targetSymbols }) => {
        assert.equal(path.isAbsolute(workspace), true);
        assert.deepEqual(targetFiles, ["src/queue.js"]);
        assert.deepEqual(targetSymbols, ["leaseSafety"]);
        const scratch = path.join(tmp, "scratch.txt");
        fs.writeFileSync(scratch, "ok", "utf8");
        assert.equal(fs.readFileSync(scratch, "utf8"), "ok");
        return true;
      }
    `;

    const createTestResult = parseToolResult(toolkit.execCreateTest({
      suite_id: suiteResult.suite.id,
      name: "temp runner cleans scratch",
      explanation: "Proves the generated runner receives a tmp dir and can return true.",
      language: "javascript",
      target_files: ["src/queue.js"],
      target_symbols: ["leaseSafety"],
      test: passingSource,
    }, projectDir, scope, {}, { role: "dev" }));

    assert.equal(createTestResult.ok, true);
    assert.equal(createTestResult.registered, true);
    assert.equal(createTestResult.created, true);
    assert.equal(createTestResult.tmp_cleaned, true);
    assert.deepEqual(createTestResult.test.target_files, ["src/queue.js"]);
    assert.deepEqual(createTestResult.test.target_symbols, ["leaseSafety"]);
    assert.match(createTestResult.test.source_sha256, /^[a-f0-9]{64}$/);

    const rejected = parseToolResult(toolkit.execCreateTest({
      suite: "queue-lease-safety",
      name: "reject me",
      explanation: "This should not be persisted because it returns false.",
      language: "javascript",
      target_files: ["src/queue.js"],
      test: "async () => false",
    }, projectDir, scope, {}, { role: "dev" }));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.registered, false);
    assert.match(rejected.failure.message, /expected true/i);
    assert.equal(rejected.tmp_cleaned, true);

    const db = getDb();
    const tests = db.prepare(`SELECT name FROM posse_tests ORDER BY id`).all();
    assert.deepEqual(tests.map((row) => row.name), ["temp runner cleans scratch"]);

    const singleRun = parseToolResult(toolkit.execRunTest({
      test_id: createTestResult.test.id,
    }, projectDir, scope, {}, { role: "dev" }));

    assert.equal(singleRun.ok, true);
    assert.equal(singleRun.summary, "test passed");
    assert.equal(singleRun.tmp_cleaned, true);

    const suiteRun = parseToolResult(toolkit.execRunTestSuite({
      suite: "queue-lease-safety",
    }, projectDir, scope, {}, { role: "dev" }));

    assert.equal(suiteRun.ok, true);
    assert.equal(suiteRun.summary, "all 1 registered tests passed");
    assert.deepEqual(suiteRun.failures, []);
    assert.equal(suiteRun.tests[0].name, "temp runner cleans scratch");

    const runRows = db.prepare(`SELECT ok FROM posse_test_runs ORDER BY id`).all();
    assert.deepEqual(runRows.map((row) => row.ok), [1, 1, 1]);
  }));

  it("scrubs registered-test env and redacts failure output", () => withTempRuntimeDb((projectDir) => {
    const toolkit = createDeterministicToolkit({ safePath, skipObservationLogging: true });
    const scope = buildScopePredicates(projectDir, {});
    const secretKey = "POSSE_REGISTERED_TEST_SECRET_TOKEN";
    const secretValue = "registered-test-secret-value";
    const previousSecret = process.env[secretKey];
    process.env[secretKey] = secretValue;
    try {
      const suiteResult = parseToolResult(toolkit.execCreateTestSuite({
        name: "Secret Handling",
        explanation: "Checks registered-test child env and failure redaction.",
      }, projectDir, scope));

      const rejected = parseToolResult(toolkit.execCreateTest({
        suite_id: suiteResult.suite.id,
        name: "secret failure",
        explanation: "Fails while attempting to print inherited and literal secrets.",
        language: "javascript",
        target_files: ["src/secret.js"],
        test: `
          async () => {
            console.error("ENV_SECRET=" + (process.env.POSSE_REGISTERED_TEST_SECRET_TOKEN || "missing"));
            console.error('api_key="AAAAAAAAAAAAAAAAAAAAAAAAA"');
            return false;
          }
        `,
      }, projectDir, scope));

      assert.equal(rejected.ok, false);
      assert.equal(rejected.registered, false);
      assert.doesNotMatch(rejected.failure.message, new RegExp(secretValue));
      assert.doesNotMatch(rejected.failure.message, /api_key="AAAAAAAAAAAAAAAAAAAAAAAAA"/);
      assert.match(rejected.failure.message, /ENV_SECRET=missing/);
    } finally {
      if (previousSecret == null) delete process.env[secretKey];
      else process.env[secretKey] = previousSecret;
    }
  }));

  it("rejects and reverts registered tests that mutate workspace files", () => withTempRuntimeDb((projectDir) => {
    const toolkit = createDeterministicToolkit({ safePath, skipObservationLogging: true });
    const scope = buildScopePredicates(projectDir, {});
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src", "app.js"), "export const ok = true;\n", "utf8");

    const suiteResult = parseToolResult(toolkit.execCreateTestSuite({
      name: "Workspace Mutation Guard",
      explanation: "Rejects agent-authored tests that write outside their tmp dir.",
    }, projectDir, scope));

    const rejected = parseToolResult(toolkit.execCreateTest({
      suite_id: suiteResult.suite.id,
      name: "writes out of scope",
      explanation: "Attempts to create a workspace file while returning true.",
      language: "javascript",
      target_files: ["src/app.js"],
      test: `
        async ({ fs, path, workspace }) => {
          fs.writeFileSync(path.join(workspace, "out-of-scope.txt"), "leaked", "utf8");
          return true;
        }
      `,
    }, projectDir, scope, { modifyFiles: ["src/app.js"] }));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.registered, false);
    assert.equal(rejected.failure.workspace_mutation, true);
    assert.match(rejected.failure.message, /mutated workspace files/i);
    assert.equal(fs.existsSync(path.join(projectDir, "out-of-scope.txt")), false);

    const db = getDb();
    const tests = db.prepare(`SELECT name FROM posse_tests ORDER BY id`).all();
    assert.deepEqual(tests, []);
  }));

  it("runs only the requested suite and returns failure feedback", () => withTempRuntimeDb((projectDir) => {
    const toolkit = createDeterministicToolkit({ safePath, skipObservationLogging: true });
    const scope = buildScopePredicates(projectDir, {});

    const firstSuite = parseToolResult(toolkit.execCreateTestSuite({
      name: "Area One",
      explanation: "First isolated suite.",
    }, projectDir, scope));
    const secondSuite = parseToolResult(toolkit.execCreateTestSuite({
      name: "Area Two",
      explanation: "Second isolated suite.",
    }, projectDir, scope));

    parseToolResult(toolkit.execCreateTest({
      suite_id: firstSuite.suite.id,
      name: "first pass",
      explanation: "Passes and belongs only to the first suite.",
      language: "javascript",
      target_files: ["src/area-one.js"],
      test: "async () => true",
    }, projectDir, scope));
    parseToolResult(toolkit.execCreateTest({
      suite_id: secondSuite.suite.id,
      name: "second pass",
      explanation: "Passes and belongs only to the second suite.",
      language: "javascript",
      target_files: ["src/area-two.js"],
      test: "async () => true",
    }, projectDir, scope));

    const secondRun = parseToolResult(toolkit.execRunTestSuite({
      suite_id: secondSuite.suite.id,
    }, projectDir, scope));

    assert.equal(secondRun.ok, true);
    assert.equal(secondRun.tests.length, 1);
    assert.equal(secondRun.tests[0].name, "second pass");

    const missing = parseToolResult(toolkit.execRunTest({
      suite_id: secondSuite.suite.id,
      test: "first pass",
    }, projectDir, scope));

    assert.equal(missing.ok, false);
    assert.match(missing.failure.message, /Provide test_id/);
  }));

  it("records covered files, symbols, and import hints for scoped runs", () => withTempRuntimeDb((projectDir) => {
    const toolkit = createDeterministicToolkit({ safePath, skipObservationLogging: true });
    const scope = buildScopePredicates(projectDir, {});
    fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "lib", "math.mjs"), [
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      "",
    ].join("\n"));

    const suiteResult = parseToolResult(toolkit.execCreateTestSuite({
      name: "Math Surface",
      explanation: "Covers small math module behavior.",
    }, projectDir, scope));

    const createResult = parseToolResult(toolkit.execCreateTest({
      suite_id: suiteResult.suite.id,
      name: "add import helper",
      explanation: "Loads the covered module through the generated import helper.",
      language: "javascript",
      target_files: ["lib/math.mjs"],
      target_symbols: ["add"],
      target_imports: [{ path: "lib/math.mjs", symbols: ["add"] }],
      test: `
        async ({ assert, importTarget, targetFiles, targetSymbols, targetImports }) => {
          assert.deepEqual(targetFiles, ["lib/math.mjs"]);
          assert.deepEqual(targetSymbols, ["add"]);
          assert.deepEqual(targetImports, [{ path: "lib/math.mjs", symbols: ["add"] }]);
          const mod = await importTarget("lib/math.mjs");
          assert.equal(mod.add(2, 3), 5);
          return true;
        }
      `,
    }, projectDir, scope));

    assert.equal(createResult.ok, true);
    assert.deepEqual(createResult.test.target_files, ["lib/math.mjs"]);
    assert.deepEqual(createResult.test.target_symbols, ["add"]);
    assert.deepEqual(createResult.test.target_imports, [{ path: "lib/math.mjs", symbols: ["add"] }]);

    const inScopeRun = parseToolResult(toolkit.execRunTest({
      test_id: createResult.test.id,
    }, projectDir, scope, { modifyFiles: ["lib/math.mjs"] }));
    assert.equal(inScopeRun.ok, true);

    const outOfScopeRun = parseToolResult(toolkit.execRunTest({
      test_id: createResult.test.id,
    }, projectDir, scope, { modifyFiles: ["lib/other.mjs"] }));
    assert.equal(outOfScopeRun.ok, false);
    assert.match(outOfScopeRun.failure.message, /does not cover any file/i);
  }));
});
