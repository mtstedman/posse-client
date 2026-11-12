// Running a deferred local image render (providers/posse-local/
// image-render-queue.js): no agent and no assessment. The local model
// generates the image and it replaces the placeholder the image tool left.
import fs from "node:fs";
import path from "node:path";
import { LOCAL_IMAGE_GENERATION_TIMEOUT_MS } from "../../../../catalog/artifact.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { completeAttempt, incrementAndCreateAttempt } from "../../../queue/functions/index.js";
import { buildImageClient } from "../../../providers/functions/posse-local/image-client.js";
import { sha256Hex } from "../../../providers/functions/posse-local/placeholder-image.js";
import { refreshAndExtractInsights } from "../helpers/insights.js";
import { logAttemptSkippedStaleLease } from "./attempt-logging.js";

// A local image model takes most of a machine's memory: one render at a time
// in this process. A second one goes back to the queue instead of holding a
// worker slot while it waits.
let rendering = false;
const BUSY_REQUEUE_MS = 20_000;
const PROGRESS_INTERVAL_MS = 60_000;

function replacePlaceholder(target, bytes, placeholderSha) {
  let current = null;
  try { current = fs.readFileSync(target); } catch { /* removed: write the image */ }
  // Someone put another file there since (a newer request, a hand edit):
  // theirs stays.
  if (current && sha256Hex(current) !== placeholderSha) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.render-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* already moved */ }
  }
  return true;
}

export async function runLocalImageRenderJob(worker, job, wrappedJob, {
  leaseToken, abortSignal = null, client = buildImageClient(), timeoutMs = LOCAL_IMAGE_GENERATION_TIMEOUT_MS,
} = {}) {
  if (rendering) {
    worker._releaseLease(job, leaseToken, "queued", { readyAt: new Date(Date.now() + BUSY_REQUEUE_MS).toISOString() });
    return;
  }
  const attempt = incrementAndCreateAttempt(job.id, leaseToken, "system", "posse-local", null);
  if (!attempt) {
    logAttemptSkippedStaleLease(job, "system", "Skipped local image render attempt because the lease was stale or expired");
    worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} - lease lost${C.reset}`);
    return;
  }
  const startTime = Date.now();
  rendering = true;
  let progress = null;
  try {
    const payload = worker.parsePayload(job);
    const spec = payload.local_image_render;
    const target = path.resolve(String(payload.output_root || ""), path.basename(String(spec.filename)));
    worker._throwIfKilled(job.id);
    worker.emit(job.id, `${C.cyan}[local image]${C.reset} WI#${job.work_item_id} job #${job.id}: rendering ${spec.filename} (${spec.width}x${spec.height}) with ${spec.model}`);
    // A local render is silent for minutes; say it is still working.
    progress = setInterval(() => {
      worker.emit(job.id, `${C.dim}[local image] job #${job.id}: still rendering ${spec.filename} (${Math.round((Date.now() - startTime) / 60_000)} min)${C.reset}`);
    }, PROGRESS_INTERVAL_MS);
    progress.unref?.();
    const response = await client.images.generate({
      model: spec.model, prompt: spec.prompt, format: "png", size: `${spec.width}x${spec.height}`,
    }, { signal: abortSignal, timeoutMs });
    worker._throwIfKilled(job.id);
    const bytes = Buffer.from(String(response?.data?.[0]?.b64_json || ""), "base64");
    if (bytes.length === 0) throw new Error("the local image model returned no image");
    const replaced = replacePlaceholder(target, bytes, spec.placeholder_sha256);
    worker.emit(job.id, replaced
      ? `${C.green}[local image]${C.reset} WI#${job.work_item_id} job #${job.id}: ${spec.filename} is ready (${Math.round((Date.now() - startTime) / 1000)}s)`
      : `${C.yellow}[local image]${C.reset} WI#${job.work_item_id} job #${job.id}: ${spec.filename} was replaced meanwhile; kept that file`);
    completeAttempt(attempt.attempt.id, { status: "succeeded", duration_ms: Date.now() - startTime, output_chars: bytes.length });
    worker._releaseLease(job, leaseToken, "succeeded");
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
  } catch (err) {
    if (worker._handleDeterministicInterruption(job, attempt.attempt.id, startTime, leaseToken, err)) return;
    const message = `Local image render failed; the placeholder is still in place: ${err?.message || err}`;
    worker.emit(job.id, `${C.red}[local image] WI#${job.work_item_id} job #${job.id}: ${message}${C.reset}`);
    completeAttempt(attempt.attempt.id, { status: "failed", duration_ms: Date.now() - startTime, error_text: message });
    await wrappedJob.setError(message);
    worker._retryOrFail(job, leaseToken, message, { attemptId: attempt.attempt.id });
  } finally {
    clearInterval(progress);
    rendering = false;
  }
}
