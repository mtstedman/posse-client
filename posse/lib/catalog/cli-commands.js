// Canonical CLI command identities, aliases, and bootstrap requirements.
// Parsing and startup evaluation remain with the CLI domain.

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
  { name: "gate", requiresWritableArtifacts: false },
  { name: "job", requiresWritableArtifacts: false },
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
  { name: "shared-trunk-smoke", readOnly: true, requiresWritableArtifacts: false, requiresNativeGit: true },
  // Listing and provenance reset must remain available when the native helper
  // is the thing an operator is repairing. The abandon path performs its own
  // capability-gated fetch/reset before it changes the durable row.
  { name: "shared-trunk", requiresWritableArtifacts: false },
  { name: "pairing-preflight", aliases: ["shared-trunk-preflight"], requiresWritableArtifacts: false, requiresNativeGit: true },
  { name: "pair", requiresWritableArtifacts: false, requiresNativeGit: true },
  { name: "session", requiresWritableArtifacts: false, requiresNativeGit: true },
  { name: "unpair", requiresWritableArtifacts: false },
  { name: "atlas", readOnly: true, requiresWritableArtifacts: false },
  { name: "atlas-v2", readOnly: true, requiresWritableArtifacts: false },
  { name: "mcp-status", readOnly: true, requiresWritableArtifacts: false },
  { name: "codex-models", readOnly: true, requiresWritableArtifacts: false },
  { name: "local-models", requiresWritableArtifacts: false },
  { name: "native-binaries", requiresWritableArtifacts: false },
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

export const UNKNOWN_COMMAND_BOOTSTRAP_POLICY = Object.freeze({
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

// Pairing verbs that only report a session.
export const PAIRING_READ_SUBCOMMANDS = Object.freeze(["status", "members", "pending"]);
