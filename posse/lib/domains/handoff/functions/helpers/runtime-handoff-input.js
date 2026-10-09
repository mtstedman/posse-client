import { AGENT_HANDOFF_PROFILE_POLICY, AGENT_HANDOFF_PROTOCOL } from "../../../../catalog/handoff.js";
import { RESEARCH_CHILD_PROFILE } from "../../../../catalog/sub-agent.js";
import { RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE } from "../../../../catalog/observation.js";
import { recordObservation } from "../../../observability/functions/observations.js";

// The report fields the research child's agent_handoff schema issues.
const RESEARCH_CHILD_REPORT_KEYS = Object.freeze(["summary", "claims"]);

// A child that spelled its report fields beside outcome instead of inside
// report keeps the same content; wrapping them spares it a full-context turn.
function flatResearchChildReport(args) {
  if (args.report != null
    || (typeof args.summary !== "string" && !Array.isArray(args.claims))) return null;
  const wrappedKeys = RESEARCH_CHILD_REPORT_KEYS.filter((key) => Object.hasOwn(args, key));
  return { wrappedKeys, report: Object.fromEntries(wrappedKeys.map((key) => [key, args[key]])) };
}

// Call only after identifying an investigating child from trusted runtime
// state. The standard researcher keeps its existing handoff contract.
export function expandResearchChildHandoff(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.hasOwn(args, "handoffs")
    || (args.profile != null && args.profile !== RESEARCH_CHILD_PROFILE)) return args;
  const flat = flatResearchChildReport(args);
  if (!flat && (!args.report || typeof args.report !== "object" || Array.isArray(args.report)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args.report)))) return args;
  const wrappedKeys = flat?.wrappedKeys ?? [];
  const ignoredKeys = Object.keys(args)
    .filter((key) => !["outcome", "report", "profile", ...wrappedKeys].includes(key));
  if (flat) recordObservation({
    observation_type: RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE,
    summary: "Wrapped flat research child report fields into report",
    detail: { wrapped_keys: wrappedKeys, ignored_keys: ignoredKeys },
  });
  else if (ignoredKeys.length > 0) recordObservation({
    observation_type: RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE,
    summary: "Ignored extra research child handoff envelope fields",
    detail: { ignored_keys: ignoredKeys },
  });
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile: RESEARCH_CHILD_PROFILE,
    outcome: args.outcome,
    handoffs: [{ target: { kind: "parent", role: "$parent" }, report: flat?.report ?? args.report }],
  };
}

// Rejection text for a research child handoff that still carries another
// profile after expansion: the envelope to send and the shape that arrived,
// bounded and without echoing report content.
export function researchChildHandoffMismatch(args) {
  const plain = args && typeof args === "object" && !Array.isArray(args);
  const profile = plain && args.profile != null ? String(args.profile).slice(0, 60) : "none";
  const keys = plain ? Object.keys(args).slice(0, 8).map((key) => key.slice(0, 24)).join(", ") : "";
  return `Research child must return a ${RESEARCH_CHILD_PROFILE} report: call agent_handoff with `
    + `{"outcome":"${AGENT_HANDOFF_PROFILE_POLICY[RESEARCH_CHILD_PROFILE].outcomes.join("|")}","report":{"summary":"...","claims":[...]}} `
    + `(received profile ${profile}; top-level keys ${keys || "none"})`;
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
