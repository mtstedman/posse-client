import { AGENT_HANDOFF_PROFILE_POLICY, AGENT_HANDOFF_PROTOCOL } from "../../../../catalog/handoff.js";
import { RESEARCH_CHILD_PROFILE } from "../../../../catalog/sub-agent.js";
import { RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE } from "../../../../catalog/observation.js";
import { recordObservation } from "../../../observability/functions/observations.js";

// Call only after identifying an investigating child from trusted runtime
// state. The standard researcher keeps its existing handoff contract.
export function expandResearchChildHandoff(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || !args.report || typeof args.report !== "object" || Array.isArray(args.report)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args.report))
    || Object.hasOwn(args, "handoffs")
    || (args.profile != null && args.profile !== RESEARCH_CHILD_PROFILE)) return args;
  const ignoredKeys = Object.keys(args).filter((key) => !["outcome", "report", "profile"].includes(key));
  if (ignoredKeys.length > 0) recordObservation({
    observation_type: RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE,
    summary: "Ignored extra research child handoff envelope fields",
    detail: { ignored_keys: ignoredKeys },
  });
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
