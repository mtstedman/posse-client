export const REGISTERED_AGENT_PROTOCOL = "posse.registered_agent_request.v1";
export const AGENT_PROGRESS_PROTOCOL = "posse.agent_progress.v1";
// Optional client features `posse-agent version --json` advertises.
export const REGISTERED_AGENT_CAPABILITIES = Object.freeze(["progress"]);
export const REGISTERED_AGENT_OPERATIONS = Object.freeze(["chat", "run"]);
export const REGISTERED_AGENT_MAX_CONTEXT_BYTES = 256 * 1024;
export const REGISTERED_AGENT_MAX_REPLY_BYTES = 1024 * 1024;
export const REGISTERED_AGENT_RETRYABLE_CODES = Object.freeze(["agent_request_busy", "agent_session_busy", "owner_unavailable"]);
// Receipt statuses that end a registered request. A receipt in any other
// status (today only "active") is still running inside the owner.
export const REGISTERED_AGENT_TERMINAL_STATUSES = Object.freeze(["done", "failed", "needs_confirmation"]);

// The machine-wide registered owner: its account, systemd units, launcher
// and root-owned configuration.
export const SYSTEM_REGISTERED_AGENT = Object.freeze({
  account: "posse-agent",
  clientGroup: "posse-agent-clients",
  ownerService: "posse-registered-agent.service",
  gatewayService: "posse-registered-agent-gateway.service",
  unitDir: "/etc/systemd/system",
  launcher: "/usr/local/bin/posse-agent",
  configDir: "/etc/posse-agent",
  ownerEnv: "/etc/posse-agent/owner.env",
  dataDir: "/var/lib/posse-agent",
  // The owner's sockets (RuntimeDirectory=posse-agent).
  runtimeDir: "/run/posse-agent",
  automationDb: "/var/lib/posse-agent/automation.db",
});
// owner.env may not override what the owner unit itself pins.
export const SYSTEM_OWNER_ENV_RESERVED_KEYS = Object.freeze(["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "POSSE_NATIVE_BIN_ROOT",
  "POSSE_ACCOUNT_DB_PATH", "POSSE_AUTOMATION_DATA_DIR", "POSSE_AUTOMATION_DB_PATH",
  "POSSE_AUTOMATION_SOCKET", "POSSE_REGISTERED_AGENT_SOCKET", "POSSE_REGISTERED_AGENT_SOCKET_MODE",
  "POSSE_AGENT_GATEWAY_BACKEND", "POSSE_AGENT_GATEWAY_KEY"]);
