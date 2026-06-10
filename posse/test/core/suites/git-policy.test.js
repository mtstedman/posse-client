import {
  it,
  assert,
  suite,
  jobNeedsGitWorktree,
  jobsNeedGitWorktree,
} from "../support/core-harness.js";

let db;

function parsePayload(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try { return JSON.parse(value); } catch { return {}; }
}

function jobNeedsWorktree(job) {
  if (!job || typeof job !== "object") return false;
  if (job.job_type === "promote") return true;
  if (job.job_type === "dev" || job.job_type === "fix") {
    return (parsePayload(job.payload_json).task_mode || "code") === "code";
  }
  return false;
}

function fakeGitPolicyManager() {
  return {
    shouldUse(name) {
      assert.equal(name, "git");
      return true;
    },
    binary(name) {
      assert.equal(name, "git");
      return {
        runSync(command, args, opts) {
          assert.deepEqual(args, []);
          const envelope = JSON.parse(String(opts.input));
          let data = false;
          if (command === "git.jobNeedsWorktree") {
            data = jobNeedsWorktree(envelope.payload);
          } else if (command === "git.jobsNeedWorktree") {
            data = Array.isArray(envelope.payload.jobs)
              && envelope.payload.jobs.some(jobNeedsWorktree);
          } else {
            assert.fail(`unexpected native command: ${command}`);
          }
          const json = { ok: true, data };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

suite("Git policy", () => {
  it("requires git worktrees only for code-mutating dev and fix jobs", () => {
    const manager = fakeGitPolicyManager();
    assert.equal(jobNeedsGitWorktree({ job_type: "research" }, { manager }), false);
    assert.equal(jobNeedsGitWorktree({ job_type: "plan" }, { manager }), false);
    assert.equal(jobNeedsGitWorktree({ job_type: "assess" }, { manager }), false);
    assert.equal(jobNeedsGitWorktree({ job_type: "artificer", payload_json: JSON.stringify({ task_mode: "image" }) }, { manager }), false);
    assert.equal(jobNeedsGitWorktree({ job_type: "promote" }, { manager }), true);
    assert.equal(jobNeedsGitWorktree({ job_type: "dev", payload_json: JSON.stringify({ task_mode: "code" }) }, { manager }), true);
    assert.equal(jobNeedsGitWorktree({ job_type: "dev", payload_json: JSON.stringify({ task_mode: "report" }) }, { manager }), false);
    assert.equal(jobNeedsGitWorktree({ job_type: "fix", payload_json: JSON.stringify({}) }, { manager }), true);
  });

  it("detects whether a run has any jobs that need git worktrees", () => {
    const manager = fakeGitPolicyManager();
    assert.equal(jobsNeedGitWorktree([
      { job_type: "research" },
      { job_type: "plan" },
      { job_type: "assess" },
    ], { manager }), false);

    assert.equal(jobsNeedGitWorktree([
      { job_type: "research" },
      { job_type: "dev", payload_json: JSON.stringify({ task_mode: "code" }) },
    ], { manager }), true);

    assert.equal(jobsNeedGitWorktree([
      { job_type: "research" },
      { job_type: "promote" },
    ], { manager }), true);
  });
});
