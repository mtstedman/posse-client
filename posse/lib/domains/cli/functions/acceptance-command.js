import { readAcceptance, recordAcceptanceDecision, requireAllAcceptanceRequirements } from "../../queue/functions/acceptance.js";
import { ACCEPTANCE_REQUIRE_ALL_ACTION } from "../../../catalog/acceptance.js";

export function runAcceptanceCommand(argv = []) {
  const [action = "show", id, key, ...rest] = argv;
  const workItemId = Number(id);
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) throw new Error("Usage: posse acceptance show|require|require-all|bind|waive <wi-id> [contract:requirement] [receipt-id] [reason]");
  if (action === "show") return readAcceptance(workItemId);
  if (action === ACCEPTANCE_REQUIRE_ALL_ACTION) {
    if (key != null) throw new Error("Usage: posse acceptance require-all <wi-id>");
    return requireAllAcceptanceRequirements(workItemId);
  }
  const artifactId = action === "bind" ? Number(rest.shift()) : null;
  return recordAcceptanceDecision(workItemId, { action, key, artifactId, reason: rest.join(" ") });
}
