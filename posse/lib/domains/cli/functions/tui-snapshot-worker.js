import { parentPort, workerData } from "node:worker_threads";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* worker is already closing */ }
}

function errorPayload(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err || "TUI snapshot worker failed"),
    stack: err?.stack || null,
  };
}

async function buildPipelineData({ projectDir = null, dbPath = null } = {}) {
  const { setRuntimePathOverrides } = await import("../../runtime/functions/paths.js");
  setRuntimePathOverrides({ projectDir, dbPath });
  const { listWorkItems, listJobsByWorkItem } = await import("../../queue/functions/index.js");
  const { getArtifacts } = await import("../../queue/functions/artifacts.js");
  const { parseJobPayload } = await import("../../queue/functions/payload.js");
  const { BACKGROUND_JOB_TYPES } = await import("../../../catalog/job.js");

  const active = listWorkItems(["queued", "planning", "running", "complete", "failed"]);
  return active.slice(0, 20).map((wi) => {
    // The pipeline is agent work only — background maintenance (atlas_warm)
    // never appears here even when it is scoped to this work item.
    const jobs = listJobsByWorkItem(wi.id)
      .filter((job) => !BACKGROUND_JOB_TYPES.has(job.job_type));
    jobs.sort((a, b) => a.id - b.id);

    const enriched = jobs.map((job) => {
      const handoff = [];
      if (job.job_type === "research" && job.status === "succeeded") {
        const summaries = getArtifacts(job.id, "summary");
        if (summaries.length > 0) {
          const text = summaries[summaries.length - 1].content_long || "";
          const lineCount = text.split("\n").filter((line) => line.trim()).length;
          handoff.push(`\u2192 planner: ${lineCount} lines, ${(text.length / 1024).toFixed(1)}KB`);
        }
      } else if (job.job_type === "plan" && job.status === "succeeded") {
        const spawned = jobs.filter((item) => item.parent_job_id === job.id);
        const devCount = spawned.filter((item) => item.job_type === "dev").length;
        const otherCount = spawned.length - devCount;
        const parts = [];
        if (devCount > 0) parts.push(`${devCount} dev`);
        if (otherCount > 0) parts.push(`${otherCount} other`);
        handoff.push(`\u2192 spawned: ${parts.join(", ") || "0 tasks"}`);
      } else if (job.job_type === "delegate" && job.status === "succeeded") {
        const delegated = jobs.filter((item) => item.provider && item.provider !== "claude" && ["dev", "fix"].includes(item.job_type));
        if (delegated.length > 0) {
          const providers = [...new Set(delegated.map((item) => item.provider))];
          handoff.push(`\u2192 assigned: ${providers.join(", ")}`);
        }
      } else if ((job.job_type === "dev" || job.job_type === "fix") && job.status === "succeeded") {
        const payload = parseJobPayload(job);
        const files = [...(payload.files_to_modify || []), ...(payload.files_to_create || [])];
        if (files.length > 0) {
          handoff.push(`\u2192 files: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`);
        }
        if (job.assessor_verdict && job.assessor_verdict !== "not_assessed") {
          handoff.push(`\u2192 assessor: ${job.assessor_verdict}`);
        }
      } else if (job.job_type === "human_input") {
        const answers = getArtifacts(job.id, "response");
        if (answers.length > 0) {
          const answer = (answers[answers.length - 1].content_long || "").split("\n")[0].slice(0, 60);
          handoff.push(`\u2192 answer: ${answer}`);
        }
      }

      return { ...job, handoff };
    });

    return { id: wi.id, title: wi.title, status: wi.status, jobs: enriched };
  });
}

async function buildToolData({ projectDir = null, dbPath = null } = {}) {
  const { setRuntimePathOverrides } = await import("../../runtime/functions/paths.js");
  setRuntimePathOverrides({ projectDir, dbPath });
  const { listActiveFileLocks } = await import("../../queue/functions/index.js");
  const {
    getRecentToolInvocations,
    getToolInvocationCountsByJob,
  } = await import("../../observability/functions/observations.js");

  return {
    jobs: getToolInvocationCountsByJob({ limit: 20 }),
    recent: getRecentToolInvocations({ limit: 40, includeUnscoped: false, currentRunOnly: true }),
    activeLocks: listActiveFileLocks(),
  };
}

async function main() {
  const { task, args = {} } = workerData || {};
  if (task === "pipeline") return buildPipelineData(args);
  if (task === "tools") return buildToolData(args);
  throw new Error(`Unknown TUI snapshot task: ${task}`);
}

main()
  .then((result) => post({ type: "result", result }))
  .catch((err) => post({ type: "error", error: errorPayload(err) }));
