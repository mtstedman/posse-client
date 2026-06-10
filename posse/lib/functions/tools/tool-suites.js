// Single declaration of the deterministic ("tools" suite) tool metadata that
// every runtime shares. Each runtime (embedded OpenAI/Grok loop, deterministic
// MCP server) seeds a ToolRegistry from this and attaches the executor it owns.
//
// `advertise` lists the transports that offer the tool as a callable schema.
// Tools with an embedded executor but no function advertisement (image-resize
// helpers, pull_brief) are still declared so the embedded handler map can be
// built entirely from the registry.
//
// roles + mutatesWorktree make each entry self-describing (design notes B/C):
// roles are sourced from the canonical catalog; mutatesWorktree is the static
// "can mutate the working tree" capability (artifact/image writes land outside
// the worktree, so they are false; write/edit/bash can touch the tree).
//
// TODO(phase-4): this table becomes a projection of the remote-owned (Rust)
// catalog; `advertise` replaces the per-provider hand-lists entirely.

import { ToolCatalog } from "../../classes/tools/ToolCatalog.js";
import { ToolRegistry } from "../../classes/tools/ToolRegistry.js";
import { assertMutationRoleSafety } from "./tool-parity.js";

const TOOLS_SUITE = [
  // Shared by both runtimes (function + mcp transports).
  { name: "read_file", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "write_file", mutatesWorktree: true, advertise: ["function", "mcp"] },
  { name: "edit_file", mutatesWorktree: true, advertise: ["function", "mcp"] },
  { name: "list_files", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "search_files", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "git_history", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "inspect_file", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "hash_file", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "read_image_metadata", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "validate_artifact_output", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "prune_artifact_output", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "clean_image", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "extract_image_text", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "bash", mutatesWorktree: true, advertise: ["function", "mcp"] },
  { name: "generate_image", mutatesWorktree: false, advertise: ["function", "mcp"] },
  // Researcher chain-read tools: offered on both transports now.
  { name: "chain_read", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "chain_verdict", mutatesWorktree: false, advertise: ["function", "mcp"] },
  // MCP-only (deterministic MCP server for Claude/Codex): not function-advertised.
  { name: "move_file", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "copy_file", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "make_dir", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "run_scoped_checks", mutatesWorktree: false, advertise: ["mcp"] },
  { name: "create_test", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "create_test_suite", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "run_test", mutatesWorktree: false, advertise: ["mcp"] },
  { name: "run_test_suite", mutatesWorktree: false, advertise: ["mcp"] },
  // Embedded-executable helpers, advertised on no transport today.
  { name: "pull_brief", mutatesWorktree: false, advertise: [] },
  { name: "resize_image", mutatesWorktree: false, advertise: [] },
  { name: "optimize_image", mutatesWorktree: false, advertise: [] },
  { name: "reencode_image", mutatesWorktree: false, advertise: [] },
];

/** Declare the deterministic "tools" suite metadata onto a registry. */
export function declareToolSuites(registry) {
  for (const t of TOOLS_SUITE) {
    const roles = [...(ToolCatalog.get(t.name)?.roleAllowlist || [])];
    registry.declare({
      suite: "tools",
      name: t.name,
      roles,
      mutatesWorktree: t.mutatesWorktree,
      advertise: t.advertise,
    });
  }
  return registry;
}

let _metadataRegistry = null;

/** Singleton metadata-only registry (declarations, no executors attached). */
export function getToolMetadataRegistry() {
  if (!_metadataRegistry) {
    _metadataRegistry = declareToolSuites(new ToolRegistry());
    assertMutationRoleSafety(_metadataRegistry);
  }
  return _metadataRegistry;
}

/** Bare names advertised as callable schemas on the embedded (function) transport. */
export function embeddedAdvertisedToolNames() {
  return getToolMetadataRegistry().advertisedNames("function");
}
