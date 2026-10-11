// lib/domains/worker/functions/helpers/baseline-attribution.js
//
// A frozen baseline that fails before a job starts is baseline debt: never
// this job's fault, and no action is taken on it. When the same command
// passed for an earlier job of the same work item at an ancestor commit, the
// failure is a sibling regression. Name local jobs and merged work items
// whose commits landed in between as candidates, without asserting blame.
// Attribution only; routing is
// unchanged. Baseline results never reach the dev context.

import { gitExecAsync } from "../../../git/functions/utils.js";
import { parseSquashMergeSubject } from "../../../git/functions/merge-target-debt.js";
import { resolveTargetBranchForAdmin } from "../../../git/functions/target-branch.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { updateJobPayload } from "../../../queue/functions/index.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { BASELINE_SIBLING_REGRESSION_OBSERVATION_TYPE } from "../../../../catalog/observation.js";
import { workItemCommandReceipts } from "./test-execution-receipt.js";

const MAX_RANGE_COMMITS = 200;
const MAX_PASS_CANDIDATES = 32;
const PAYLOAD_KEY = "_baseline_sibling_regression";

async function isAncestor(git, cwd, ancestor, descendant) {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

function jobsOwningCommits(workItemId, excludeJobId, commits) {
  if (commits.length === 0) return [];
  const rows = getDb().prepare(`
    SELECT a.job_id, j.title, a.commit_hash
    FROM job_attempts a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.work_item_id = ? AND a.job_id <> ? AND a.commit_hash IN (${commits.map(() => "?").join(", ")})
    ORDER BY a.id
  `).all(workItemId, excludeJobId, ...commits);
  const byJob = new Map();
  for (const row of rows) {
    if (!byJob.has(row.job_id)) byJob.set(row.job_id, { job_id: row.job_id, title: row.title, commit_hash: row.commit_hash });
  }
  return [...byJob.values()];
}

// Every merged work item's squash commit in (lastPass, failing]. The whole
// range is walked, not only first parents: a work-item branch that merged its
// target in brings the target's squash commits in through a second parent.
async function localTargetMerges(commits, cwd, git, { from, to }) {
  const targetBranch = resolveTargetBranchForAdmin(cwd);
  if (!targetBranch || commits.length === 0) return [];
  let lines;
  try {
    lines = String(await git(["log", `--max-count=${MAX_RANGE_COMMITS}`, "--format=%H%x09%s",
      `${from}..${to}`], cwd) || "").split("\n").filter(Boolean);
  } catch { return []; }
  const inRange = new Set(commits);
  const lookup = getDb().prepare(`
    SELECT id, title, branch_name FROM work_items
    WHERE branch_name = ? AND merge_state = 'merged'
    ORDER BY id DESC LIMIT 1
  `);
  return lines.flatMap((line) => {
    const [commit, ...subject] = line.split("\t");
    if (!inRange.has(commit)) return [];
    const branch = parseSquashMergeSubject(subject.join("\t"), targetBranch);
    const workItem = branch ? lookup.get(branch) : null;
    return workItem?.branch_name === branch
      ? [{ commit_hash: commit, work_item_id: workItem.id, title: workItem.title,
        branch_name: branch, target_branch: targetBranch }]
      : [];
  });
}

/**
 * @returns {Promise<object|null>} the attribution, or null when the failing
 *   baseline has no earlier same-command pass on an ancestor commit.
 */
export async function attributeBaselineFailure({ job, receipt, cwd } = {}, {
  listReceipts = workItemCommandReceipts,
  git = gitExecAsync,
} = {}) {
  if (receipt?.phase !== "baseline" || receipt?.status !== "failed" || !receipt.commit_hash || !cwd) return null;
  const failingCommit = receipt.commit_hash;
  const priorReceipts = listReceipts(job.work_item_id, {
    excludeJobId: job.id,
    command: receipt.command,
    cwdRelative: receipt.cwd_relative || null,
  });
  const passes = priorReceipts.filter((candidate) => candidate.status === "passed" && candidate.commit_hash && candidate.commit_hash !== failingCommit);
  let lastPass = null;
  const checked = new Set();
  for (const candidate of passes) {
    if (checked.has(candidate.commit_hash)) continue;
    if (checked.size >= MAX_PASS_CANDIDATES) break;
    checked.add(candidate.commit_hash);
    if (await isAncestor(git, cwd, candidate.commit_hash, failingCommit)) { lastPass = candidate; break; }
  }
  if (!lastPass) return null;
  let commits;
  try {
    commits = String(await git(["rev-list", `--max-count=${MAX_RANGE_COMMITS}`, `${lastPass.commit_hash}..${failingCommit}`], cwd) || "")
      .split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
  if (commits.length === 0) return null;
  const suspects = jobsOwningCommits(job.work_item_id, job.id, commits);
  const mergedWorkItems = await localTargetMerges(commits, cwd, git, { from: lastPass.commit_hash, to: failingCommit });
  const currentFingerprint = String(receipt.failure_fingerprint || "");
  const eligibleSuspects = [];
  for (const suspect of suspects) {
    const alreadyFailed = currentFingerprint && priorReceipts.some((candidate) =>
      Number(candidate.artifact_job_id) === Number(suspect.job_id)
      && candidate.phase === "baseline" && candidate.status === "failed"
      && candidate.failure_fingerprint === currentFingerprint);
    if (!alreadyFailed) eligibleSuspects.push(suspect);
  }
  return {
    schema_version: 1,
    command: receipt.command,
    passed_commit: lastPass.commit_hash,
    passed_job_id: lastPass.artifact_job_id ?? null,
    failing_commit: failingCommit,
    commits_in_range: commits.length,
    suspect_jobs: eligibleSuspects,
    target_merged_work_items: mergedWorkItems,
    excluded_preexisting_jobs: suspects.filter((suspect) => !eligibleSuspects.includes(suspect)).map((suspect) => suspect.job_id),
  };
}

/**
 * Attribute a failing frozen baseline once per job, store the attribution on
 * the job payload, and record an observation. Best effort: never throws.
 */
export async function recordBaselineSiblingRegression(worker, job, receipt, cwd, deps = {}) {
  try {
    const payload = worker.parsePayload(job);
    if (payload[PAYLOAD_KEY]) return payload[PAYLOAD_KEY];
    const attribution = await attributeBaselineFailure({ job, receipt, cwd }, deps);
    if (!attribution) return null;
    payload[PAYLOAD_KEY] = attribution;
    job.payload_json = JSON.stringify(payload);
    updateJobPayload(job.id, job.payload_json);
    const suspects = [
      ...attribution.suspect_jobs.map((suspect) => `job #${suspect.job_id}`),
      ...(attribution.target_merged_work_items || []).map((item) => `merged WI#${item.work_item_id}`),
    ].join(", ")
      || (attribution.excluded_preexisting_jobs.length > 0 ? "no job with a new failure" : "unrecorded commits");
    const summary = `Frozen baseline passed for job #${attribution.passed_job_id ?? "?"} and now fails; commits since from ${suspects}`;
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: null,
      observation_type: BASELINE_SIBLING_REGRESSION_OBSERVATION_TYPE,
      summary,
      detail: attribution,
    });
    worker.emit?.(job.id, `[test-intake] WI#${job.work_item_id} job #${job.id}: ${summary}`);
    return attribution;
  } catch {
    return null;
  }
}

