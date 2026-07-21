// @ts-check

import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { atlasMemoryEnabled } from "../../policies/functions/memory-mode.js";

const PROVIDER_ROLE_SET = new Set(PROVIDER_ROLE_NAMES);
const WRITE_ROLES = new Set(["dev", "artificer"]);
const READ_DB_ROLES = new Set(["researcher", "planner", "assessor"]);
const HANDOFF_ROLES = new Set(["researcher", "planner", "dev", "artificer", "assessor"]);

/**
 * Return the dispatcher-owned maximum tool contract for a provider agent.
 * No Job/WI values are accepted here: those belong exclusively to the live
 * owner-side scope binding and may only narrow this role contract.
 *
 * @param {{ role?: string, providerName?: string | null, agentHandoff?: boolean, subAgent?: boolean, coordinationChild?: boolean }} [identity]
 */
export function resolveAgentRoleContract({ role, providerName = null, agentHandoff = false, subAgent = false, coordinationChild = false } = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const normalizedProvider = String(providerName || "").trim().toLowerCase();
  if (!PROVIDER_ROLE_SET.has(normalizedRole)) {
    throw new Error(`Unknown provider agent role: ${normalizedRole || "<empty>"}`);
  }
  const child = coordinationChild === true;
  const projectDbCapability = child
    ? "none"
    : normalizedRole === "dev"
    ? "write"
    : (READ_DB_ROLES.has(normalizedRole) ? "read" : "none");
  return Object.freeze({
    role: normalizedRole,
    providerName: normalizedProvider,
    allowWrite: !child && WRITE_ROLES.has(normalizedRole),
    projectDbCapability,
    projectDbWrite: projectDbCapability === "write",
    needsImageGeneration: !child && normalizedRole === "artificer",
    atlasAvailable: !child,
    atlasGateEnabled: true,
    disableSystemTools: child,
    memoryEnabled: !child && atlasMemoryEnabled(),
    agentHandoff: agentHandoff === true && HANDOFF_ROLES.has(normalizedRole),
    subAgent: !child && subAgent === true && HANDOFF_ROLES.has(normalizedRole),
    coordinationChild: child,
  });
}
