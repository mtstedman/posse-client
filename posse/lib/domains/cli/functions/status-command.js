import { statusColor, statusIcon } from "../../ui/functions/display/status-palette.js";
import { jobLabel } from "../../ui/functions/display/helpers/job-status.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { getJobStats, getPipelineHealth, getSetting, listJobsByWorkItem, listWorkItems } from "../../queue/functions/index.js";
import { C as defaultColors } from "../../../shared/format/functions/colors.js";
import { getDefaultTierModel } from "../../providers/functions/model-catalog.js";
import { providerRoleForJobType } from "../../providers/functions/roles.js";

const DEFAULT_STATUS_DETAIL_LIMIT = 25;
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeStatsMap(stats) {
  const counts = {};
  for (const row of stats || []) {
    counts[row.status] = Number(row.count || 0);
  }
  return counts;
}

function formatStatsRows(counts) {
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
}

function parseLimit(raw) {
  if (raw == null || raw === "") throw new Error("--limit requires a value");
  const value = String(raw).trim().toLowerCase();
  if (value === "all") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error("--limit must be a positive integer or 'all'");
  }
  return parsed;
}

export function parseStatusOptions(args = []) {
  const options = {
    active: false,
    json: false,
    limit: DEFAULT_STATUS_DETAIL_LIMIT,
    limitExplicit: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    if (arg === "--active") {
      options.active = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit" || arg === "-n") {
      options.limit = parseLimit(args[++i]);
      options.limitExplicit = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = parseLimit(arg.slice("--limit=".length));
      options.limitExplicit = true;
    }
  }

  return options;
}

export function isActiveWorkItem(wi) {
  return !TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status) ||
    wi.merge_state === "pending_review" ||
    wi.merge_state === "merge_failed";
}

