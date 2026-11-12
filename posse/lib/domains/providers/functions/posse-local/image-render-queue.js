// Deferring a local image: instead of holding an agent's turn for the many
// minutes a local model needs, the image tool writes a placeholder, queues a
// render job in the same work item, and returns. The scheduler runs that job
// without an agent; it swaps the real image in. Until it has, promote jobs
// leave the file alone and the work item cannot finish.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_MODEL_PARAMETERS } from "../../../../catalog/local-model-parameters.js";
import { LEASE_HOLDING_STATUSES } from "../../../../catalog/job.js";
import { createJob, getJob, listJobsByWorkItem, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { getObservationContext } from "../../../observability/functions/observations.js";
import { readModelSetting } from "../shared/setting-read.js";
import { localImageProviderModels, localImageSize } from "./image-client.js";
import { encodePlaceholderPng, sha256Hex } from "./placeholder-image.js";

/** The render request a job carries, or null for any other job. */
export function localImageRenderSpec(job) {
  const spec = parseJobPayload(job)?.local_image_render;
  return job?.job_type === "artificer" && spec && typeof spec === "object" && typeof spec.filename === "string" ? spec : null;
}

/** True when a deferred local render in this work item was queued by `job`. */
export function jobQueuedLocalImageRender(job) {
  if (!job?.work_item_id) return false;
  return listJobsByWorkItem(job.work_item_id).some(sibling => Number(localImageRenderSpec(sibling)?.source_job_id) === Number(job.id));
}

// The size the model will produce: the requested one fitted to its limits,
// else its saved defaults. Fixed here so the placeholder and the real image
// have the same dimensions.
function renderDimensions(size, model, readSetting) {
  const fitted = localImageSize(size, model);
  if (fitted.width) return fitted;
  const { width, height } = LOCAL_MODEL_PARAMETERS[model.modelId].parameters;
  const saved = (parameter) => {
    const value = Number(parameter.defaultSetting ? readSetting(parameter.defaultSetting) : NaN);
    return Number.isInteger(value) && value >= parameter.min && value <= parameter.max && value % parameter.multiple === 0 ? value : parameter.default;
  };
  return { width: saved(width), height: saved(height) };
}

function writeAtomically(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.placeholder-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* already moved */ }
  }
}

/**
 * Writes the placeholder and queues the render. Returns null when the call
 * is not inside a job (a media tool, the CLI): those wait for the image.
 *
 * @returns {{ jobId: number, width: number, height: number, updated: boolean }|null}
 */
export function queueLocalImageRender({ outputPath, filename, prompt, model, size = null }, {
  context = getObservationContext() || {}, readSetting = readModelSetting,
} = {}) {
  const sourceJob = context.job_id ? getJob(context.job_id) : null;
  if (!sourceJob?.work_item_id) return null;
  // Only an artificer writes into the work item's artifacts, where a
  // placeholder is safe: promote keeps it out of the repo. A job that writes
  // straight into its worktree would commit the placeholder, so it waits for
  // the real image instead. A render job never defers itself.
  if (sourceJob.job_type !== "artificer" || localImageRenderSpec(sourceJob)) return null;
  const profile = localImageProviderModels().find(candidate => candidate.modelId === String(model || "").toLowerCase());
  if (!profile) return null;
  const { width, height } = renderDimensions(size, profile, readSetting);
  const marker = `posse-local-render ${randomUUID()}`;
  const placeholder = encodePlaceholderPng({ width, height, marker });
  const outputRoot = path.dirname(outputPath);
  const payload = {
    output_root: outputRoot,
    // Promote jobs defer a file an unfinished job is still producing.
    _repair_image_names: [filename],
    skip_assessment: true,
    local_image_render: {
      filename, prompt, model: profile.modelId, width, height,
      placeholder_sha256: sha256Hex(placeholder), source_job_id: sourceJob.id,
    },
  };
  // The same file asked for again before its render started: one render,
  // with the latest request.
  const queued = listJobsByWorkItem(sourceJob.work_item_id).find((sibling) => {
    const spec = localImageRenderSpec(sibling);
    return spec && sibling.status === "queued" && !LEASE_HOLDING_STATUSES.includes(sibling.status)
      && spec.filename === filename && path.resolve(String(parseJobPayload(sibling)?.output_root || "")) === path.resolve(outputRoot);
  });
  writeAtomically(outputPath, placeholder);
  if (queued) {
    updateJobPayload(queued.id, JSON.stringify({ ...parseJobPayload(queued), ...payload }));
    return { jobId: queued.id, width, height, updated: true };
  }
  const job = createJob({
    work_item_id: sourceJob.work_item_id,
    job_type: "artificer",
    title: `Render ${filename} with the local image model`.slice(0, 200),
    parent_job_id: sourceJob.id,
    priority: sourceJob.priority,
    // A failed local render is the operator's call (retry, or keep the
    // placeholder), not something to spend another long run on unasked.
    max_attempts: 1,
    payload_json: JSON.stringify(payload),
  });
  return { jobId: job.id, width, height, updated: false };
}
