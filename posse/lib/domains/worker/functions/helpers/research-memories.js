// @ts-check
//
// Deterministic persistence for the researcher's `memories` appendix field.
// The researcher does not spend tool calls on memory.store — durable findings
// ride the structured output (capped per round) and the pipeline writes them
// here when the research job completes, with a title-level dup check so
// re-runs and retries don't multiply entries.

import { callAtlasMemoryAction, getAtlasMemoryClient } from "../../../integrations/functions/atlas-memory.js";
import {
  normalizeResearcherMemories,
  parseResearcherStructuredOutput,
} from "../../../handoff/functions/helpers/researcher-output.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";

export const RESEARCHER_MEMORY_CAP = 5;
const RESEARCH_MEMORY_TAG = "posse-research";
const RESEARCH_MEMORY_CONFIDENCE = 0.7;

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
      const existing = await memoryAction("memory.query", {
        query: memory.title.slice(0, 220),
        types: [memory.type],
        tags: [RESEARCH_MEMORY_TAG],
        limit: 3,
      }, { memoryClient: client }).catch(() => null);
      const duplicate = Array.isArray(existing?.json?.memories)
        ? existing.json.memories.find((entry) => String(entry?.title || "").trim().toLowerCase() === memory.title.toLowerCase())
        : null;
      if (duplicate) {
        duplicates += 1;
        continue;
      }
      const result = await memoryAction("memory.store", {
        type: memory.type,
        title: memory.title,
        content: memory.content,
        tags: [
          RESEARCH_MEMORY_TAG,
          ...(workItemId != null && workItemId !== "" ? [`wi-${workItemId}`] : []),
        ],
        confidence: RESEARCH_MEMORY_CONFIDENCE,
        ...(memory.symbolIds.length > 0 ? { symbolIds: memory.symbolIds } : {}),
        ...(memory.fileRelPaths.length > 0 ? { fileRelPaths: memory.fileRelPaths } : {}),
      }, { memoryClient: client });
      if (result?.ok) stored += 1;
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
