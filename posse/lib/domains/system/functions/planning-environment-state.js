import fs from "node:fs";
import path from "node:path";
import { getJob, listJobsByWorkItem } from "../../queue/functions/index.js";
import { fingerprint, localPath } from "./environment-paths.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { linkNodeDependenciesFromPrimaryCheckout, linkComposerVendorFromPrimaryCheckout } from "../../verification/functions/prerequisite-adapters.js";
import { assertPlanningDatabaseReady, prepareDevelopmentDatabase } from "./planning-database.js";

function payload(job) { return JSON.parse(job?.payload_json || "{}"); }

export function planningEnvironmentReadiness(workItemId) {
  const jobs = listJobsByWorkItem(workItemId);
  const source = jobs.filter((job) => job.job_type === "plan" && Object.hasOwn(payload(job), "_environment_setup_pending"))
    .sort((a, b) => b.id - a.id)[0];
  if (source && payload(source)._environment_setup_pending) {
    return { ok: false, gateId: null, message: `Planning dependency setup for job #${source.id} is incomplete. Resolve the setup requirement with an approved successful batch before development.` };
  }
  const gate = jobs
    .filter((job) => payload(job).review_type === "environment_setup" && payload(job).proposal?.tool === "setup_environment")
    .sort((a, b) => b.id - a.id)[0];
  if (!gate) return { ok: true, gateId: null };
  const data = payload(gate);
  const receipt = data.execution?.result;
  if (data.execution?.status !== "completed" || !receipt?.ok || !receipt.commit) {
    return { ok: false, gateId: gate.id, message: `Dependency setup #${gate.id} has not completed successfully. Approval, installation, and a clean setup commit are required before development.` };
  }
  try {
    assertPlanningDatabaseReady(receipt.database, receipt.cwd);
    for (const [relative, expected] of Object.entries(receipt.files)) {
      if (fingerprint(localPath(receipt.cwd, relative)) !== expected) throw new Error(`${relative} changed after setup`);
    }
    for (const entry of receipt.packages) {
      if (!fs.existsSync(localPath(receipt.cwd, entry.dependency_path, { dependencyDirectory: true }))) throw new Error(`${entry.dependency_path} is missing`);
    }
    return { ok: true, gateId: gate.id, receipt };
  } catch (error) {
    return { ok: false, gateId: gate.id, message: `Dependency setup #${gate.id} is no longer ready: ${error.message}. Request a new approved setup batch.` };
  }
}

// Installed trees are ignored by Git. Materialize the approved installation
// before pre-dev checks or providers run, without launching another installer.
export async function prepareDevelopmentEnvironment(job, cwd) {
  const gateId = payload(job)._environment_setup_gate_id;
  if (!gateId || !["dev", "fix"].includes(job.job_type)) return;
  const gate = getJob(gateId);
  if (gate?.work_item_id !== job.work_item_id) throw new Error("Dependency setup belongs to a different work item.");
  const receipt = payload(gate).execution?.result;
  if (payload(gate).execution?.status !== "completed" || !receipt?.ok || !cwd) throw new Error("Approved dependency setup is incomplete; development cannot start.");
  for (const [relative, expected] of Object.entries(receipt.files)) {
    // .gitignore may legitimately grow as other development tasks run.
    if (relative === ".gitignore") continue;
    if (fingerprint(localPath(cwd, relative)) !== expected || fingerprint(localPath(receipt.cwd, relative)) !== expected) {
      throw new Error(`Approved dependency setup differs from ${relative}; development cannot start until setup is reconciled.`);
    }
  }
  for (const entry of receipt.packages) {
    const directory = localPath(cwd, entry.path);
    if (!(await listIgnoredRepoPaths(cwd, [`${entry.dependency_path}/.posse-setup-probe`])).length) {
      throw new Error(`The development checkout must ignore ${entry.dependency_path}/ before using installed dependencies.`);
    }
    if (path.resolve(cwd) === path.resolve(receipt.cwd)) continue;
    const result = entry.manager === "npm" ? linkNodeDependenciesFromPrimaryCheckout(directory) : linkComposerVendorFromPrimaryCheckout(directory);
    // A preceding dev in the same worktree may already have materialized it.
    if (!result.ok && result.reason !== "worktree_vendor_present") throw new Error(`Approved ${entry.manager} setup is unavailable in the development worktree: ${result.reason}`);
  }
  await prepareDevelopmentDatabase(receipt.database, receipt.cwd, cwd);
}
