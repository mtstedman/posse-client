import { AGENT_HANDOFF_PROFILE_POLICY, AGENT_HANDOFF_PROTOCOL } from "../../../../catalog/handoff.js";
import { RESEARCH_CHILD_PROFILE } from "../../../../catalog/sub-agent.js";

// Call only after identifying an investigating child from trusted runtime
// state. The standard researcher keeps its existing handoff contract.
export function expandResearchChildHandoff(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || !Object.hasOwn(args, "report")
    || Object.keys(args).some((key) => !["outcome", "report"].includes(key))) return args;
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile: RESEARCH_CHILD_PROFILE,
    outcome: args.outcome,
    handoffs: [{ target: { kind: "parent", role: "$parent" }, report: args.report }],
  };
}

// Completion forms already synthesize their metadata. Semantic envelopes and
// flat researcher reports need it before their existing normalizers run.
export function bindHandoffMetadata(args, profile) {
  if (!profile || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const flatResearchReport = Object.hasOwn(args, "summary")
    && AGENT_HANDOFF_PROFILE_POLICY[profile]?.roles.includes("researcher");
  if (!Array.isArray(args.handoffs) && !flatResearchReport) return args;
  return {
    ...args,
    ...(args.profile == null ? { profile } : {}),
    ...(Array.isArray(args.handoffs) && args.protocol == null ? { protocol: AGENT_HANDOFF_PROTOCOL } : {}),
  };
}
