import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { classifyNestedRunnerInfrastructureFailure, validatePlannerTestCommandForRepository } from "../../worker/functions/helpers/test-execution-receipt.js";
import { runCloseoutTestCommandSync } from "./merge-closeout.js";

/** Verify the staged tree without letting test side effects alter the merge. */
export function runDeclaredMergeCandidateChecks({ cwd, jobs = [], git, run = runCloseoutTestCommandSync }) {
  const commands = [...new Set(jobs.filter((job) => job.status === "succeeded" && ["dev", "fix"].includes(job.job_type))
    .map((job) => String(parseJobPayload(job).test_command || "").trim()).filter(Boolean))];
  if (commands.length === 0) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-check-"));
  const checkout = path.join(root, "candidate");
  let added = false;
  try {
    const tree = git(["write-tree"], cwd);
    const head = git(["rev-parse", "HEAD"], cwd);
    const commit = git(["commit-tree", tree, "-p", head, "-m", "Temporary merge verification candidate"], cwd);
    git(["worktree", "add", "--detach", checkout, commit], cwd);
    added = true;
    const results = commands.map((command) => {
      git(["reset", "--hard", commit], checkout);
      git(["clean", "-fdx"], checkout);
      const validation = validatePlannerTestCommandForRepository(command, checkout);
      if (!validation.ok) return { ok: true, status: "unavailable", test: { name: command }, note: validation.reason };
      const result = run(validation.execution_command || command, {
        cwd: validation.cwd_relative ? path.resolve(checkout, validation.cwd_relative) : checkout,
        dependencySourceDir: validation.cwd_relative ? path.resolve(cwd, validation.cwd_relative) : cwd,
      });
      // Missing runners are advisory; an executed failing command is evidence.
      const classified = classifyNestedRunnerInfrastructureFailure(validation.execution_command || command, {
        status: result.status == null ? "unavailable" : result.ok ? "passed" : "failed",
        code: result.status, stdout: result.output, stderr: "",
      }, { projectRoot: checkout });
      const missingRunner = [127, 9009].includes(result.status)
        && /not found|not recognized as an internal or external command/i.test(result.output);
      const unavailable = missingRunner || ["unavailable", "infrastructure_error"].includes(classified.status);
      return { ok: unavailable || result.ok, status: unavailable ? "unavailable" : result.ok ? "passed" : "failed",
        test: { name: command }, ...(unavailable ? { note: result.output } : {}),
        ...(!unavailable && !result.ok ? { failure: { message: result.output } } : {}),
      };
    });
    const passed = results.filter((result) => result.status === "passed").length;
    const failed = results.filter((result) => !result.ok).length;
    const unavailable = results.filter((result) => result.status === "unavailable").length;
    return { ok: failed === 0, matched: results.length, passed, failed, results,
      summary: `declared merge candidate checks: ${passed} passed, ${failed} failed, ${unavailable} unavailable`,
    };
  } finally {
    try {
      if (added) git(["worktree", "remove", "--force", checkout], cwd);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