function newestFirst(workItems) {
  return [...workItems].sort((a, b) => {
    const aTs = Date.parse(a.updated_at || a.created_at || "");
    const bTs = Date.parse(b.updated_at || b.created_at || "");
    if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return bTs - aTs;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

export function collectStatusData({ targetBranch, args = [] } = {}) {
  const options = parseStatusOptions(args);
  const allWorkItems = listWorkItems();
  const filteredWorkItems = options.active
    ? allWorkItems.filter(isActiveWorkItem)
    : allWorkItems;
  const sortedWorkItems = newestFirst(filteredWorkItems);
  const visibleWorkItems = options.limit == null
    ? sortedWorkItems
    : sortedWorkItems.slice(0, options.limit);
  const filteredJobs = options.active
    ? filteredWorkItems.flatMap(wi => listJobsByWorkItem(wi.id))
    : null;

  const visibleDetails = visibleWorkItems.map((wi) => {
    const jobs = listJobsByWorkItem(wi.id);
    return {
      workItem: wi,
      jobs,
      jobCounts: countBy(jobs, job => job.status),
      succeededJobs: jobs.filter(job => job.status === "succeeded").length,
    };
  });

  const jobCounts = options.active
    ? countBy(filteredJobs, job => job.status)
    : normalizeStatsMap(getJobStats());

  return {
    generated_at: new Date().toISOString(),
    target_branch: targetBranch,
    filter: {
      active: options.active,
      json: options.json,
      limit: options.limit,
      limit_explicit: options.limitExplicit,
    },
    work_items: {
      total_all: allWorkItems.length,
      total: filteredWorkItems.length,
      shown: visibleWorkItems.length,
      by_status: countBy(filteredWorkItems, wi => wi.status),
      truncated: visibleWorkItems.length < filteredWorkItems.length,
    },
    jobs: {
      by_status: jobCounts,
    },
    details: visibleDetails,
  };
}

function renderJsonStatus(data) {
  return JSON.stringify({
    generated_at: data.generated_at,
    target_branch: data.target_branch,
    filter: data.filter,
    work_items: {
      total_all: data.work_items.total_all,
      total: data.work_items.total,
      shown: data.work_items.shown,
      truncated: data.work_items.truncated,
      by_status: data.work_items.by_status,
      items: data.details.map(({ workItem, jobs, jobCounts, succeededJobs }) => ({
        id: workItem.id,
        title: workItem.title,
        status: workItem.status,
        merge_state: workItem.merge_state || null,
        branch_name: workItem.branch_name || null,
        created_at: workItem.created_at,
        updated_at: workItem.updated_at,
        jobs: {
          total: jobs.length,
          succeeded: succeededJobs,
          by_status: jobCounts,
          items: jobs.map(job => ({
            id: job.id,
            type: job.job_type,
            title: job.title,
            status: job.status,
            model_tier: job.model_tier,
            provider: job.provider || null,
            updated_at: job.updated_at,
          })),
        },
      })),
    },
    jobs: data.jobs,
  }, null, 2);
}

function renderHumanStatus(data, { C }) {
  const lines = [];
  const write = (line = "") => lines.push(line);

  write(`\n  ${C.bold}Pipeline Status${C.reset}`);
  write(`  ${C.dim}${"---".repeat(17)}${C.reset}`);
  if (data.filter.active) {
    write(`  ${C.dim}Filter: active work items${C.reset}`);
  }

  write(`\n  ${C.bold}Work Items:${C.reset}`);
  const wiStats = formatStatsRows(data.work_items.by_status);
  if (wiStats.length === 0) {
    write(`    ${C.dim}none${C.reset}`);
  } else {
    for (const { status, count } of wiStats) {
      const color = statusColor(status, C);
      write(`    ${color}${status}: ${count}${C.reset}`);
    }
  }

  write(`\n  ${C.bold}Jobs:${C.reset}`);
  const jobStats = formatStatsRows(data.jobs.by_status);
  if (jobStats.length === 0) {
    write(`    ${C.dim}none${C.reset}`);
  } else {
    for (const { status, count } of jobStats) {
      const color = statusColor(status, C);
      write(`    ${color}${status}: ${count}${C.reset}`);
    }
  }

  const pendingMerges = data.details.filter(({ workItem }) => workItem.merge_state === "pending_review");
  const failedMerges = data.details.filter(({ workItem }) => workItem.merge_state === "merge_failed");
  if (pendingMerges.length > 0 || failedMerges.length > 0) {
    write(`\n  ${C.bold}Merge Status (target: ${data.target_branch}):${C.reset}`);
    if (pendingMerges.length > 0) {
      write(`    ${C.yellow}${pendingMerges.length} pending merge(s)${C.reset} - run ${C.cyan}posse merge${C.reset} or ${C.cyan}posse review${C.reset}`);
    }
    if (failedMerges.length > 0) {
      write(`    ${C.red}${failedMerges.length} failed merge(s)${C.reset} - resolve conflicts and retry`);
    }
  }

  if (data.work_items.total > 0) {
    write(`\n  ${C.bold}Details:${C.reset}`);
    const scope = data.filter.active ? "active work items" : "newest work items";
    write(`  ${C.dim}Showing ${data.work_items.shown} of ${data.work_items.total} ${scope}.${data.work_items.truncated ? " Use --limit all to show everything." : ""}${C.reset}`);
    for (const { workItem, jobs, succeededJobs } of data.details) {
      const wiIcon = statusIcon(workItem.status, { kind: "work_item", colors: C });
      const mergeTag = workItem.merge_state === "pending_review" ? ` ${C.yellow}[PENDING MERGE]${C.reset}` :
        workItem.merge_state === "merged" ? ` ${C.green}[MERGED]${C.reset}` :
          workItem.merge_state === "merge_failed" ? ` ${C.red}[MERGE FAILED]${C.reset}` : "";
      write(`\n    ${wiIcon} WI#${workItem.id}${C.reset} ${String(workItem.title || "").slice(0, 50)} ${C.dim}(${succeededJobs}/${jobs.length} jobs)${C.reset}${mergeTag}`);

      for (const job of jobs) {
        const icon = statusIcon(job.status, { kind: "job", colors: C });
        const tier = ` [${statusTierModelName(job.model_tier, { jobType: job.job_type })}]`;
        write(`      ${icon} #${job.id}${C.reset} ${job.job_type}:${tier} ${jobLabel(job.job_type, job.title).slice(0, 45)}`);
      }
    }
  }

  write("");
  return lines.join("\n");
}

function statusTierModelName(tier, { jobType } = {}) {
  const tierKey = String(tier || "standard").trim().toLowerCase() || "standard";
  const role = providerRoleForJobType(jobType);
  let provider = "claude";
  if (role && role !== "human" && role !== "promote") {
    try {
      const configured = String(getSetting(`provider_${role}`) || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      provider = configured[0] || provider;
    } catch {
      provider = "claude";
    }
  }
  try {
    const override = String(getSetting(`${provider}_model_${tierKey}`) || "").trim();
    if (override) return override;
  } catch {
    // Settings may be unavailable in isolated status tests.
  }
  return getDefaultTierModel(provider, tierKey) || "sonnet";
}

export function createStatusCommands({ targetBranch, C = defaultColors } = {}) {
  if (!targetBranch) throw new Error("createStatusCommands requires targetBranch");

  function status(args = process.argv.slice(3)) {
    let data;
    try {
      data = collectStatusData({ targetBranch, args });
    } catch (err) {
      console.error(`\n${C.red}Status error: ${err.message}${C.reset}\n`);
      process.exitCode = 1;
      return;
    }

    if (data.filter.json) {
      console.log(renderJsonStatus(data));
    } else {
      console.log(renderHumanStatus(data, { C }));
    }
  }

  function health() {
    const healthData = getPipelineHealth();

    console.log(`\n  ${C.bold}Pipeline Health${C.reset}`);
    console.log(`  ${C.dim}${"---".repeat(17)}${C.reset}`);
    console.log(`  Generated: ${C.dim}${healthData.generated_at}${C.reset}`);
    console.log(`  Stuck threshold: ${C.dim}${healthData.staleAfterHours}h${C.reset}`);

    console.log(`\n  ${C.bold}Work Items:${C.reset}`);
    if (healthData.workItemsByStatus.length === 0) {
      console.log(`    ${C.dim}none${C.reset}`);
    } else {
      for (const row of healthData.workItemsByStatus) {
        console.log(`    ${row.status}: ${row.count}`);
      }
    }

    console.log(`\n  ${C.bold}Jobs:${C.reset}`);
    if (healthData.jobsByStatus.length === 0) {
      console.log(`    ${C.dim}none${C.reset}`);
    } else {
      for (const row of healthData.jobsByStatus) {
        console.log(`    ${row.status}: ${row.count}`);
      }
    }

    console.log(`\n  ${C.bold}Dead Letters By Type:${C.reset}`);
    if (healthData.deadLettersByType.length === 0) {
      console.log(`    ${C.green}none${C.reset}`);
    } else {
      for (const row of healthData.deadLettersByType) {
        console.log(`    ${C.red}${row.job_type}${C.reset}: ${row.count} ${C.dim}(last ${row.last_seen_at})${C.reset}`);
      }
    }

    console.log(`\n  ${C.bold}Top Error Signatures:${C.reset}`);
    if (healthData.topErrorSignatures.length === 0) {
      console.log(`    ${C.green}none${C.reset}`);
    } else {
      for (const row of healthData.topErrorSignatures) {
        const deadTag = row.dead_letter_count > 0 ? `, ${row.dead_letter_count} dead_letter` : "";
        console.log(`    ${row.count}x${deadTag} ${C.dim}${row.error_signature.slice(0, 110)}${C.reset}`);
      }
    }

    console.log(`\n  ${C.bold}Stuck Active Jobs:${C.reset}`);
    if (healthData.stuckJobs.length === 0) {
      console.log(`    ${C.green}none${C.reset}`);
    } else {
      for (const job of healthData.stuckJobs) {
        console.log(`    ${C.yellow}#${job.id}${C.reset} WI#${job.work_item_id} ${job.status} ${job.job_type}: ${job.title.slice(0, 70)} ${C.dim}(updated ${job.updated_at})${C.reset}`);
      }
    }

    console.log(`\n  ${C.bold}Parked Jobs:${C.reset}`);
    if (healthData.parkedJobs.length === 0) {
      console.log(`    ${C.green}none${C.reset}`);
    } else {
      for (const job of healthData.parkedJobs) {
        console.log(`    ${C.cyan}#${job.id}${C.reset} WI#${job.work_item_id} ${job.status} ${job.job_type}: ${job.title.slice(0, 70)} ${C.dim}(updated ${job.updated_at})${C.reset}`);
      }
    }

    if (healthData.recentDeadLetters.length > 0) {
      console.log(`\n  ${C.bold}Recent Dead Letters:${C.reset}`);
      for (const job of healthData.recentDeadLetters) {
        const err = (job.last_error || "no last_error").split("\n")[0];
        console.log(`    ${C.red}#${job.id}${C.reset} WI#${job.work_item_id} ${job.job_type}: ${job.title.slice(0, 60)} ${C.dim}(${err.slice(0, 90)})${C.reset}`);
      }
    }

    console.log(`\n  ${C.bold}Provider Health (Recent Calls):${C.reset}`);
    if (!Array.isArray(healthData.providerHealth) || healthData.providerHealth.length === 0) {
      console.log(`    ${C.dim}no provider call history yet${C.reset}`);
    } else {
      for (const row of healthData.providerHealth) {
        const lastSuccess = row.last_success_at || "never";
        const lastFailure = row.last_failure_at || "none";
        const calls = row.total_calls || 0;
        const succeeded = row.succeeded_calls || 0;
        const failed = row.failed_calls || 0;
        const successRate = calls > 0 ? Math.round((100 * succeeded) / calls) : 0;
        const rateColor = successRate >= 80 ? C.green : (successRate >= 50 ? C.yellow : C.red);
        console.log(
          `    ${String(row.provider || "unknown").padEnd(10)} ` +
          `calls=${String(calls).padStart(4)} ` +
          `ok=${String(succeeded).padStart(4)} ` +
          `fail=${String(failed).padStart(4)} ` +
          `rate=${rateColor}${String(successRate).padStart(3)}%${C.reset} ` +
          `${C.dim}last_success=${lastSuccess} last_failure=${lastFailure}${C.reset}`
        );
      }
    }

    console.log();
  }

  return { status, health };
}
