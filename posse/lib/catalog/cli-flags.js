// Single source of truth for every CLI flag the orchestrator accepts.
// Each descriptor has:
//   name        — the flag literal (with leading dashes; short aliases included)
//   takesValue  — true if the flag consumes the next argv item (or accepts =VALUE)
//   category    — "value"        : a value flag that affects positional parsing
//                                  (skipped when collecting positional args)
//                 "filter-value" : a value flag scoped to query/report subcommands
//                                  (counted as value-taking by unknown-flag detection
//                                  but NOT skipped during positional-arg collection,
//                                  since those subcommands don't use positionals)
//                 "boolean"      : no value (presence implies true)
//
// The three legacy Sets (VALUE_FLAGS, FLAG_VALUE_FLAGS, KNOWN_FLAGS) are now
// derived from this table so adding or renaming a flag requires updating one
// row. A drift test in test-cli-flags-descriptor.test.js asserts the derivation matches.
export const STARTUP_UPDATE_FLAGS = Object.freeze({
  update: "--update-at-boot",
  skip: "--no-update-at-boot",
  stash: "--stash",
});

export const FLAG_DESCRIPTORS = Object.freeze([
  { name: "--advanced-logging", takesValue: false, category: "boolean" },
  // Global value flags (affect work-item creation, mode, scope).
  { name: "--mode", takesValue: true, category: "value" },
  { name: "--scope-mode", takesValue: true, category: "value" },
  { name: "--tier", takesValue: true, category: "value" },
  { name: "--deepthink-budget", takesValue: true, category: "value" },
  { name: "--research-budget", takesValue: true, category: "value" },
  { name: "--intent", takesValue: true, category: "value" },
  { name: "--deliverable", takesValue: true, category: "value" },
  { name: "--output", takesValue: true, category: "value" },
  { name: "--files", takesValue: true, category: "value" },
  { name: "--dirs", takesValue: true, category: "value" },
  { name: "--input-contexts", takesValue: true, category: "value" },
  { name: "--contexts", takesValue: true, category: "value" },
  { name: "--subtasks", takesValue: true, category: "value" },
  { name: "--constraints", takesValue: true, category: "value" },
  { name: "--concurrency", takesValue: true, category: "value" },
  { name: "--stall-timeout", takesValue: true, category: "value" },
  { name: "--work-item", takesValue: true, category: "value" },
  { name: "--wi", takesValue: true, category: "value" },

  // Filter/query value flags (used by reports, audit, status, etc.).
  { name: "--by", takesValue: true, category: "filter-value" },
  { name: "--since", takesValue: true, category: "filter-value" },
  { name: "--limit", takesValue: true, category: "filter-value" },
  { name: "--min-runs", takesValue: true, category: "filter-value" },
  { name: "--max-review-rate", takesValue: true, category: "filter-value" },
  { name: "--first-plan-min", takesValue: true, category: "filter-value" },
  { name: "--feedback", takesValue: true, category: "filter-value" },
  { name: "--note", takesValue: true, category: "filter-value" },
  { name: "--job", takesValue: true, category: "filter-value" },
  { name: "-j", takesValue: true, category: "filter-value" },
  { name: "--role", takesValue: true, category: "filter-value" },
  { name: "--branch", takesValue: true, category: "filter-value" },
  { name: "--remote", takesValue: true, category: "filter-value" },
  { name: "--lang", takesValue: true, category: "filter-value" },
  { name: "-r", takesValue: true, category: "filter-value" },
  { name: "-n", takesValue: true, category: "filter-value" },
  { name: "--around", takesValue: true, category: "filter-value" },
  { name: "--minutes", takesValue: true, category: "filter-value" },
  { name: "--window-minutes", takesValue: true, category: "filter-value" },
  { name: "--confirmation-code", takesValue: true, category: "filter-value" },
  { name: "--pair-code", takesValue: true, category: "filter-value" },
  { name: "--approve-source-oid", takesValue: true, category: "filter-value" },
  { name: "--merge-mode", takesValue: true, category: "filter-value" },
  { name: "--deploy-mode", takesValue: true, category: "filter-value" },
  { name: "--approve-origin-oid", takesValue: true, category: "filter-value" },

  // Boolean flags.
  ...Object.values(STARTUP_UPDATE_FLAGS).map((name) => ({ name, takesValue: false, category: "boolean" })),
  { name: "--all", takesValue: false, category: "boolean" },
  { name: "--auto-approve", takesValue: false, category: "boolean" },
  { name: "--auto-approve-plan", takesValue: false, category: "boolean" },
  { name: "--approve-plan", takesValue: false, category: "boolean" },
  { name: "--active", takesValue: false, category: "boolean" },
  { name: "--adopt-node-install", takesValue: false, category: "boolean" },
  { name: "--auto-merge", takesValue: false, category: "boolean" },
  { name: "--cold-index", takesValue: false, category: "boolean" },
  { name: "--deepthink", takesValue: false, category: "boolean" },
  { name: "--dry-run", takesValue: false, category: "boolean" },
  { name: "--exact-prompt", takesValue: false, category: "boolean" },
  { name: "--full", takesValue: false, category: "boolean" },
  { name: "--force", takesValue: false, category: "boolean" },
  { name: "--guided", takesValue: false, category: "boolean" },
  { name: "--help", takesValue: false, category: "boolean" },
  { name: "-h", takesValue: false, category: "boolean" },
  { name: "--iterate", takesValue: false, category: "boolean" },
  { name: "--iterate-red-team", takesValue: false, category: "boolean" },
  { name: "--red-team-iterate", takesValue: false, category: "boolean" },
  { name: "--redteam-iterate", takesValue: false, category: "boolean" },
  { name: "--json", takesValue: false, category: "boolean" },
  { name: "--keep-branch", takesValue: false, category: "boolean" },
  { name: "--history-preserving", takesValue: false, category: "boolean" },
  { name: "--unattended", takesValue: false, category: "boolean" },
  { name: "--stdin-value", takesValue: false, category: "boolean" },
  { name: "--non-interactive", takesValue: false, category: "boolean" },
  { name: "--no-tui", takesValue: false, category: "boolean" },
  { name: "--no-auto-merge", takesValue: false, category: "boolean" },
  { name: "--pricing", takesValue: false, category: "boolean" },
  { name: "--provider-clis-only", takesValue: false, category: "boolean" },
  { name: "--force-refresh", takesValue: false, category: "boolean" },
  { name: "--recycling", takesValue: false, category: "boolean" },
  { name: "--red-team-plan", takesValue: false, category: "boolean" },
  { name: "--refresh", takesValue: false, category: "boolean" },
  { name: "--replan", takesValue: false, category: "boolean" },
  { name: "--savings", takesValue: false, category: "boolean" },
  { name: "--session", takesValue: false, category: "boolean" },
  { name: "--session-recycle", takesValue: false, category: "boolean" },
  { name: "--show-token", takesValue: false, category: "boolean" },
  { name: "--show-lan-token", takesValue: false, category: "boolean" },
  { name: "--no-session-recycle", takesValue: false, category: "boolean" },
  { name: "--oneshot", takesValue: false, category: "boolean" },
  { name: "--pair", takesValue: false, category: "boolean" },
  { name: "--here", takesValue: false, category: "boolean" },
  { name: "--verbose", takesValue: false, category: "boolean" },
  { name: "-v", takesValue: false, category: "boolean" },
  { name: "--auto", takesValue: false, category: "boolean" },
  { name: "--yes", takesValue: false, category: "boolean" },
  { name: "-y", takesValue: false, category: "boolean" },
]);
