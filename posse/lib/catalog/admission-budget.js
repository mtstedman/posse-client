export const BUDGET_PAUSED = "POSSE_BUDGET_PAUSED";
export const BUDGET_STATES = Object.freeze({ RESERVED: "reserved", SETTLED: "settled", UNKNOWN: "unknown" });
export const BUDGET_REASONS = Object.freeze({ SPEND: "spend_threshold", TIME: "time_threshold", UNKNOWN: "unknown_cost", OPERATOR: "operator_pause" });
export const BUDGET_STATE_ACTIONS = Object.freeze(["pause", "resume", "disable"]);
export const BUDGET_USAGE = `posse budget show|${BUDGET_STATE_ACTIONS.join("|")} <wi-id> | configure <wi-id> <usd|-> <reservation-usd|-> <minutes|-> | reconcile <wi-id> <reservation-id> <observed-usd> <reason>`;
