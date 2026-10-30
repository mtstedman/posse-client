import { MCP_TRANSPORT_TIMEOUT_MS } from "./mcp.js";
import { SUB_AGENT_LIMITS } from "./sub-agent.js";
import { MODEL_TIERS } from "./model.js";

// Dispatched research isolates bounded reads and fetches while the planner
// keeps judgment. Its price depends on the configured models, which may be
// identical for parent and child. The configured default is never
// the strong tier and a child never inherits the planner's model. The planner
// may request a stronger tier for a code child that needs deep multi-file
// reasoning, for at most RESEARCH_CHILD_STRONG_LIMIT children per planner
// call; web children always run on the configured child tier.
export const RESEARCH_CHILD_DEFAULT_MODEL_TIERS = Object.freeze(MODEL_TIERS.filter((tier) => tier !== "strong"));
export const RESEARCH_CHILD_REQUEST_MODEL_TIERS = MODEL_TIERS;
export const RESEARCH_CHILD_FALLBACK_MODEL_TIER = "standard";
export const RESEARCH_CHILD_STRONG_LIMIT = 1;

export const PLANNER_DISPATCH_MODES = Object.freeze({ ROUTER: "router", PLANNER: "planner" });
export const PLANNER_DISPATCH_MODE_VALUES = Object.freeze(Object.values(PLANNER_DISPATCH_MODES));
export const RESEARCH_AGENT_TYPES = Object.freeze(["code", "web"]);
export const PLANNER_RESEARCH_EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh"]);
export const PLANNER_DISPATCH_RETURN_MARGIN_MS = 10_000;

export const PLANNER_DISPATCH_SETTINGS = Object.freeze([
  { key: "planner_dispatch_mode", default: PLANNER_DISPATCH_MODES.PLANNER, options: PLANNER_DISPATCH_MODE_VALUES, description: "Planner-led intake for every repository on this account. Planner is the default: eligible nontrivial intake skips upfront research and preflight while the planner dispatches bounded code or web research children. Router restores the upfront research/preflight flow." },
  { key: "planner_research_effort_ceiling", default: "high", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Maximum requested reasoning effort for investigating research children." },
  { key: "planner_research_max_children", default: "5", numeric: { integer: true, min: 1, max: SUB_AGENT_LIMITS.maxResearchBatch }, description: "Maximum research children across one planner call, dispatched together or across follow-up batches." },
  // The child lane is shared by every concurrent planner on this instance; at
  // the defaults (5 children x 3 scheduler slots) a third planner's batch
  // would wait behind the first two, so operators running more planners in
  // parallel raise this rather than lowering per-plan research.
  { key: "planner_research_max_active_children", default: String(SUB_AGENT_LIMITS.maxActiveChildren), numeric: { integer: true, min: 1, max: 32 }, description: "Research children that may run at the same time across every concurrent planner call on this instance (one shared lane)." },
  { key: "planner_research_child_timeout_ms", default: "1200000", numeric: { integer: true, min: 5000, max: MCP_TRANSPORT_TIMEOUT_MS - PLANNER_DISPATCH_RETURN_MARGIN_MS - 1000 }, description: "Research child timeout ceiling in milliseconds, further bounded by the dispatch tool timeout with time reserved for returning results." },
  { key: "planner_research_child_max_turns", default: "24", numeric: { integer: true, min: 1, max: 64 }, description: "Maximum tool/reasoning turns assigned to a research child." },
  { key: "planner_research_result_chars", default: "12000", numeric: { integer: true, min: 1000, max: 48000 }, description: "Maximum compact research result characters returned per child." },
  { key: "planner_research_expand_chars", default: "8000", numeric: { integer: true, min: 0, max: 24000 }, description: "Maximum source-brief characters automatically expanded across one planner research batch; zero disables expansion." },
  { key: "planner_dispatch_triage_max_turns", default: "6", numeric: { integer: true, min: 1, max: 24 }, description: "Prompted planner-owned read budget for the direct/simple path, including bounded orientation before the research decision." },
  // The point of planner-led intake is to spend the expensive model on
  // planning and cheaper models on the bounded reads that feed it.
  { key: "planner_dispatch_model_tier", default: "strong", options: MODEL_TIERS, description: "Model tier for the planner job on planner-led intake." },
  { key: "planner_dispatch_reasoning_effort", default: "high", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Reasoning effort for the planner job on planner-led intake; each research child gets the effort the planner requests for it, clamped by the ceiling." },
  { key: "planner_research_child_model_tier", default: "standard", options: RESEARCH_CHILD_DEFAULT_MODEL_TIERS, description: "Default model tier for research children dispatched by the planner: cheap or standard. Configured tiers may resolve to the same model as the planner. The planner may request strong for one child per planner call; further strong requests run on this tier." },
  { key: "planner_research_child_reasoning_effort", default: "medium", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Reasoning effort a research child runs at when the planner does not request one; the ceiling still bounds every request." },
  { key: "agent_dispatch_tool_timeout_sec", default: "1500", numeric: { integer: true, min: 60, max: Math.floor((MCP_TRANSPORT_TIMEOUT_MS - 1) / 1000) }, description: "Timeout in seconds for the experimental agent-dispatch MCP gate; always below the owner transport deadline." },
// Account-level: the dispatch mode and its budgets describe how this
// operator wants planning to run everywhere, not a property of one clone.
].map((entry) => Object.freeze({
  ...entry,
  ...(entry.numeric ? { numeric: Object.freeze(entry.numeric) } : {}),
})));

export const PLANNER_DISPATCH_SETTING_KEYS = Object.freeze(PLANNER_DISPATCH_SETTINGS.map(({ key }) => key));
