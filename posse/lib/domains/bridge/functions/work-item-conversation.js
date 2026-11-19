// work_item.conversation: the bridge face of projectAgentConversation. The
// detail tier is decided here from the transport, never from the client:
// only Bossy's loopback HTTP path (local token, loopback peer) gets `local`;
// WebSocket, LAN and relay clients get `remote` (decision D1). A local
// client may still ask for `remote`.
import { getDb } from "../../../shared/storage/functions/index.js";
import { projectAgentConversation, resolveConversationTier } from "../../conversation/functions/conversation-projection.js";
import { normalizeRepositoryPath, observedAt, ownerGeneration } from "./work-item-feed.js";

export function projectWorkItemConversation(args = {}, context = {}) {
  if (typeof args.repo_path === "string" && args.repo_path.trim()
    && normalizeRepositoryPath(args.repo_path) !== normalizeRepositoryPath(context.projectDir || process.cwd())) {
    return { ok: false, reason: "repository_mismatch" };
  }
  const db = context.db || getDb();
  return projectAgentConversation({
    work_item_id: args.work_item_id,
    job_id: args.job_id,
    agent_call_id: args.agent_call_id,
    before: args.before,
    limit: args.limit,
    tier: resolveConversationTier(args.tier, context),
  }, { db, observedAt: observedAt(context), ownerGeneration: ownerGeneration(db) });
}
