import {
  it,
  before,
  assert,
  execFileSync,
  fs,
  __dirname,
  path,
  suite,
} from "../support/core-harness.js";
import { withTempRuntimeDb } from "../../helpers/regression-test-harness.js";
import { getDb } from "../../../lib/shared/storage/functions/index.js";
import {
  createRegisteredTest,
  createRegisteredTestSuite,
} from "../../../lib/functions/toolkit/registered-tests.js";

suite("Assessor helpers", () => {
  it("kills timed shell verification commands as a process tree on Windows", async () => {
    const assessor = await import("../../../lib/domains/worker/functions/helpers/assessment-pipeline.js");
    let taskkillCall = null;
    let directKillCalled = false;
    const result = assessor.__testKillShellCommandProcessTree({
      pid: 4321,
      kill() {
        directKillCalled = true;
        return true;
      },
    }, {
      platform: "win32",
      spawnSyncImpl(command, args, opts) {
        taskkillCall = { command, args, opts };
        return { status: 0 };
      },
    });

    assert.equal(result, true);
    assert.equal(directKillCalled, false);
    assert.equal(taskkillCall.command, "taskkill");
    assert.deepEqual(taskkillCall.args, ["/pid", "4321", "/T", "/F"]);
    assert.equal(taskkillCall.opts.windowsHide, true);
  });

  it("passes assessment scope through for Codex read-only verification", async () => {
    const assessor = await import("../../../lib/domains/worker/classes/roles/assessor.js");
    const scope = assessor.__testBuildAssessmentProviderScope({
      cwd: "C:\\repo\\worktree",
      assessmentContext: {
        allowed_files: ["src/app.js"],
        allowed_create_files: ["docs/report.md"],
        allowed_create_roots: ["docs/generated"],
        files_committed: ["src/app.js", "src/utils.js"],
        files_reverted: ["tmp/out-of-scope.js"],
        output_root: "artifacts/out",
        manifest: {
          files: [
            { path: "dist/index.html" },
            { path: "dist/app.css" },
          ],
        },
      },
    });

    assert.deepEqual(scope.scopedFiles, [
      "src/app.js",
      "src/utils.js",
      "tmp/out-of-scope.js",
      "dist/index.html",
      "dist/app.css",
    ]);
    assert.deepEqual(scope.createFiles, [
      "docs/report.md",
      "dist/index.html",
      "dist/app.css",
    ]);
    assert.deepEqual(scope.createRoots, [
      "docs/generated",
      "artifacts/out",
    ]);
  });

  it("detects bogus assessor prompts asking humans to provide file contents or read access", async () => {
    const assessor = await import("../../../lib/domains/worker/classes/roles/assessor.js");

    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Context: I could not verify the actual committed files because file-system access is blocked in this environment."
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Do you want me to re-run the verification once you provide the file contents or enable read access?"
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Context: Cannot verify the claimed additions of keyboard navigation states or animations for the mobile navbar toggle in htdocs/style.css due to fallback read budget"
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Can the full diffs or content of the modifications to htdocs/style.css and the four HTML files be provided to verify the addition?"
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Is there a way to extend content read limits or provide the exact lines where the new animation keyframes, CSS focus-visible rules, and keyboard event handlers were added?"
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Verdict: pass"
      ),
      false
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "Assessment was blocked because file-tool reads were canceled in this environment."
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "repo-read tool calls were canceled before verification completed."
      ),
      true
    );
    assert.equal(
      assessor.__testLooksLikeAssessorAccessLimitation(
        "deterministic reads were canceled by the runtime guard."
      ),
      true
    );
  });

  it("treats create_roots dot as in-scope for committed files", async () => {
    const assessor = await import("../../../lib/domains/worker/classes/roles/assessor.js");
    const outOfScope = assessor.__testFindOutOfScopeCommittedFiles(
      ["index.html", "pages/events/spring.html"],
      {
        allowedFiles: [],
        allowedCreateFiles: [],
        allowedDeleteFiles: [],
        allowedCreateRoots: ["."],
        cwd: "C:/repo",
      }
    );
    assert.deepEqual(outOfScope, []);
  });

  it("builds a deterministic fail verdict for committed out-of-scope files", async () => {
    const assessor = await import("../../../lib/domains/worker/classes/roles/assessor.js");
    const verdict = assessor.__testBuildCommittedScopeViolationVerdict({
      task_mode: "code",
      allowed_files: ["src/app.js"],
      allowed_create_files: [],
      allowed_delete_files: [],
      allowed_create_roots: [],
      files_committed: ["src/app.js", "package.json"],
      files_requested: [{ path: "package.json", risk: "high", reason: "needs package script" }],
    }, "C:/repo");

    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.confidence, "high");
    assert.match(verdict.reasons[0], /out-of-scope file/);
    assert.match(verdict.reasons[0], /follow-up scope/);
  });

  it("builds a deterministic fail verdict when committed files cannot be verified", async () => {
    const assessor = await import("../../../lib/domains/worker/classes/roles/assessor.js");
    const verdict = assessor.__testBuildCommittedScopeViolationVerdict({
      task_mode: "code",
      commit_hash: "abc123",
      allowed_files: ["src/app.js"],
      files_committed: [],
      files_committed_unknown: true,
      files_committed_error: "git diff failed",
    }, "C:/repo");

    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.confidence, "high");
    assert.match(verdict.reasons[0], /could not verify the actual committed files/);
    assert.match(verdict.reasons[0], /git diff failed/);
  });

  it("attaches a compact diff narrative to assessment context", async () => {
    const { attachAssessmentDiffContext } = await import("../../../lib/domains/handoff/functions/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-diff-narrative-"));
    const git = (...args) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" });

    try {
      git("init");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test User");
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "app.js"), [
        "export function answer() {",
        "  return 1;",
        "}",
        "",
      ].join("\n"));
      git("add", ".");
      git("commit", "-m", "base");
      fs.writeFileSync(path.join(projectDir, "src", "app.js"), [
        "export function answer() {",
        "  const value = 42;",
        "  return value;",
        "}",
        "",
      ].join("\n"));
      git("add", ".");
      git("commit", "-m", "change answer");
      const commitHash = git("rev-parse", "HEAD").trim();

      const context = attachAssessmentDiffContext({
        commit_hash: commitHash,
        files_committed: ["src/app.js"],
      }, projectDir);

      assert.match(context.scoped_diff_narrative, /DIFF NARRATIVE:/);
      assert.match(context.scoped_diff_narrative, /src\/app\.js: modified/);
      assert.match(context.scoped_diff_narrative, /const value = 42/);
      assert.ok(context.scoped_git_diff.includes("const value = 42"));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("filters registered test evidence to tests covering the assessment scope", async () => withTempRuntimeDb(async (projectDir) => {
    const assessor = await import("../../../lib/domains/worker/classes/roles/assessor.js");
    const db = getDb();
    const workItemId = db.prepare(`
      INSERT INTO work_items (title, description)
      VALUES ('registered evidence scope', 'test')
    `).run().lastInsertRowid;
    const jobId = db.prepare(`
      INSERT INTO jobs (work_item_id, job_type, title, status)
      VALUES (?, 'dev', 'registered evidence scope', 'running')
    `).run(workItemId).lastInsertRowid;
    const actor = { role: "dev", jobId, workItemId };

    const suiteResult = createRegisteredTestSuite({
      args: { name: "Scoped Evidence", explanation: "Evidence filtering tests." },
      cwd: projectDir,
      actor,
      db,
    });
    assert.equal(suiteResult.ok, true);

    const appResult = createRegisteredTest({
      args: {
        suite_id: suiteResult.suite.id,
        name: "app behavior",
        explanation: "Covers the app file.",
        language: "javascript",
        target_files: ["src/app.js"],
        target_symbols: ["renderApp"],
        target_imports: [{ path: "src/app.js", symbols: ["renderApp"] }],
        test: "async () => true",
      },
      cwd: projectDir,
      actor,
      db,
    });
    assert.equal(appResult.ok, true);

    const otherResult = createRegisteredTest({
      args: {
        suite_id: suiteResult.suite.id,
        name: "other behavior",
        explanation: "Covers another file.",
        language: "javascript",
        target_files: ["src/other.js"],
        target_symbols: ["other"],
        test: "async () => true",
      },
      cwd: projectDir,
      actor,
      db,
    });
    assert.equal(otherResult.ok, true);

    const evidence = assessor.__testBuildRegisteredTestRunEvidence({
      jobId,
      scopeFiles: ["src/app.js"],
      db,
    });

    assert.match(evidence, /app behavior/);
    assert.match(evidence, /files=\[src\/app\.js\]/);
    assert.match(evidence, /symbols=\[renderApp\]/);
    assert.match(evidence, /imports: src\/app\.js/);
    assert.doesNotMatch(evidence, /other behavior/);
  }));
});
