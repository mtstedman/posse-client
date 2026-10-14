import { getDb } from "../../../shared/storage/functions/index.js";
import { listWorkItems, runInTransaction, cancelWorkItemJobs, updateWorkItemStatus, updateWorkItemMetadata, forceUpdateJobStatus } from "./queue-store.js";
import { storeArtifact } from "./artifacts.js";

// Commit the operator's stop intent before asynchronous Git cleanup. A failed
// cleanup retains recovery evidence, never runnable work for the next boot.
export function prepareQueueClear() {
  return runInTransaction(() => {
    const workItems = listWorkItems();
    const recovery = storeArtifact({ artifact_type: "log", mime_type: "application/json",
      content_json: { operation: "clear", work_items: workItems } });
    for (const wi of workItems) {
      let metadata;
      try { metadata = JSON.parse(wi.metadata_json || "{}"); } catch { metadata = {}; }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
      if (metadata.iterate || metadata.workflow_mode) {
        updateWorkItemMetadata(wi.id, { ...metadata, iteration: { ...metadata.iteration, active: false } });
      }
      cancelWorkItemJobs(wi.id);
      updateWorkItemStatus(wi.id, "canceled");
    }
    // Include repo-level jobs and gates created by cancellation cascades.
    for (const job of getDb().prepare("SELECT id FROM jobs WHERE status NOT IN ('succeeded', 'canceled')").all()) {
      forceUpdateJobStatus(job.id, "canceled");
    }
    return { workItems, recovery };
  });
}
