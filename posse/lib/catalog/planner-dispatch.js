import { MCP_TRANSPORT_TIMEOUT_MS } from "./mcp.js";
import { SETTING_KEYS } from "./settings.js";
import { SUB_AGENT_LIMITS } from "./sub-agent.js";

export const PLANNER_DISPATCH_MODES = Object.freeze({ ROUTER: "router", PLANNER: "planner" });
export const PLANNER_DISPATCH_MODE_VALUES = Object.freeze(Object.values(PLANNER_DISPATCH_MODES));
export const RESEARCH_AGENT_TYPES = Object.freeze(["code", "web"]);
export const PLANNER_RESEARCH_EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh"]);
export const PLANNER_DISPATCH_RETURN_MARGIN_MS = 10_000;

export const PLANNER_DISPATCH_SETTINGS = Object.freeze([
  { key: SETTING_KEYS.PLANNER_DISPATCH_MODE, default: PLANNER_DISPATCH_MODES.ROUTER, options: PLANNER_DISPATCH_MODE_VALUES, description: "Experimental planner-led intake. Router preserves current behavior; planner skips upfront research and preflight and permits bounded code or web research when coordination is subagents." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_EFFORT_CEILING, default: "high", options: PLANNER_RESEARCH_EFFORT_VALUES, description: "Maximum requested reasoning effort for investigating research children." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_MAX_CHILDREN, default: "2", numeric: { integer: true, min: 1, max: SUB_AGENT_LIMITS.maxBatch }, description: "Maximum research children across one planner call." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_CHILD_TIMEOUT_MS, default: "1200000", numeric: { integer: true, min: 5000, max: MCP_TRANSPORT_TIMEOUT_MS - PLANNER_DISPATCH_RETURN_MARGIN_MS - 1000 }, description: "Research child timeout ceiling in milliseconds, further bounded by the dispatch tool timeout with time reserved for returning results." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_CHILD_MAX_TURNS, default: "24", numeric: { integer: true, min: 1, max: 64 }, description: "Maximum tool/reasoning turns assigned to a research child." },
  { key: SETTING_KEYS.PLANNER_RESEARCH_RESULT_CHARS, default: "12000", numeric: { integer: true, min: 1000, max: 48000 }, description: "Maximum compact research result characters returned per child." },
  { key: SETTING_KEYS.PLANNER_DISPATCH_TRIAGE_MAX_TURNS, default: "6", numeric: { integer: true, min: 1, max: 24 }, description: "Prompted planner triage turn budget before choosing whether to request research." },
  { key: SETTING_KEYS.AGENT_DISPATCH_TOOL_TIMEOUT_SEC, default: "1500", numeric: { integer: true, min: 60, max: Math.floor((MCP_TRANSPORT_TIMEOUT_MS - 1) / 1000) }, description: "Timeout in seconds for the experimental agent-dispatch MCP gate; always below the owner transport deadline." },
].map((entry) => Object.freeze({
  ...entry,
  scope: "repo",
  ...(entry.numeric ? { numeric: Object.freeze(entry.numeric) } : {}),
})));

export const PLANNER_DISPATCH_SETTING_KEYS = Object.freeze(PLANNER_DISPATCH_SETTINGS.map(({ key }) => key));
