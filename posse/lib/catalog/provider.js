// Provider-domain catalogue.
//
// Provider identifiers, labels, and the role registry that maps job types to
// the role responsible for spawning, executing, and assessing them.

export const PROVIDER_OPTIONS = Object.freeze(["claude", "openai", "codex", "grok", "copilot", "posse-local"]);

export const PROVIDER_LABELS = Object.freeze({
  claude: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  grok: "Grok",
  copilot: "Copilot",
  "posse-local": "Local (Qwen / Gemma)",
});

export const PROVIDER_ROLE_NAMES = Object.freeze([
  "dev",
  "artificer",
  "researcher",
  "planner",
  "preflight",
  "assessor",
  "delegator",
]);

export const DELEGATION_PROVIDER_ROLE_NAMES = Object.freeze(
  PROVIDER_ROLE_NAMES.filter((role) => role !== "preflight"),
);

export const JOB_TYPE_ROLE_REGISTRY = Object.freeze({
  research: Object.freeze({ provider: "researcher", delegation: "researcher", worker: "researcher", spawn: "researcher" }),
  plan: Object.freeze({ provider: "planner", delegation: "planner", worker: "planner", spawn: "planner" }),
  delegate: Object.freeze({ provider: "delegator", delegation: "delegator", worker: "delegator", spawn: "delegator" }),
  dev: Object.freeze({ provider: "dev", delegation: "dev", worker: "dev", spawn: "dev" }),
  fix: Object.freeze({ provider: "dev", delegation: "dev", worker: "dev", spawn: "fix" }),
  artificer: Object.freeze({ provider: "artificer", delegation: "artificer", worker: "artificer", spawn: "artificer" }),
  assess: Object.freeze({ provider: "assessor", delegation: "assessor", worker: "assessor", spawn: "assessor" }),
  summarize: Object.freeze({ provider: "planner", delegation: "planner", worker: "planner", spawn: "summary" }),
  preflight: Object.freeze({ provider: "preflight", delegation: "preflight", worker: "preflight", spawn: "preflight" }),
  human_input: Object.freeze({ provider: "human", delegation: null, worker: "human", spawn: null }),
  promote: Object.freeze({ provider: "promote", delegation: null, worker: "system", spawn: null }),
  atlas_warm: Object.freeze({ provider: "atlas", delegation: null, worker: "atlas-warm", spawn: null }),
});

export const JOB_TYPE_TO_PROVIDER_ROLE = Object.freeze(Object.fromEntries(
  Object.entries(JOB_TYPE_ROLE_REGISTRY).map(([jobType, roles]) => [jobType, roles.provider]),
));
