// @ts-check
//
// Deterministic persistence for the researcher's `memories` appendix field.
// The researcher does not spend tool calls on memory.store — durable findings
// ride the structured output (capped per round) and the pipeline writes them
// here when the research job completes. memory.store owns deterministic dedupe
// so re-runs and retries don't multiply entries.

import { callAtlasMemoryAction, getAtlasMemoryClient } from "../../../integrations/functions/atlas-memory.js";
import {
  normalizeResearcherMemories,
  parseResearcherStructuredOutput,
} from "../../../handoff/functions/helpers/researcher-output.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";

export const RESEARCHER_MEMORY_CAP = 2;

/**
 * Persist the researcher's appendix memories. Best-effort: failures are
 * logged and counted, never thrown — memory persistence must not fail a
 * research job.
 *
 * @param {{
 *   output: string,
 *   cwd: string,
 *   workItemId?: number | string | null,
 *   jobId?: number | null,
 *   memoryClient?: any,
 *   memoryAction?: typeof callAtlasMemoryAction,
 * }} args
 * @returns {Promise<{ total: number, stored: number, duplicates: number, failed: number, reason?: string }>}
 */
export async function persistResearcherMemories({
  output,
  cwd,
  workItemId = null,
  jobId = null,
  memoryClient = null,
  memoryAction = callAtlasMemoryAction,
}) {
  const parsed = parseResearcherStructuredOutput(output || "");
  const memories = normalizeResearcherMemories(parsed, RESEARCHER_MEMORY_CAP);
  if (memories.length === 0) return { total: 0, stored: 0, duplicates: 0, failed: 0 };

  const client = memoryClient || await getAtlasMemoryClient({ cwd });
  if (!client?.ok) {
    return {
      total: memories.length,
      stored: 0,
      duplicates: 0,
      failed: memories.length,
      reason: client?.skipped || "memory_client_unavailable",
    };
  }

  let stored = 0;
  let duplicates = 0;
  let failed = 0;
  for (const memory of memories) {
    try {
      const result = await memoryAction("memory.store", {
        title: memory.title,
        content: memory.content,
        ...(memory.symbolIds.length > 0 ? { symbolIds: memory.symbolIds } : {}),
        ...(memory.fileRelPaths.length > 0 ? { fileRelPaths: memory.fileRelPaths } : {}),
      }, { memoryClient: client });
      if (result?.json?.deduplicated === true) duplicates += 1;
      else if (result?.ok) stored += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      log?.debug?.("atlas", "Researcher memory persistence failed for one entry", {
        job_id: jobId,
        work_item_id: workItemId,
        title: memory.title.slice(0, 80),
        error: String(/** @type {any} */ (err)?.message || err).slice(0, 200),
      });
    }
  }
  return { total: memories.length, stored, duplicates, failed };
}
