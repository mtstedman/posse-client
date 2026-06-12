import {
  applyMemoryCorrection,
  applyMemoryFlag,
  applyMemoryNote,
  applyMemorySuppress,
} from "./memory-feedback.js";

function usage() {
  return [
    "",
    "  Usage:",
    "    posse admin memory note <memoryId>",
    "    posse admin memory suppress <memoryId>",
    "    posse admin memory correct <memoryId> <replacement guidance>",
    "    posse admin memory flag <memoryId> [contradicted|anchors_missing|manual] [detail...]",
    "",
    "  Aliases:",
    "    reinforce -> note",
    "    expire -> suppress",
    "",
  ].join("\n");
}

const FLAG_REASONS = new Set(["contradicted", "anchors_missing", "manual"]);

export async function runMemoryAdminCommand(args = [], { cwd = process.cwd(), C = { green: "", yellow: "", red: "", dim: "", reset: "" } } = {}) {
  const [actionRaw, memoryIdRaw, ...rest] = args;
  const action = String(actionRaw || "").trim().toLowerCase();
  const memoryId = String(memoryIdRaw || "").trim();
  if (!action || !memoryId || !["note", "reinforce", "suppress", "expire", "correct", "flag"].includes(action)) {
    console.log(usage());
    return false;
  }

  if (action === "note" || action === "reinforce") {
    applyMemoryNote(memoryId, { detail: action === "reinforce" ? { alias: "reinforce" } : null });
    console.log(`  ${C.green}Recorded review note for memory ${memoryId}; ATLAS confidence was not changed.${C.reset}`);
    return true;
  }

  if (action === "suppress" || action === "expire") {
    const result = await applyMemorySuppress(memoryId, {
      cwd,
      detail: action === "expire" ? { alias: "expire" } : null,
    });
    if (!result.ok) {
      console.log(`  ${C.red}Failed to suppress memory ${memoryId}: ${result.error}${C.reset}`);
      return false;
    }
    console.log(`  ${C.green}Suppressed memory ${memoryId}.${action === "expire" ? ` ${C.dim}(expire is an alias for suppress)${C.reset}` : C.reset}`);
    return true;
  }

  if (action === "flag") {
    const hasExplicitReason = FLAG_REASONS.has(String(rest[0] || "").trim().toLowerCase());
    const reason = hasExplicitReason ? String(rest[0]).trim().toLowerCase() : "manual";
    const detail = rest.slice(hasExplicitReason ? 1 : 0).join(" ").trim() || null;
    const result = await applyMemoryFlag(memoryId, { cwd, reason, detail });
    if (!result.ok) {
      console.log(`  ${C.red}Failed to flag memory ${memoryId}: ${result.error}${C.reset}`);
      return false;
    }
    console.log(`  ${C.green}Flagged memory ${memoryId} stale (${reason}); it stays queryable and correctable.${C.reset}`);
    return true;
  }

  const replacement = rest.join(" ").trim();
  if (!replacement) {
    console.log(`  ${C.yellow}Correction text is required.${C.reset}`);
    console.log(usage());
    return false;
  }
  const result = await applyMemoryCorrection(memoryId, replacement, { cwd });
  if (!result.ok) {
    console.log(`  ${C.red}Failed to store correction: ${result.error}${C.reset}`);
    return false;
  }
  console.log(`  ${C.green}Stored correction and suppressed old memory ${memoryId}.${C.reset}`);
  return true;
}
