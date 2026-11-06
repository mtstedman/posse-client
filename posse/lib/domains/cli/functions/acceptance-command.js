import { readAcceptance, recordAcceptanceDecision } from "../../queue/functions/acceptance.js";

export function runAcceptanceCommand(argv = []) {
  const [action = "show", id, key, ...rest] = argv;
  const workItemId = Number(id);
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) throw new Error("Usage: posse acceptance show|require|bind|waive <wi-id> [contract:requirement] [receipt-id] [reason]");
  if (action === "show") return readAcceptance(workItemId);
  const artifactId = action === "bind" ? Number(rest.shift()) : null;
  return recordAcceptanceDecision(workItemId, { action, key, artifactId, reason: rest.join(" ") });
}
