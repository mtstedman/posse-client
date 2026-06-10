import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { callAtlasMemoryAction } from "../../integrations/functions/atlas-memory.js";
import { logEvent } from "../../queue/functions/index.js";

function usage() {
  return [
    "",
    "  Usage:",
    "    posse admin memory note <memoryId>",
    "    posse admin memory suppress <memoryId>",
    "    posse admin memory correct <memoryId> <replacement guidance>",
    "",
    "  Aliases:",
    "    reinforce -> note",
    "    expire -> suppress",
    "",
  ].join("\n");
}

function recordFeedback(action, memoryId, detail = null) {
  try {
    logEvent({
      event_type: EVENT_TYPES.KAIZEN_MEMORY_FEEDBACK,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Memory ${action}: ${memoryId}`,
      event_json: JSON.stringify({
        action,
        memory_id: memoryId,
        detail,
        review_visible: true,
      }),
    });
  } catch {
    // Feedback logging is best effort; the command result still matters.
  }
}

export async function runMemoryAdminCommand(args = [], { cwd = process.cwd(), C = { green: "", yellow: "", red: "", dim: "", reset: "" } } = {}) {
  const [actionRaw, memoryIdRaw, ...rest] = args;
  const action = String(actionRaw || "").trim().toLowerCase();
  const memoryId = String(memoryIdRaw || "").trim();
  if (!action || !memoryId || !["note", "reinforce", "suppress", "expire", "correct"].includes(action)) {
    console.log(usage());
    return false;
  }

  if (action === "note" || action === "reinforce") {
    recordFeedback("note", memoryId, action === "reinforce" ? { alias: "reinforce" } : null);
    console.log(`  ${C.green}Recorded review note for memory ${memoryId}; ATLAS confidence was not changed.${C.reset}`);
    return true;
  }

  if (action === "suppress" || action === "expire") {
    const resolvedAction = "suppress";
    const result = await callAtlasMemoryAction("memory.remove", {
      memoryId,
      deleteFile: false,
    }, { cwd }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!result?.ok) {
      console.log(`  ${C.red}Failed to ${resolvedAction} memory ${memoryId}: ${result?.error || result?.skipped || "ATLAS memory unavailable"}${C.reset}`);
      return false;
    }
    recordFeedback(resolvedAction, memoryId, action === "expire" ? { alias: "expire" } : null);
    console.log(`  ${C.green}Suppressed memory ${memoryId}.${action === "expire" ? ` ${C.dim}(expire is an alias for suppress)${C.reset}` : C.reset}`);
    return true;
  }

  const replacement = rest.join(" ").trim();
  if (!replacement) {
    console.log(`  ${C.yellow}Correction text is required.${C.reset}`);
    console.log(usage());
    return false;
  }
  const stored = await callAtlasMemoryAction("memory.store", {
    type: "decision",
    title: `Correction for ${memoryId}`.slice(0, 120),
    content: [
      `Correction for prior memory ${memoryId}:`,
      "",
      replacement,
      "",
      "Source: human review memory correction.",
    ].join("\n"),
    tags: ["posse-kaizen", "correction"],
    confidence: 0.95,
  }, { cwd }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!stored?.ok) {
    console.log(`  ${C.red}Failed to store correction: ${stored?.error || stored?.skipped || "ATLAS memory unavailable"}${C.reset}`);
    return false;
  }
  await callAtlasMemoryAction("memory.remove", { memoryId, deleteFile: false }, { cwd }).catch(() => null);
  recordFeedback("correct", memoryId, replacement);
  console.log(`  ${C.green}Stored correction and suppressed old memory ${memoryId}.${C.reset}`);
  return true;
}
