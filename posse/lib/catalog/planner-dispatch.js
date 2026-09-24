import { MCP_TRANSPORT_TIMEOUT_MS } from "./mcp.js";
import { SETTING_KEYS } from "./settings.js";
import { SUB_AGENT_LIMITS } from "./sub-agent.js";
import { MODEL_TIERS } from "./model.js";

export const PLANNER_DISPATCH_MODES = Object.freeze({ ROUTER: "router", PLANNER: "planner" });
export const PLANNER_DISPATCH_MODE_VALUES = Object.freeze(Object.values(PLANNER_DISPATCH_MODES));
export const RESEARCH_AGENT_TYPES = Object.freeze(["code", "web"]);
export const PLANNER_RESEARCH_EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh"]);
export const PLANNER_DISPATCH_RETURN_MARGIN_MS = 10_000;

export const PLANNER_DISPATCH_SETTINGS = Object.freeze([
  { key: SETTING_KEYS.PLANNER_DISPATCH_MODE, default: PLANNER_DISPATCH_MODES.ROUTER, options: PLANNER_DISPATCH_MODE_VALUES, description: "Planner-led intake for every repository on this account. Router preserves current behavior; planner lets eligible nontrivial intake skip upfront research and preflight while the planner dispatches bounded code or web research children." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_EFFORT_CEILING, default: "high", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Maximum requested reasoning effort for investigating research children." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_MAX_CHILDREN, default: "2", numeric: { integer: true, min: 1, max: SUB_AGENT_LIMITS.maxBatch }, description: "Maximum research children across one planner call." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_CHILD_TIMEOUT_MS, default: "1200000", numeric: { integer: true, min: 5000, max: MCP_TRANSPORT_TIMEOUT_MS - PLANNER_DISPATCH_RETURN_MARGIN_MS - 1000 }, description: "Research child timeout ceiling in milliseconds, further bounded by the dispatch tool timeout with time reserved for returning results." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_CHILD_MAX_TURNS, default: "24", numeric: { integer: true, min: 1, max: 64 }, description: "Maximum tool/reasoning turns assigned to a research child." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_RESULT_CHARS, default: "12000", numeric: { integer: true, min: 1000, max: 48000 }, description: "Maximum compact research result characters returned per child." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_EXPAND_CHARS, default: "8000", numeric: { integer: true, min: 0, max: 24000 }, description: "Maximum source-brief characters automatically expanded across one planner research batch; zero disables expansion." },
  { key: SETTING_KEYS.PLANNER_DISPATCH_TRIAGE_MAX_TURNS, default: "6", numeric: { integer: true, min: 1, max: 24 }, description: "Prompted planner triage turn budget before choosing whether to request research." },
  // The point of planner-led intake is to spend the expensive model on
  // planning and cheaper models on the bounded reads that feed it.
  { key: SETTING_KEYS.PLANNER_DISPATCH_MODEL_TIER, default: "strong", options: MODEL_TIERS, description: "Model tier for the planner job on planner-led intake." },
  { key: SETTING_KEYS.PLANNER_DISPATCH_REASONING_EFFORT, default: "high", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Reasoning effort for the planner job on planner-led intake; each research child gets the effort the planner requests for it, clamped by the ceiling." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_CHILD_MODEL_TIER, default: "standard", options: MODEL_TIERS, description: "Model tier for investigating research children dispatched by the planner (cheaper than the planner by default)." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_CHILD_REASONING_EFFORT, default: "medium", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Reasoning effort a research child runs at when the planner does not request one; the ceiling still bounds every request." },
  { key: SETTING_KEYS.AGENT_DISPATCH_TOOL_TIMEOUT_SEC, default: "1500", numeric: { integer: true, min: 60, max: Math.floor((MCP_TRANSPORT_TIMEOUT_MS - 1) / 1000) }, description: "Timeout in seconds for the experimental agent-dispatch MCP gate; always below the owner transport deadline." },
// Account-level: the dispatch mode and its budgets describe how this
// operator wants planning to run everywhere, not a property of one clone.
].map((entry) => Object.freeze({
  ...entry,
  ...(entry.numeric ? { numeric: Object.freeze(entry.numeric) } : {}),
})));

export const PLANNER_DISPATCH_SETTING_KEYS = Object.freeze(PLANNER_DISPATCH_SETTINGS.map(({ key }) => key));
