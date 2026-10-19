import fs from "node:fs";
import path from "node:path";
import { getJob, listJobs, listJobsByWorkItem } from "../../queue/functions/index.js";
import { localPath } from "./environment-paths.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { linkNodeDependenciesFromPrimaryCheckout, linkComposerVendorFromPrimaryCheckout } from "../../verification/functions/prerequisite-adapters.js";
import { prepareDevelopmentDatabase } from "./planning-database.js";

function payload(job) { return JSON.parse(job?.payload_json || "{}"); }

function completedSetupGate(job) {
  if (job?.job_type !== "human_input") return false;
  let data;
  try { data = payload(job); } catch { return false; }
  return data.review_type === "environment_setup" && data.proposal?.tool === "setup_environment"
    && data.execution?.status === "completed" && data.execution.result?.ok === true && !!data.execution.result.commit;
}

// Setup is a precondition of the plan that requested it. A later plan, made
// after the user answered how to proceed, is not held by an earlier plan's
// rejected or failed request; it reuses the latest successful installation.
// Development is expected to change manifests, ignore rules and local files
// afterwards; development start reports anything it cannot reuse. Setup is
// committed to the shared primary checkout, so a work item that ran none
// reuses the project's latest approved installation and database.
export function planningEnvironmentReadiness(planJob) {
  const current = getJob(planJob?.id) || planJob;
  if (payload(current)._environment_setup_pending === true) {
    return { ok: false, gateId: null, message: `Dependency setup requested by planning job #${current.id} has not completed successfully. Approval, installation, and a clean setup commit are required before its development tasks.` };
  }
  const latest = (jobs) => jobs.filter(completedSetupGate).sort((a, b) => b.id - a.id)[0];
  const gate = latest(listJobsByWorkItem(current.work_item_id)) || latest(listJobs());
  if (!gate) return { ok: true, gateId: null };
  const receipt = payload(gate).execution.result;
  return { ok: true, gateId: gate.id, receipt, ownSetup: Number(payload(gate).original_job_id) === Number(current.id) };
}

function pathPresent(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

// Installed trees are ignored by Git. Materialize the approved installation
// before pre-dev checks or providers run, without launching another installer.
// A work item that changed its manifests owns its dependencies from then on:
// a mismatch is reported to the operator and the developer, never fatal.
export async function prepareDevelopmentEnvironment(job, cwd) {
  const gateId = payload(job)._environment_setup_gate_id;
  if (!gateId || !["dev", "fix"].includes(job.job_type)) return { notices: [] };
  const gate = getJob(gateId);
  if (!completedSetupGate(gate) || !cwd) throw new Error("Approved dependency setup is incomplete; development cannot start.");
  const receipt = payload(gate).execution.result;
  const notices = [];
  for (const entry of receipt.packages) {
    if (path.resolve(cwd) === path.resolve(receipt.cwd)) continue;
    // A preceding job in this worktree linked or installed it already.
    if (pathPresent(path.join(cwd, entry.dependency_path))) continue;
    if (!(await listIgnoredRepoPaths(cwd, [`${entry.dependency_path}/.posse-setup-probe`])).length) {
      notices.push(`${entry.dependency_path}/ is not ignored in this checkout, so the approved ${entry.manager} installation was not linked.`);
      continue;
    }
    const directory = localPath(cwd, entry.path);
    const result = entry.manager === "npm" ? linkNodeDependenciesFromPrimaryCheckout(directory) : linkComposerVendorFromPrimaryCheckout(directory);
    if (!result.ok) notices.push(`The approved ${entry.manager} installation for ${entry.path} was not linked (${result.reason}); its installed packages are not available in this worktree yet.`);
  }
  notices.push(...await prepareDevelopmentDatabase(receipt.database, receipt.cwd, cwd));
  return { notices };
}
