// @ts-check

import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { atlasMemoryEnabled } from "../../policies/functions/memory-mode.js";

const PROVIDER_ROLE_SET = new Set(PROVIDER_ROLE_NAMES);
/**
 * Return the runtime capabilities for Remote to authorize for a provider agent.
 * No Job/WI values are accepted here: those belong exclusively to the live
 * owner-side scope binding and may only narrow this role contract.
 *
 * @param {{ role?: string, providerName?: string | null, agentHandoff?: boolean, agentHandoffReportOnly?: boolean, subAgent?: boolean, dispatchAgent?: boolean, webResearchHandoff?: boolean, finalReview?: boolean, researchInvestigation?: boolean, coordinationChild?: boolean, atlasAvailable?: boolean }} [identity]
 */
export function resolveAgentRoleContract({ role, providerName = null, agentHandoff = false, agentHandoffReportOnly = false, subAgent = false, dispatchAgent = false, webResearchHandoff = false, finalReview = false, researchInvestigation = false, coordinationChild = false, atlasAvailable = true } = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const normalizedProvider = String(providerName || "").trim().toLowerCase();
  if (!PROVIDER_ROLE_SET.has(normalizedRole)) {
    throw new Error(`Unknown provider agent role: ${normalizedRole || "<empty>"}`);
  }
  const child = coordinationChild === true;
  // These describe runtime support. Remote owns role-specific permission;
  // the signed response and the live Job scope supply execution authority.
  const projectDbCapability = child ? "none" : "write";
  return Object.freeze({
    role: normalizedRole,
    providerName: normalizedProvider,
    allowWrite: !child,
    projectDbCapability,
    projectDbWrite: projectDbCapability === "write",
    needsImageGeneration: !child,
    atlasAvailable: !child && atlasAvailable !== false,
    atlasGateEnabled: true,
    disableSystemTools: child,
    memoryEnabled: !child && atlasMemoryEnabled(),
    agentHandoff: agentHandoff === true,
    agentHandoffReportOnly: agentHandoff === true
      && agentHandoffReportOnly === true,
    subAgent: !child && subAgent === true,
    dispatchAgent: !child && dispatchAgent === true,
    webResearchHandoff: !child && webResearchHandoff === true,
    // The developer requests reviews; its reviewer (an assessor call flagged
    // with final_review_v1) reports and waits with the same tool.
    finalReview: !child && finalReview === true && agentHandoff === true,
    researchInvestigation: !child && researchInvestigation === true,
    coordinationChild: child,
  });
}
