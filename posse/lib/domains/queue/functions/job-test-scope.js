import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { isTestCollateralPath } from "../../../shared/policies/functions/scope-auto-approval.js";

const paths = (values) => (Array.isArray(values) ? values : [])
  .filter((value) => typeof value === "string").map((value) => value.replace(/\\/g, "/").replace(/^\.\//, ""));

export function jobTestPaths(payload = {}) {
  return [...new Set([...paths(payload.tests_to_run),
    ...paths(payload.files_to_modify).filter(isTestCollateralPath),
    ...paths(payload.files_to_create).filter(isTestCollateralPath)])];
}

export function unfinishedTestOwners(job, payload = {}) {
  if (!job?.work_item_id) return new Map();
  const root = Number(payload.root_job_id || payload.original_job_id || job.id);
  const owners = new Map();
  for (const sibling of getDb().prepare("SELECT id, status, payload_json FROM jobs WHERE work_item_id = ? AND job_type IN ('dev', 'fix')").all(job.work_item_id)) {
    if (sibling.id === Number(job.id) || TERMINAL_JOB_STATUSES.includes(sibling.status)) continue;
    const data = JSON.parse(sibling.payload_json || "{}");
    if (Number(data.root_job_id || data.original_job_id || sibling.id) === root) continue;
    for (const file of [...paths(data.files_to_modify), ...paths(data.files_to_create)].filter(isTestCollateralPath)) owners.set(file, sibling.id);
  }
  return owners;
}

export function jobTestPermission(jobId, requestedPath) {
  if (!jobId) return null;
  const job = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(Number(jobId));
  if (!job || !["dev", "fix"].includes(job.job_type)) return null;
  const payload = JSON.parse(job.payload_json || "{}");
  const file = paths([requestedPath])[0];
  if (!jobTestPaths(payload).includes(file)) return { allowed: false, reason: "Test is outside this job's selected tests and writable scope." };
  const owner = unfinishedTestOwners(job, payload).get(file);
  return owner ? { allowed: false, reason: `Test is still being written by job #${owner}.` } : { allowed: true };
}
