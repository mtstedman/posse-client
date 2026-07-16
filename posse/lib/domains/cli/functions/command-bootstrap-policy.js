// CLI command bootstrap policy.
//
// Keep this table focused on cross-cutting startup behavior. Command-specific
// argument parsing still belongs with the command implementation.

const POLICY_ENTRIES = [
  { name: "help", aliases: ["--help", "-h"], readOnly: true, requiresWritableArtifacts: false },
  { name: "add", requiresWritableArtifacts: true },
  { name: "queue", readOnly: true, requiresWritableArtifacts: false },
  { name: "plan", requiresWritableArtifacts: true },
  { name: "run", requiresWritableArtifacts: true, requiresProvider: true, requiresNativeGit: true, refreshContextAfter: true },
  { name: "go", requiresWritableArtifacts: true, requiresProvider: true, requiresNativeGit: true, refreshContextAfter: true },
  { name: "status", readOnly: true, requiresWritableArtifacts: false },
  { name: "serve", requiresWritableArtifacts: false },
  { name: "health", readOnly: true, requiresWritableArtifacts: false },
  { name: "dashboard", readOnly: true, requiresWritableArtifacts: false },
  { name: "doctor", requiresWritableArtifacts: false },
  { name: "update", requiresWritableArtifacts: false },
  { name: "review", requiresWritableArtifacts: true, refreshContextAfter: true },
  { name: "inject", requiresWritableArtifacts: true },
  { name: "ask", requiresWritableArtifacts: true },
  { name: "image", requiresWritableArtifacts: true },
  { name: "events", readOnly: true, requiresWritableArtifacts: false },
  { name: "timeline", readOnly: true, requiresWritableArtifacts: false },
  { name: "sessions", readOnly: true, requiresWritableArtifacts: false },
  { name: "cost", readOnly: true, requiresWritableArtifacts: false },
  { name: "fanout", readOnly: true, requiresWritableArtifacts: false },
  { name: "audit", readOnly: true, requiresWritableArtifacts: false },
  { name: "calls", readOnly: true, requiresWritableArtifacts: false },
  { name: "prompts", readOnly: true, requiresWritableArtifacts: false },
  { name: "replay", readOnly: true, requiresWritableArtifacts: false },
  { name: "usage", readOnly: true, requiresWritableArtifacts: false },
  { name: "atlas-smoke", readOnly: true, requiresWritableArtifacts: false },
  { name: "atlas", readOnly: true, requiresWritableArtifacts: false },
  { name: "atlas-v2", readOnly: true, requiresWritableArtifacts: false },
  { name: "mcp-status", readOnly: true, requiresWritableArtifacts: false },
  { name: "codex-models", readOnly: true, requiresWritableArtifacts: false },
  { name: "local-models", requiresWritableArtifacts: false },
  { name: "windows-events", readOnly: true, requiresWritableArtifacts: false },
  { name: "admin", requiresWritableArtifacts: false },
  // Operator merge owns its direct-Git checks and DB updates. It is not an
  // agent/provider dispatch and must not initialize artifact or native Git
  // infrastructure before Bossy can approve a completed work item.
  { name: "merge", requiresWritableArtifacts: false },
  { name: "prune", requiresWritableArtifacts: false, requiresNativeGit: true },
  { name: "purge", requiresWritableArtifacts: false, requiresNativeGit: true },
  { name: "cleanup", requiresWritableArtifacts: false, requiresNativeGit: true },
  { name: "clear", requiresWritableArtifacts: false, requiresNativeGit: true },
];

const UNKNOWN_COMMAND_BOOTSTRAP_POLICY = Object.freeze({
  name: null,
  known: false,
  readOnly: true,
  requiresWritableArtifacts: false,
  requiresProvider: false,
  requiresNativeGit: false,
  refreshContextAfter: false,
});

function normalizePolicyEntry(entry) {
  return Object.freeze({
    known: true,
    readOnly: Boolean(entry.readOnly),
    requiresWritableArtifacts: entry.requiresWritableArtifacts ?? !entry.readOnly,
    requiresProvider: Boolean(entry.requiresProvider),
    requiresNativeGit: Boolean(entry.requiresNativeGit),
    refreshContextAfter: Boolean(entry.refreshContextAfter),
    aliases: Object.freeze(entry.aliases || []),
    name: entry.name,
  });
}

export const COMMAND_BOOTSTRAP_POLICIES = Object.freeze(POLICY_ENTRIES.map(normalizePolicyEntry));

const COMMAND_BOOTSTRAP_POLICY_BY_NAME = new Map();
for (const policy of COMMAND_BOOTSTRAP_POLICIES) {
  COMMAND_BOOTSTRAP_POLICY_BY_NAME.set(policy.name, policy);
  for (const alias of policy.aliases) COMMAND_BOOTSTRAP_POLICY_BY_NAME.set(alias, policy);
}

export function normalizeCommandName(command) {
  if (command == null || String(command).trim() === "") return "help";
  return String(command).trim().toLowerCase();
}

export function getCommandBootstrapPolicy(command) {
  const normalized = normalizeCommandName(command);
  return COMMAND_BOOTSTRAP_POLICY_BY_NAME.get(normalized) || UNKNOWN_COMMAND_BOOTSTRAP_POLICY;
}

export function isHelpCommand(command) {
  return getCommandBootstrapPolicy(command).name === "help";
}

export function isReadOnlyCommand(command) {
  return getCommandBootstrapPolicy(command).readOnly;
}

export function requiresWritableArtifactsForCommand(command) {
  return getCommandBootstrapPolicy(command).requiresWritableArtifacts;
}

export function requiresProviderForCommand(command) {
  return getCommandBootstrapPolicy(command).requiresProvider;
}

export function requiresNativeGitForCommand(command) {
  return getCommandBootstrapPolicy(command).requiresNativeGit;
}

export function shouldRefreshContextAfterCommand(command) {
  return getCommandBootstrapPolicy(command).refreshContextAfter;
}