// Assessor prompt block for a stored attribution, or null.
export function renderBaselineSiblingRegression(payload = {}) {
  const attribution = payload?.[PAYLOAD_KEY];
  if (!attribution?.command || !attribution.passed_commit || !attribution.failing_commit) return null;
  const named = [
    ...(attribution.suspect_jobs || []).map((suspect) => `job #${suspect.job_id} (${suspect.title})`),
    ...(attribution.target_merged_work_items || []).map((item) => `merged WI#${item.work_item_id} (${item.title}) on ${item.target_branch}`),
  ];
  const suspects = named.length > 0 ? named.join(", ")
    : (attribution.excluded_preexisting_jobs || []).length > 0
      ? "no job whose own baseline was green for this failure"
      : "commits no job of this work item recorded";
  return [
    "BASELINE REGRESSION FROM AN EARLIER JOB:",
    `  The frozen test command \`${attribution.command}\` passed at ${String(attribution.passed_commit).slice(0, 12)}${attribution.passed_job_id ? ` (job #${attribution.passed_job_id})` : ""} and already failed at ${String(attribution.failing_commit).slice(0, 12)}, before this job changed anything.`,
    `  The ${attribution.commits_in_range} commit(s) in between came from ${suspects}.`,
    "  That failure predates this job. These are candidates, not proof of cause; inspect the failure interval before assigning responsibility.",
    "",
  ].join("\n");
}
