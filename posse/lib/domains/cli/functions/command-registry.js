// Command metadata for CLI bootstrap policy.
//
// Keep this table focused on cross-cutting startup behavior. Command-specific
// argument parsing still belongs with the command implementation.

const DEFINITIONS = [
  { name: "help", aliases: ["--help", "-h"], readOnly: true, requiresWritableArtifacts: false },
  { name: "add", requiresWritableArtifacts: true },
  { name: "queue", readOnly: true, requiresWritableArtifacts: false },
  { name: "plan", requiresWritableArtifacts: true },
  { name: "run", requiresWritableArtifacts: true, requiresProvider: true, refreshContextAfter: true },
  { name: "go", requiresWritableArtifacts: true, requiresProvider: true, refreshContextAfter: true },
  { name: "status", readOnly: true, requiresWritableArtifacts: false },
  { name: "serve", requiresWritableArtifacts: false },
  { name: "health", readOnly: true, requiresWritableArtifacts: false },
  { name: "dashboard", readOnly: true, requiresWritableArtifacts: false },
  { name: "doctor", requiresWritableArtifacts: false },
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
  { name: "windows-events", readOnly: true, requiresWritableArtifacts: false },
  { name: "admin", requiresWritableArtifacts: false },
  { name: "merge", requiresWritableArtifacts: true, refreshContextAfter: true },
  { name: "prune", requiresWritableArtifacts: false },
  { name: "purge", requiresWritableArtifacts: false },
  { name: "cleanup", requiresWritableArtifacts: false },
  { name: "clear", requiresWritableArtifacts: false },
];

const UNKNOWN_COMMAND = Object.freeze({
  name: null,
  known: false,
  readOnly: true,
  requiresWritableArtifacts: false,
  requiresProvider: false,
  refreshContextAfter: false,
});

function normalizeEntry(entry) {
  return Object.freeze({
    known: true,
    readOnly: Boolean(entry.readOnly),
    requiresWritableArtifacts: entry.requiresWritableArtifacts ?? !entry.readOnly,
    requiresProvider: Boolean(entry.requiresProvider),
    refreshContextAfter: Boolean(entry.refreshContextAfter),
    aliases: Object.freeze(entry.aliases || []),
    name: entry.name,
  });
}

export const COMMAND_DEFINITIONS = Object.freeze(DEFINITIONS.map(normalizeEntry));

const COMMAND_BY_NAME = new Map();
for (const command of COMMAND_DEFINITIONS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) COMMAND_BY_NAME.set(alias, command);
}

export function normalizeCommandName(command) {
  if (command == null || String(command).trim() === "") return "help";
  return String(command).trim().toLowerCase();
}

export function getCommandDefinition(command) {
  const normalized = normalizeCommandName(command);
  return COMMAND_BY_NAME.get(normalized) || UNKNOWN_COMMAND;
}

export function isHelpCommand(command) {
  return getCommandDefinition(command).name === "help";
}

export function isReadOnlyCommand(command) {
  return getCommandDefinition(command).readOnly;
}

export function requiresWritableArtifactsForCommand(command) {
  return getCommandDefinition(command).requiresWritableArtifacts;
}

export function requiresProviderForCommand(command) {
  return getCommandDefinition(command).requiresProvider;
}

export function shouldRefreshContextAfterCommand(command) {
  return getCommandDefinition(command).refreshContextAfter;
}
