import { WEB_TOOL_ROLES } from "../../../../shared/tools/functions/contract.js";
import { atlasBackendLabel } from "../../../integrations/functions/atlas-label.js";

function contractToolNames(executionContract = null) {
  const tools = Array.isArray(executionContract?.tools) ? executionContract.tools : [];
  return new Set(tools.map((tool) => (
    String(tool?.canonicalName || tool?.name || "").trim()
  )).filter(Boolean));
}

function contractHasTool(toolNames, name) {
  return toolNames.has(name);
}

export function __testBuildShellDisciplineBlock({
  platform = process.platform,
  atlasAttachment = null,
  executionContract = null,
} = {}) {
  const atlasLabel = atlasBackendLabel(atlasAttachment);
  const toolNames = contractToolNames(executionContract);
  const hasReadFile = contractHasTool(toolNames, "read_file");
  const hasListFiles = contractHasTool(toolNames, "list_files");
  const hasSearchFiles = contractHasTool(toolNames, "search_files");
  const hasDeterministicReads = hasReadFile || hasListFiles || hasSearchFiles;
  const hasWriteFile = contractHasTool(toolNames, "write_file");
  const hasEditFile = contractHasTool(toolNames, "edit_file");
  const hasFileMutation = hasWriteFile || hasEditFile;
  const hasShell = contractHasTool(toolNames, "bash");
  const registeredTestTools = ["create_test_suite", "create_test", "run_test", "run_test_suite"]
    .filter((name) => contractHasTool(toolNames, name));
  const rules = [
    "CODEX TOOL DISCIPLINE:",
    atlasAttachment?.active
      ? (hasDeterministicReads
        ? `- ${atlasLabel} is active. Use ${atlasLabel} retrieval tools before listed deterministic file/search tools for discovery, codebase understanding, and line-level inspection.`
        : `- ${atlasLabel} is active. Use its listed retrieval tools; do not invent a deterministic fallback that is absent from the manifest.`)
      : (hasDeterministicReads
        ? "- Listed deterministic MCP file tools are the default path for exact repo inspection and mutation."
        : "- Repository file tools are not available unless they appear in the Runtime Capability Manifest."),
    "- Use the exact tool names listed in the Runtime Capability Manifest. Deterministic MCP names may be provider-prefixed; call that exact visible name, not apply_patch or a bare canonical label.",
    "- The manifest is exhaustive for this run. A canonical label, task command, prior-session tool, or prompt example does not create a callable capability.",
  ];

  if (hasDeterministicReads) {
    const labels = [
      hasReadFile ? "read_file for file contents" : null,
      hasListFiles ? "list_files for directory traversal" : null,
      hasSearchFiles ? "search_files for content search" : null,
    ].filter(Boolean);
    rules.push(`- Canonical tool labels describe purpose only: ${labels.join(", ")}. The callable name is the Available tools name.`);
    rules.push("- If a file read is truncated, read a narrower slice yourself instead of switching to shell or asking the human to paste file contents.");
    rules.push("- Never ask the human to paste the contents of a file that exists inside the working directory or an allowed added directory.");
  }
  if (hasFileMutation) {
    const labels = [hasWriteFile ? "write_file" : null, hasEditFile ? "edit_file" : null].filter(Boolean).join(" and ");
    rules.push(`- Do NOT use apply_patch or shell for file writes. The sandbox is read-only; the manifest ${hasWriteFile && hasEditFile ? "entries" : "entry"} whose canonical ${hasWriteFile && hasEditFile ? "labels are" : "label is"} ${labels} ${hasWriteFile && hasEditFile ? "are" : "is"} the only listed file-mutation path.`);
  } else {
    rules.push("- File mutation is unavailable in this run. Do not call apply_patch, write_file, or edit_file when none is listed.");
  }
  if (hasShell) {
    rules.push("- Do NOT use shell for normal file reads, searches, listings, diffs, or edits when a listed file tool can do the job.");
    rules.push("- Shell is an exception path only. Use the exact manifest entry whose canonical label is bash for explicit test/build commands, required toolchain commands, or specifically requested command output.");
    rules.push("- A provided test_command is command input for that listed bash tool; it is not itself a callable tool.");
  } else {
    rules.push("- Shell command execution is unavailable in this run because no manifest entry has the canonical label bash. Do not invoke PowerShell, pwsh, bash, shell, or a provided test_command; report that command verification was unavailable.");
  }
  if (registeredTestTools.length > 0) {
    rules.push(`- Registered-test capabilities are limited to the listed manifest entries with canonical labels: ${registeredTestTools.join(", ")}. Do not call any other test-suite tool.`);
  } else {
    rules.push("- Registered-test tools are unavailable in this run. Do not call create_test_suite, create_test, run_test, or run_test_suite.");
  }

  if (platform !== "win32" || !hasShell) {
    return rules.join("\n");
  }

  const windowsRules = [
    "WINDOWS SHELL RULES:",
    "- The shell is Windows PowerShell, not bash.",
    "- Do not assume repo-root-relative paths are valid; use the current working directory or absolute paths.",
    "- Do NOT use bash heredocs like <<'PY' or <<EOF.",
    "- Do NOT use bash chaining/operators like && or || when composing commands.",
  ];
  if (hasDeterministicReads) {
    windowsRules.push("- Do NOT use Unix-only filters like head or wc; use listed file tools first, or PowerShell commands such as Select-Object and Measure-Object when shell is truly needed.");
  }
  if (hasSearchFiles || hasListFiles) {
    const labels = [hasSearchFiles ? "search_files" : null, hasListFiles ? "list_files" : null].filter(Boolean).join("/");
    windowsRules.push(`- Do NOT use rg, grep, or findstr for routine repository search on Windows. Use the listed manifest ${hasSearchFiles && hasListFiles ? "entries" : "entry"} whose canonical ${hasSearchFiles && hasListFiles ? "labels are" : "label is"} ${labels} instead.`);
  }
  if (hasReadFile) {
    windowsRules.push("- Before using Python or shell to read a file, verify the file path with the listed manifest entry whose canonical label is read_file first.");
  }
  windowsRules.push(
    "- For multiple PowerShell statements, use separate commands or PowerShell syntax.",
    "- For inline Python, use a PowerShell here-string piped to python, for example:",
    "  @'",
    "  print(\"hello\")",
    "  '@ | python -",
  );
  if (hasDeterministicReads || hasFileMutation) {
    windowsRules.push("- Never use shell just to read or edit repo files when a listed file tool can do it.");
  }
  return [...rules, "", ...windowsRules].join("\n");
}

