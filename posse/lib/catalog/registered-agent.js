export const REGISTERED_AGENT_PROTOCOL = "posse.registered_agent_request.v1";
export const REGISTERED_AGENT_OPERATIONS = Object.freeze(["chat", "run"]);
export const REGISTERED_AGENT_TRUST_LEVELS = Object.freeze(["operator_only", "application_safe"]);
export const REGISTERED_AGENT_MAX_CONTEXT_BYTES = 256 * 1024;
export const REGISTERED_AGENT_MAX_REPLY_BYTES = 1024 * 1024;
export const REGISTERED_AGENT_RETRYABLE_CODES = Object.freeze(["agent_request_busy", "agent_session_busy", "owner_unavailable"]);
