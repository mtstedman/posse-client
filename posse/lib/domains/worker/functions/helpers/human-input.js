// lib/worker/helpers/human-input.js
//
// Human-input handler for interactive questions surfaced through the display.
// Manages waiting state, timeout behavior, and abort-aware answer collection.

import { C } from "../../../../shared/format/functions/colors.js";
import { updateJobStatus } from "../../../queue/functions/index.js";

export async function runHumanInputHandler(worker, job, abortSignal = null) {
  const payload = worker.parsePayload(job);
  const questions = payload.questions || [`Human input needed for: ${job.title}`];
  const context = payload.context || "";

  if (worker.display && worker.display.askQuestions) {
    updateJobStatus(job.id, "waiting_on_human");
    const DISPLAY_TIMEOUT_MS = 3600 * 1000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Human input timed out after ${DISPLAY_TIMEOUT_MS / 1000}s - no response from display`)), DISPLAY_TIMEOUT_MS);
    });
    const aborted = worker._abortPromise(job.id, abortSignal);
    try {
      const answers = await Promise.race([
        worker.display.askQuestions(job.id, questions, context, job.work_item_id),
        timeout,
        ...(aborted ? [aborted] : []),
      ]);
      return JSON.stringify({ questions, answers });
    } finally {
      clearTimeout(timer);
    }
  }

  updateJobStatus(job.id, "waiting_on_human");
  worker.emit(job.id, `${C.yellow}[human] Needs input: ${questions[0]}${C.reset}`);
  return null;
}
