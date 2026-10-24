// @ts-check



export const TOOLS_SUITE = [
  { name: "custom_tools", mutatesWorktree: false, advertise: ["mcp"] },
  // Shared by both runtimes (function + mcp transports).
  { name: "agent_handoff", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "agent_claim", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  { name: "report_claims", mutatesWorktree: false, budgetExempt: true, advertise: [] },
  { name: "sub_agent", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  { name: "sub_agent_next_input", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  { name: "dispatch_agent", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  { name: "web_research_handoff", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  // Dev/fix close-out: the owner runs the declared tests and a reviewer agent.
  { name: "final_review", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  { name: "read_file", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "get_brief", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "agent_feedback", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
  // Recovery executor retained for interrupted transports, but never issued to
  // a model. Live feedback is attached directly to a normal tool result.
  { name: "get_operator_feedback", mutatesWorktree: false, budgetExempt: true, advertise: [] },
  { name: "ack_operator_feedback", mutatesWorktree: false, budgetExempt: true, advertise: ["function", "mcp"] },
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
  // Artificer-only external downloads into artifact output scope. MCP only:
  // the gateway owns the per-job byte budget and the operator web kill switch.
  { name: "download_file", mutatesWorktree: false, advertise: ["mcp"] },
  // Artificer-only sprite-sheet composition into artifact output scope. MCP
  // only: the gateway runs converters asynchronously inside its call budget.
  { name: "compose_sprite_sheet", mutatesWorktree: false, advertise: ["mcp"] },
  // Assessor-only pixel inspection. MCP only: the result carries an image
  // content block, which function-calling transports cannot return.
  { name: "view_image", mutatesWorktree: false, advertise: ["mcp"] },
  // Opt-in project DB access. mutatesWorktree:false — DB writes (when granted)
  // don't touch the git working tree; capability is gated by per-repo config.
  { name: "project_db_query", mutatesWorktree: false, advertise: ["function", "mcp"] },
  // Researcher chain-read tools: offered on both transports now.
  { name: "chain_read", mutatesWorktree: false, advertise: ["function", "mcp"] },
  { name: "chain_verdict", mutatesWorktree: false, advertise: ["function", "mcp"] },
  // MCP-first mutation/test helpers. Safe read-only checks are also exposed on
  // embedded function transports so OpenAI/Grok do not fall back to bash lint.
  { name: "move_file", mutatesWorktree: true, advertise: ["mcp"] },
  // The deterministic harness may invoke this directly, but agents do not discover it.
  { name: "copy_file", mutatesWorktree: true, advertise: [] },
  { name: "make_dir", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "run_scoped_checks", mutatesWorktree: false, advertise: ["function", "mcp"] },
  // One path-only unit-test runner. Runtime discovery hides it unless SCIP and
  // every language adapter required by test* directories are available.
  { name: "inspect_environment", mutatesWorktree: false, advertise: ["mcp"] },
  { name: "request_clarification", mutatesWorktree: false, advertise: ["mcp"] },
  { name: "setup_environment", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "install_dependencies", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "setup_database", mutatesWorktree: true, advertise: ["mcp"] },
  { name: "run_unit_test", mutatesWorktree: false, advertise: ["mcp"] },
  // Dev/fix agents may proactively consolidate exact scope requests. The
  // ordinary write/edit boundary still invokes the same executor internally.
  { name: "request_scope", mutatesWorktree: false, advertise: ["function", "mcp"] },
  // Embedded-executable helpers, advertised on no transport today.
  { name: "pull_brief", mutatesWorktree: false, advertise: [] },
  { name: "resize_image", mutatesWorktree: false, advertise: [] },
  { name: "optimize_image", mutatesWorktree: false, advertise: [] },
  { name: "reencode_image", mutatesWorktree: false, advertise: [] },
];
