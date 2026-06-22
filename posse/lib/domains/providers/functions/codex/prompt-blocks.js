import { WEB_TOOL_ROLES } from "../../../../functions/tools/contract.js";
import { buildMcpSurfaceToolDescriptors } from "../../../../functions/tools/mcp-surface.js";
import { atlasBackendLabel } from "../../../integrations/functions/atlas-label.js";

function codexMcpSurfaceExample(canonicalName) {
  return buildMcpSurfaceToolDescriptors([canonicalName], {
    providerName: "codex",
    serverName: "posse_gateway",
  })[0]?.providerSurfaceName || String(canonicalName || "").trim();
}

const CODEX_EDIT_FILE_EXAMPLE = codexMcpSurfaceExample("edit_file");

export function __testBuildShellDisciplineBlock({ platform = process.platform, atlasAttachment = null } = {}) {
  const atlasLabel = atlasBackendLabel(atlasAttachment);
  const rules = [
    "CODEX TOOL DISCIPLINE:",
    atlasAttachment?.active
      ? `- ${atlasLabel} is active. Use ${atlasLabel} retrieval tools before deterministic file/search tools for discovery, codebase understanding, and line-level inspection; use deterministic tools only when ${atlasLabel} is unavailable or insufficient, you have mutated files and need current worktree state, or git/test/build/shell operations are required.`
      : "- Deterministic MCP file tools are the default path for exact repo inspection and mutation.",
    `- Use the exact deterministic MCP tool names listed in the Runtime Capability Manifest. In Codex they may be prefixed like ${CODEX_EDIT_FILE_EXAMPLE}; call that exact visible name, not apply_patch or a bare canonical label.`,
    "- Canonical tool labels describe purpose only: read_file for file contents, list_files for directory traversal, search_files for content search, write_file and edit_file for mutations. The callable name is the Available tools name.",
    "- Do NOT use apply_patch or shell for file writes. The sandbox is read-only; the manifest entries whose canonical labels are write_file and edit_file are the only write paths that succeed, including for files outside the working directory that are in your create_roots scope.",
    "- Do NOT use shell for normal file reads, searches, listings, diffs, or edits when a file tool can do the job.",
    "- Shell is an exception path only. Use it only for explicit test/build commands, toolchain commands required by the task, or command output the task specifically asks for.",
    "- If a file read is truncated, read a narrower slice yourself instead of switching to shell or asking the human to paste file contents.",
    "- Never ask the human to paste the contents of a file that exists inside the working directory or an allowed added directory.",
  ];

  if (platform !== "win32") {
    return rules.join("\n");
  }

  return [
    ...rules,
    "",
    "WINDOWS SHELL RULES:",
    "- The shell is Windows PowerShell, not bash.",
    "- Do not assume repo-root-relative paths are valid; use the current working directory or absolute paths.",
    "- Do NOT use bash heredocs like <<'PY' or <<EOF.",
    "- Do NOT use bash chaining/operators like && or || when composing commands.",
    "- Do NOT use Unix-only filters like head or wc; use file tools first, or PowerShell commands such as Select-Object and Measure-Object when shell is truly needed.",
    "- Do NOT use rg, grep, or findstr for routine repository search on Windows. Use the manifest entries whose canonical labels are search_files/list_files instead.",
    "- Before using Python or shell to read a file, verify the file path with the manifest entry whose canonical label is read_file first.",
    "- For multiple PowerShell statements, use separate commands or PowerShell syntax.",
    "- For inline Python, use a PowerShell here-string piped to python, for example:",
    "  @'",
    "  print(\"hello\")",
    "  '@ | python -",
    "- Never use shell just to read or edit repo files when the native tools can do it.",
  ].join("\n");
}

const CODEX_ROLE_GUARD_BLOCKS = {
  dev: [
    "DEV TOOL PRIORITY:",
    `- Use the manifest entries whose canonical labels are write_file and edit_file for file changes. In Codex the callable names may be prefixed like ${CODEX_EDIT_FILE_EXAMPLE}.`,
    "- Do NOT use apply_patch — the sandbox is read-only and apply_patch will be rejected.",
    "- If writable file scope is listed, do not report that no writable file-edit tool exists before trying the exact manifest write/edit tool names and reporting the actual tool error, if any.",
    "- Use the active retrieval context first when it is available; then use the manifest entries whose canonical labels are read_file, list_files, and search_files for exact worktree inspection before editing.",
    "- For files in your create_roots scope that live outside the working directory (e.g. resources/artifacts paths), the manifest entry whose canonical label is write_file still succeeds — it runs outside the Codex sandbox.",
    "- If a test_command is provided, run that command after the file changes are complete.",
    "- For lint/typecheck, including PHP syntax checks, use the manifest entry whose canonical label is run_scoped_checks before considering shell.",
    "- Do not use shell for ad-hoc repository discovery when ATLAS or the manifest file/search tools can answer the question.",
    "- Do not use shell for lint/typecheck commands unless run_scoped_checks reports that the needed check is unavailable or cannot cover the scope; state that reason when falling back.",
  ].join("\n"),
  assessor: [
    "ASSESSOR TOOL PRIORITY:",
    "- Verify files with the manifest entries whose canonical labels are read_file, list_files, and search_files before using shell; when retrieval evidence is active, start there first.",
    "- Use the manifest entry whose canonical label is run_scoped_checks for lint/typecheck first, including PHP syntax checks.",
    "- Use shell only for explicit verification commands such as the provided test command or a narrow project test/build command.",
    "- Do not use shell for lint/typecheck commands unless run_scoped_checks reports that the needed check is unavailable or cannot cover the scope; state that reason when falling back.",
    "- Do not use shell-based search to decide whether the implementation changed the right files.",
  ].join("\n"),
  artificer: [
    "ARTIFICER TOOL PRIORITY:",
    "- Use the manifest entry whose canonical label is write_file for artifacts you create and the entries whose canonical labels are read_file and list_files to inspect inputs.",
    "- Avoid shell for routine filesystem operations when the file tools can perform them directly.",
  ].join("\n"),
};

export function __testBuildCodexRoleGuardBlock({ role = "planner", allowWrite = false } = {}) {
  return CODEX_ROLE_GUARD_BLOCKS[role]
    || (allowWrite
      ? "Use native file tools before shell whenever the task involves repository files."
      : "Prefer native file tools for repository inspection and verification.");
}

export function buildCodexWebToolsOverrides({ role, roleMode = null, webToolsEnabled } = {}) {
  const normalizedRoleMode = String(roleMode || "").trim().toLowerCase();
  const webToolsAllowedForRoleMode = !(role === "researcher" && normalizedRoleMode === "synth");
  const active = !!webToolsEnabled && webToolsAllowedForRoleMode && WEB_TOOL_ROLES.has(role);
  return {
    active,
    configOverrides: active ? ["tools.web_search=true"] : [],
  };
}

export function __testBuildCodexWebToolsOverrides(options = {}) {
  return buildCodexWebToolsOverrides(options);
}

export function buildCodexWebToolsNote(role) {
  if (role === "researcher") {
    return "WEB RESEARCH: The Codex `web_search` tool is enabled. Use it to gather external documentation, specs, or current facts when the repo does not already contain them. Cite URLs in the research brief.";
  }
  if (role === "artificer") {
    return "WEB RESEARCH: The Codex `web_search` tool is enabled. Use it only to gather external references needed for artifact content. Do not use native/system file tools; use deterministic MCP tools for files and images.";
  }
  return null;
}