export function __testBuildCodexRoleGuardBlock({
  role = "planner",
  allowWrite = false,
  executionContract = null,
} = {}) {
  const toolNames = contractToolNames(executionContract);
  const has = (name) => contractHasTool(toolNames, name);
  if (role === "dev") {
    const rules = ["DEV TOOL PRIORITY:"];
    if (has("write_file") || has("edit_file")) {
      const labels = [has("write_file") ? "write_file" : null, has("edit_file") ? "edit_file" : null].filter(Boolean).join(" and ");
      rules.push(`- Use the manifest ${has("write_file") && has("edit_file") ? "entries" : "entry"} whose canonical ${has("write_file") && has("edit_file") ? "labels are" : "label is"} ${labels} for file changes. Call the exact provider-prefixed names shown there.`);
      rules.push("- Do NOT use apply_patch — the sandbox is read-only and apply_patch will be rejected.");
      rules.push("- If writable file scope is listed, try the exact listed manifest write/edit tool names and report their actual errors before claiming mutation is unavailable.");
      if (has("write_file")) rules.push("- For files in create_roots outside the working directory, use the exact listed write_file surface.");
    } else if (allowWrite) {
      rules.push("- The job may describe writable scope, but this run exposes no file-mutation tool. Do not attempt apply_patch, write_file, or edit_file; report the capability mismatch.");
    }
    if (has("read_file") || has("list_files") || has("search_files")) {
      const labels = [has("read_file") ? "read_file" : null, has("list_files") ? "list_files" : null, has("search_files") ? "search_files" : null].filter(Boolean).join(", ");
      rules.push(`- Use active retrieval context first when available, then the listed manifest entries (${labels}) for exact worktree inspection.`);
    }
    if (has("bash")) {
      rules.push("- If a test_command is provided, run it after file changes through the exact listed bash surface. The command string is not a tool name.");
    } else {
      rules.push("- No bash surface is listed. Do not attempt a provided test_command or any PowerShell/shell command; report verification as unavailable.");
    }
    if (has("run_scoped_checks")) {
      rules.push("- For lint/typecheck, including PHP syntax checks, use the listed run_scoped_checks surface before considering shell.");
    }
    if (has("bash")) rules.push("- Do not use shell for ad-hoc repository discovery when listed retrieval or file/search tools can answer the question.");
    return rules.join("\n");
  }
  if (role === "assessor") {
    const rules = ["ASSESSOR TOOL PRIORITY:"];
    if (has("read_file") || has("list_files") || has("search_files")) {
      const labels = [has("read_file") ? "read_file" : null, has("list_files") ? "list_files" : null, has("search_files") ? "search_files" : null].filter(Boolean).join(", ");
      rules.push(`- Verify files with the listed manifest entries (${labels}); when retrieval evidence is active, start there first.`);
    }
    if (has("run_scoped_checks")) rules.push("- Use the listed run_scoped_checks surface for lint/typecheck first, including PHP syntax checks.");
    if (has("bash")) {
      rules.push("- Use the exact listed bash surface only for explicit verification commands such as a provided test command or a narrow project test/build command.");
      rules.push("- Do not use shell-based search to decide whether the implementation changed the right files.");
    } else {
      rules.push("- Shell and provided test-command execution are unavailable because no bash surface is listed. Do not attempt PowerShell or shell commands.");
    }
    return rules.join("\n");
  }
  if (role === "artificer") {
    const rules = ["ARTIFICER TOOL PRIORITY:"];
    if (has("write_file")) rules.push("- Use the exact listed write_file surface for artifacts you create.");
    if (has("read_file") || has("list_files")) {
      const labels = [has("read_file") ? "read_file" : null, has("list_files") ? "list_files" : null].filter(Boolean).join("/");
      rules.push(`- Use the listed ${labels} ${has("read_file") && has("list_files") ? "surfaces" : "surface"} to inspect inputs; do not call either tool when absent.`);
    }
    if (has("bash")) rules.push("- Avoid shell for routine filesystem operations when listed file tools can perform them directly.");
    return rules.join("\n");
  }
  return allowWrite
    ? "Use only file or shell tools explicitly listed in the Runtime Capability Manifest."
    : "Use only inspection or verification tools explicitly listed in the Runtime Capability Manifest.";
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
  if (role === "assessor") {
    return "WEB VERIFICATION: The Codex `web_search` tool is enabled only to verify a concrete claim against a known authoritative documentation source. Do not use it for general discovery.";
  }
  return null;
}
