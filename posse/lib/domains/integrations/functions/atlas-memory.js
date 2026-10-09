import fs from "node:fs";

import { ledgerDbPath } from "../../atlas/functions/v2/runtime-paths.js";
import {
  getAtlasIntegrationConfig,
  resolveAtlasRepoTarget,
} from "./atlas.js";
import { executeEmbeddedAtlasTool } from "./atlas-embedded.js";

export const HANDOFF_MEMORY_PREFETCH_ORIGIN = "handoff_memory_prefetch";

function parseToolResultJson(result) {
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("")
    : "";
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// The ledgers the embedded runtime would open for this target; memory lives
// beside the ledger, so a target with none has no memory to surface.
function hasAtlasLedger({ cwd, config, repo }) {
  return [
    config?.atlasV2LedgerDbPath,
    config?.ledgerDbPath,
    ledgerDbPath(repo.repoPath),
    cwd ? ledgerDbPath(cwd) : null,
  ].some((candidate) => {
    if (!candidate || typeof candidate !== "string") return false;
    try { return fs.existsSync(candidate); } catch { return false; }
  });
}

export async function getAtlasMemoryClient({ cwd = process.cwd(), config = getAtlasIntegrationConfig(), origin = "agent" } = {}) {
  if (!config?.enabled) return { ok: false, skipped: "atlas_disabled" };
  const repo = resolveAtlasRepoTarget({ cwd, config });
  if (!repo?.repoId) return { ok: false, skipped: "repo_not_ready" };
  // Expose the resolved target on every return so tests (and callers) can verify the
  // canonical repo was selected even when the runtime can't start.
  const repoInfo = { repoId: repo.repoId, repoPath: repo.repoPath, repoSource: repo.source };
  // Handoff prefetch is best-effort: a directory nested in a repo (an
  // artifact output dir) resolves as its own target but has no ledger.
  if (origin === HANDOFF_MEMORY_PREFETCH_ORIGIN && !hasAtlasLedger({ cwd, config, repo })) {
    return { ok: false, skipped: "repo_not_ready", ...repoInfo };
  }
  const call = async (action, args = {}) => {
    const text = await executeEmbeddedAtlasTool(action, { repoId: repo.repoId, ...args }, {
      cwd,
      config,
      origin,
    });
    return {
      isError: /^Error:/i.test(String(text || "")),
      content: [{ type: "text", text: String(text || "") }],
    };
  };
  return { ok: true, ...repoInfo, backend: "atlas-v2", call };
}

export async function callAtlasMemoryAction(action, args = {}, opts = {}) {
  const client = opts.memoryClient || await getAtlasMemoryClient(opts);
  if (!client?.ok || typeof client.call !== "function") {
    return { ok: false, skipped: client?.skipped || "memory_client_unavailable", json: null, raw: null };
  }
  const raw = await client.call(action, args);
  return { ok: !raw?.isError, json: parseToolResultJson(raw), raw };
}

export { parseToolResultJson };
