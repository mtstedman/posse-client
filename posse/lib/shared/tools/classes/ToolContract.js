import { normPath, normalizeRoots } from "../../scope/functions/path.js";
import { isToolAuthorizedByIssuedSurface } from "../functions/issued-tool-policy.js";
import { ToolCatalog } from "./ToolCatalog.js";
import { log } from "../../telemetry/functions/logging/logger.js";

// Tool names can arrive from surfaces newer than this build: the remote
// gateway rolls the issued tool catalog forward independently of the shipped
// client. A name this catalog has no execution metadata for must degrade to
// "tool not offered this run", not throw — the throwing behavior dead-lettered
// every job on older clients the first time the server issued a new tool
// (observed with atlas.create_ref on 2026-07-17).
const _unknownContractToolsWarned = new Set();
function resolveContractTools(toolNames, catalog = ToolCatalog) {
  const tools = [];
  for (const name of Array.isArray(toolNames) ? toolNames : []) {
    try {
      tools.push({ name, ...catalog.getExecutionSpec(name) });
    } catch (err) {
      warnUnknownContractTool(name, err);
    }
  }
  return tools;
}
function warnUnknownContractTool(name, err) {
  const key = String(name || "");
  if (_unknownContractToolsWarned.has(key)) return;
  _unknownContractToolsWarned.add(key);
  log.warn("tools", "Skipping contract tool with no execution metadata (issued surface newer than this client?)", {
    tool: key,
    error: err?.message || String(err),
  });
}

const CLAUDE_AMBIENT_TOOLS = [
  "ToolSearch",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Monitor",
  "PushNotification",
  "RemoteTrigger",
  "TaskOutput",
  "TaskStop",
].join(",");
const ALL_CLAUDE_NATIVE_TOOLS = `Read,Glob,Grep,Write,Edit,Bash,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite,${CLAUDE_AMBIENT_TOOLS}`;
const ASSESSOR_CLAUDE_NATIVE_DISALLOW = `Read,Glob,Grep,Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite,${CLAUDE_AMBIENT_TOOLS}`;

function stripWebToolsFromList(listStr) {
  if (!listStr) return listStr;
  return listStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && t !== "WebFetch" && t !== "WebSearch")
    .join(",");
}

function renderedToolName(tool = {}, contract = {}) {
  const surfaceName = String(tool?.providerSurfaceName || tool?.surfaceName || "").trim();
  if (surfaceName) return surfaceName;
  const name = String(tool?.name || "").trim();
  if (!name || tool?.access !== "atlas") return name;
  if (name.startsWith("atlas.") || name.startsWith("atlas_")) return name;
  const provider = String(contract?.provider || "").trim().toLowerCase();
  if (provider === "openai" || provider === "grok") {
    return ToolCatalog.getSchema(name)?.name || `atlas_${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  }
  return `atlas.${name}`;
}

function canonicalToolName(tool = {}) {
  return String(tool?.canonicalName || tool?.name || "").trim();
}

function renderedNameForCanonicalTool(contract = {}, toolName = "") {
  const canonicalName = String(toolName || "").trim();
  const tool = (contract.tools || []).find((candidate) => canonicalToolName(candidate) === canonicalName);
  return tool ? renderedToolName(tool, contract) : null;
}

function renderedToolListLabel(tool = {}, contract = {}) {
  const renderedName = renderedToolName(tool, contract);
  const canonicalName = canonicalToolName(tool);
  if (canonicalName && renderedName && canonicalName !== renderedName) {
    return `${renderedName} (canonical: ${canonicalName})`;
  }
  return renderedName;
}

function renderedToolAccessLabel(tool = {}) {
  const access = String(tool?.access || "unknown").trim() || "unknown";
  const suite = String(tool?.suite || "").trim();
  if (!suite) return access;
  if (suite === "atlas") return "atlas";
  return `${suite}/${access}`;
}

function normalizeToolAppendSpec(toolLike, catalog = ToolCatalog) {
  const toolName = typeof toolLike === "object" && toolLike
    ? String(toolLike.name || "").trim()
    : String(toolLike || "").trim();
  if (!toolName) return null;
  const extras = typeof toolLike === "object" && toolLike ? { ...toolLike } : {};
  delete extras.name;
  for (const key of Object.keys(extras)) {
    if (extras[key] === undefined) delete extras[key];
  }
  let spec;
  try {
    spec = catalog.getExecutionSpec(toolName);
  } catch (err) {
    warnUnknownContractTool(toolName, err);
    return null;
  }
  return { name: toolName, ...spec, ...extras };
}

function normalizeCreateRootGlobs(createRoots = [], scopeCwd = process.cwd()) {
  const normalizedRoots = normalizeRoots(createRoots, scopeCwd);
  const globs = [];
  const seen = new Set();
  for (const root of normalizedRoots) {
    const normalized = root === "*"
      ? "./"
      : `${normPath(root).replace(/\/+$/, "")}/`;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    globs.push(normalized);
  }
  return globs;
}

function normalizeContractShape(contract = {}) {
  const roleMode = String(contract.roleMode || contract.role_mode || "").trim().toLowerCase();
  const issuedToolSurface = Array.isArray(contract.issuedToolSurface)
    ? [...contract.issuedToolSurface]
    : null;
  return {
    provider: contract.provider || "generic",
    role: contract.role || "planner",
    roleMode: roleMode || null,
    allowWrite: !!contract.allowWrite,
    shellAllowed: !!contract.shellAllowed,
    shellMode: contract.shellMode || "none",
    platform: contract.platform || process.platform,
    fallbackReads: optionalNonNegativeNumber(contract.fallbackReads),
    scope: {
      modifyFiles: Array.isArray(contract?.scope?.modifyFiles) ? [...contract.scope.modifyFiles] : [],
      createFiles: Array.isArray(contract?.scope?.createFiles) ? [...contract.scope.createFiles] : [],
      createRoots: Array.isArray(contract?.scope?.createRoots) ? [...contract.scope.createRoots] : [],
      readRoots: Array.isArray(contract?.scope?.readRoots) ? [...contract.scope.readRoots] : [],
      deleteFiles: Array.isArray(contract?.scope?.deleteFiles) ? [...contract.scope.deleteFiles] : [],
    },
    issuedToolSurface,
    tools: Array.isArray(contract.tools)
      ? contract.tools
        .filter((tool) => isToolAuthorizedByIssuedSurface(tool, issuedToolSurface))
        .map((tool) => ({ ...tool }))
      : [],
  };
}

function optionalNonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
}

export class ToolContract {
  constructor(contract = {}) {
    this.contract = normalizeContractShape(contract);
  }

  toJSON() {
    return normalizeContractShape(this.contract);
  }

  withTools(toolNames = [], catalog = ToolCatalog) {
    return ToolContract.append(this.contract, toolNames, catalog);
  }

  adaptForProvider(provider = "generic") {
    return ToolContract.adaptForProvider(this.contract, provider);
  }

  renderBlock() {
    const contract = this.contract;
    const lines = [
      "RUNTIME CAPABILITY MANIFEST / EXECUTION CONTRACT:",
      `- Provider: ${contract.provider || "generic"}`,
      `- Role: ${contract.role || "unknown"}`,
      `- Write access: ${contract.allowWrite ? "enabled within allowed scope" : "disabled"}`,
      `- Shell route: ${contract.shellMode || "none"}`,
    ];
    if (contract.roleMode) {
      lines.splice(3, 0, `- Role mode: ${contract.roleMode}`);
    }
    if (contract.fallbackReads != null) {
      lines.push(`- Fallback read budget: ${contract.fallbackReads}`);
    }
    const scope = contract.scope || {};
    const scopeBits = [];
    if ((scope.modifyFiles || []).length > 0) scopeBits.push(`modify=${scope.modifyFiles.length}`);
    if ((scope.createFiles || []).length > 0) scopeBits.push(`create=${scope.createFiles.length}`);
    if ((scope.createRoots || []).length > 0) scopeBits.push(`create_roots=${scope.createRoots.length}`);
    if ((scope.readRoots || []).length > 0) scopeBits.push(`read_roots=${scope.readRoots.length}`);
    if ((scope.deleteFiles || []).length > 0) scopeBits.push(`delete=${scope.deleteFiles.length}`);
    lines.push(`- Scope summary: ${scopeBits.length > 0 ? scopeBits.join(", ") : "no explicit file scope"}`);
    lines.push("- Availability rule: this manifest is exhaustive for this run. Do not invoke, suggest, or claim access to a tool that is not listed below, even if the task, a prompt example, or a prior session mentions it.");
    lines.push("- Command rule: a command named in the task or prompt is input text, not a callable tool. Run it only through a listed shell or test tool; otherwise report that execution was unavailable.");
    if ((contract.tools || []).length === 0) {
      lines.push("- Runtime tools: none. Work only from provided prompt context.");
      return lines.join("\n");
    }
    const hasRenderedAliases = (contract.tools || []).some((tool) => {
      const renderedName = renderedToolName(tool, contract);
      const canonicalName = canonicalToolName(tool);
      return canonicalName && renderedName && canonicalName !== renderedName;
    });
    if (hasRenderedAliases) {
      lines.push("- Tool name rule: call the exact Available tools name. Canonical names in parentheses are labels only, not callable names.");
    }
    lines.push("- Available tools:");
    for (const tool of contract.tools) {
      lines.push(`  - ${renderedToolListLabel(tool, contract)} [${renderedToolAccessLabel(tool)}] - ${tool.summary}`);
    }
    if (contract.role === "researcher") {
      const chainRead = renderedNameForCanonicalTool(contract, "chain_read");
      const chainVerdict = renderedNameForCanonicalTool(contract, "chain_verdict");
      const readFile = renderedNameForCanonicalTool(contract, "read_file");
      if (chainRead && chainVerdict && readFile) {
        lines.push(`- File content path: use ${chainRead} + ${chainVerdict}, not ${readFile}.`);
      }
    } else if (contract.role === "planner") {
      const readFile = renderedNameForCanonicalTool(contract, "read_file");
      const listFiles = renderedNameForCanonicalTool(contract, "list_files");
      const searchFiles = renderedNameForCanonicalTool(contract, "search_files");
      if (readFile && listFiles && searchFiles) {
        lines.push(`- File content path: use ${readFile}/${listFiles}/${searchFiles} for exact missing context.`);
      }
    } else if (contract.role === "assessor") {
      const bash = renderedNameForCanonicalTool(contract, "bash");
      const scopedChecks = renderedNameForCanonicalTool(contract, "run_scoped_checks");
      if (bash) {
        lines.push(`- Assessor shell policy: ${bash} is read-only and only for inspection or verification commands. Assessors must not modify files.`);
      }
      if (bash && scopedChecks) {
        lines.push(`- Lint/typecheck path: use ${scopedChecks} first, including PHP syntax checks. Do not run php -l or php --syntax-check through ${bash}.`);
      }
    }
    const hasAtlasTools = (contract.tools || []).some((tool) => (tool?.access || "") === "atlas");
    if (hasAtlasTools) {
      lines.push(
        "- Use ATLAS retrieval tools first for repo context. Use deterministic tools for scoped writes, exact current worktree state after mutations, git/test/build/shell operations, or fallback when ATLAS is unavailable or insufficient.",
      );
    } else {
      lines.push("- Use deterministic tools first. Shell is exception-only and must stay within the allowed policy.");
    }
    return lines.join("\n");
  }

  toClaudeCliFlags({
    autoApprove = false,
    scopedFiles = [],
    createFiles = [],
    createRoots = [],
    scopeCwd = process.cwd(),
    deterministicReadMcpActive = false,
    disableSystemTools = false,
    webToolsEnabled = false,
  } = {}) {
    const contract = this.contract;
    const role = contract.role || "planner";
    const roleMode = contract.roleMode || null;
    const allowWrite = !!contract.allowWrite;
    const hasAtlasTools = Array.isArray(contract.tools)
      && contract.tools.some((tool) => (tool?.access || "") === "atlas");

    const webToolsAllowedForRoleMode = !(role === "researcher" && roleMode === "synth");
    const effectiveWebToolsEnabled = !!webToolsEnabled
      && webToolsAllowedForRoleMode
      && ToolCatalog.webToolRoles().has(role);
    const allNativeDisallow = effectiveWebToolsEnabled
      ? stripWebToolsFromList(ALL_CLAUDE_NATIVE_TOOLS)
      : ALL_CLAUDE_NATIVE_TOOLS;
    const assessorNativeDisallow = effectiveWebToolsEnabled
      ? stripWebToolsFromList(ASSESSOR_CLAUDE_NATIVE_DISALLOW)
      : ASSESSOR_CLAUDE_NATIVE_DISALLOW;
    const webSuffix = effectiveWebToolsEnabled ? ",WebFetch,WebSearch" : "";
    const appendWebAllowed = (arr) => {
      if (effectiveWebToolsEnabled) arr.push("WebFetch", "WebSearch");
      return arr;
    };

    if (disableSystemTools && deterministicReadMcpActive) {
      return {
        tools: null,
        disallowedTools: allNativeDisallow,
        dangerouslySkipPermissions: true,
      };
    }
    if (role === "preflight") {
      return {
        tools: "",
        disallowedTools: allNativeDisallow,
        dangerouslySkipPermissions: true,
      };
    }
    if (role === "researcher" || role === "planner" || role === "delegator") {
      if (role === "researcher" && effectiveWebToolsEnabled) {
        return {
          tools: "WebFetch,WebSearch",
          disallowedTools: allNativeDisallow,
          dangerouslySkipPermissions: true,
        };
      }
      if (role === "researcher" && deterministicReadMcpActive) {
        return {
          tools: null,
          disallowedTools: allNativeDisallow,
          dangerouslySkipPermissions: true,
        };
      }
      if ((role === "researcher" || role === "planner") && hasAtlasTools) {
        return {
          tools: `Read,Glob,Grep${webSuffix}`,
          disallowedTools: CLAUDE_AMBIENT_TOOLS,
          dangerouslySkipPermissions: true,
        };
      }
      return { tools: "", disallowedTools: CLAUDE_AMBIENT_TOOLS };
    }
    if (role === "assessor") {
      if (deterministicReadMcpActive) {
        return {
          tools: null,
          disallowedTools: assessorNativeDisallow,
          dangerouslySkipPermissions: true,
        };
      }
      let allowedTools = autoApprove
        ? null
        : "Read,Glob,Grep,Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(find:*),Bash(node:*),Bash(npm test:*),Bash(npm run:*)";
      if (allowedTools && effectiveWebToolsEnabled) {
        allowedTools = `${allowedTools},WebFetch,WebSearch`;
      }
      return {
        tools: `Read,Glob,Grep,Bash${webSuffix}`,
        disallowedTools: CLAUDE_AMBIENT_TOOLS,
        allowedTools,
        dangerouslySkipPermissions: false,
      };
    }
    if (role === "artificer" && allowWrite) {
      if (deterministicReadMcpActive) {
        return {
          tools: null,
          disallowedTools: allNativeDisallow,
          dangerouslySkipPermissions: true,
        };
      }
      if (effectiveWebToolsEnabled) {
        return {
          tools: "WebFetch,WebSearch",
          disallowedTools: allNativeDisallow,
          dangerouslySkipPermissions: true,
        };
      }
      const hasScope = (createRoots?.length || 0) > 0;
      if (!hasScope) {
        return {
          tools: `Bash,Read,Write,Glob,Grep${webSuffix}`,
          disallowedTools: CLAUDE_AMBIENT_TOOLS,
          dangerouslySkipPermissions: !!autoApprove,
        };
      }
      const allowed = ["Read", "Glob", "Grep"];
      for (const rootGlob of normalizeCreateRootGlobs(createRoots || [], scopeCwd)) {
        allowed.push(`Write(${rootGlob}*)`);
      }
      allowed.push(
        "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
        "Bash(ls:*)", "Bash(find:*)", "Bash(wc:*)", "Bash(file:*)", "Bash(du:*)",
        "Bash(convert:*)", "Bash(ffmpeg:*)", "Bash(magick:*)", "Bash(jq:*)",
        "Bash(sort:*)", "Bash(uniq:*)", "Bash(grep:*)", "Bash(rg:*)",
        "Bash(curl:*)", "Bash(wget:*)",
      );
      appendWebAllowed(allowed);
      return {
        tools: `Bash,Read,Write,Glob,Grep${webSuffix}`,
        disallowedTools: CLAUDE_AMBIENT_TOOLS,
        allowedTools: allowed.join(","),
        dangerouslySkipPermissions: false,
      };
    }
    if (role === "dev" && allowWrite) {
      if (deterministicReadMcpActive) {
        return {
          tools: null,
          disallowedTools: allNativeDisallow,
          dangerouslySkipPermissions: true,
        };
      }
      const hasScope = (scopedFiles?.length || 0) > 0 || (createFiles?.length || 0) > 0 || (createRoots?.length || 0) > 0;
      if (!hasScope) {
        return {
          tools: `Bash,Read,Write,Edit,Glob,Grep${webSuffix}`,
          disallowedTools: CLAUDE_AMBIENT_TOOLS,
          dangerouslySkipPermissions: !!autoApprove,
        };
      }
      const allowed = ["Read", "Glob", "Grep"];
      for (const file of (scopedFiles || [])) {
        allowed.push(`Write(${file})`, `Edit(${file})`);
      }
      for (const file of (createFiles || [])) {
        allowed.push(`Write(${file})`, `Edit(${file})`);
      }
      for (const rootGlob of normalizeCreateRootGlobs(createRoots || [], scopeCwd)) {
        allowed.push(`Write(${rootGlob}*)`, `Edit(${rootGlob}*)`);
      }
      allowed.push(
        "Bash(npm test:*)", "Bash(npm run:*)", "Bash(npx:*)",
        "Bash(pnpm test:*)", "Bash(pnpm run:*)", "Bash(pnpm exec:*)",
        "Bash(yarn test:*)", "Bash(yarn run:*)",
        "Bash(node:*)", "Bash(tsc:*)", "Bash(eslint:*)", "Bash(prettier:*)",
        "Bash(jest:*)", "Bash(vitest:*)", "Bash(mocha:*)",
        "Bash(python:*)", "Bash(python3:*)", "Bash(pytest:*)",
        "Bash(ruff:*)", "Bash(mypy:*)", "Bash(flake8:*)", "Bash(pip show:*)",
        "Bash(php -v:*)", "Bash(php --version:*)", "Bash(composer test:*)", "Bash(composer run:*)", "Bash(phpunit:*)",
        "Bash(cargo test:*)", "Bash(cargo check:*)", "Bash(cargo build:*)", "Bash(cargo clippy:*)",
        "Bash(go test:*)", "Bash(go vet:*)", "Bash(go build:*)",
        "Bash(make:*)", "Bash(cmake:*)", "Bash(gradle:*)", "Bash(mvn:*)",
        "Bash(dotnet test:*)", "Bash(dotnet build:*)",
        "Bash(cp:*)", "Bash(mkdir:*)",
        "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
        "Bash(ls:*)", "Bash(find:*)", "Bash(wc:*)", "Bash(file:*)", "Bash(du:*)",
        "Bash(diff:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(grep:*)", "Bash(rg:*)",
        "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)",
      );
      appendWebAllowed(allowed);
      return {
        tools: `Bash,Read,Write,Edit,Glob,Grep${webSuffix}`,
        disallowedTools: CLAUDE_AMBIENT_TOOLS,
        allowedTools: allowed.join(","),
        dangerouslySkipPermissions: false,
      };
    }
    return {
      tools: `Read,Glob,Grep${webSuffix}`,
      disallowedTools: deterministicReadMcpActive
        ? `Read,Glob,Grep,${CLAUDE_AMBIENT_TOOLS}`
        : CLAUDE_AMBIENT_TOOLS,
    };
  }

  toProviderToolDefinitions(toolMap = {}) {
    const tools = [];
    for (const tool of (this.contract.tools || [])) {
      const def = toolMap[canonicalToolName(tool)];
      if (def) tools.push(def);
    }
    return tools;
  }

  static build({
    provider = "generic",
    role = "planner",
    roleMode = null,
    allowWrite = false,
    needsImageGeneration = false,
    scopedFiles = [],
    createFiles = [],
    createRoots = [],
    readRoots = [],
    deleteFiles = [],
    fallbackReads = null,
    platform = process.platform,
    includeBaseTools = true,
    issuedToolSurface = null,
  } = {}) {
    const toolNames = includeBaseTools
      ? ToolCatalog.forRole(role, {
          allowWrite,
          needsImageGeneration,
          agentHandoff: Array.isArray(issuedToolSurface)
            && issuedToolSurface.includes("tools.agent_handoff"),
        })
      : [];
    const shellAllowed = toolNames.includes("bash");
    const shellMode = !shellAllowed
      ? "none"
      : (role === "assessor" ? "guarded-read-only" : "guarded-exception");
    const contract = {
      provider,
      role,
      roleMode,
      allowWrite: !!allowWrite,
      shellAllowed,
      shellMode,
      platform,
      fallbackReads: optionalNonNegativeNumber(fallbackReads),
      issuedToolSurface: Array.isArray(issuedToolSurface) ? issuedToolSurface : null,
      scope: {
        modifyFiles: Array.isArray(scopedFiles) ? scopedFiles : [],
        createFiles: Array.isArray(createFiles) ? createFiles : [],
        createRoots: Array.isArray(createRoots) ? createRoots : [],
        readRoots: Array.isArray(readRoots) ? readRoots : [],
        deleteFiles: Array.isArray(deleteFiles) ? deleteFiles : [],
      },
      tools: resolveContractTools(toolNames, ToolCatalog)
        .filter((tool) => isToolAuthorizedByIssuedSurface(tool, issuedToolSurface)),
    };
    return new ToolContract(contract);
  }

  static append(contract = {}, toolNames = [], catalog = ToolCatalog) {
    const normalized = normalizeContractShape(contract);
    const tools = normalized.tools.map((tool) => ({ ...tool }));
    const indexByName = new Map();
    for (const [index, tool] of tools.entries()) {
      const name = String(tool?.name || "").trim();
      if (name && !indexByName.has(name)) indexByName.set(name, index);
    }
    for (const toolLike of toolNames || []) {
      const incoming = normalizeToolAppendSpec(toolLike, catalog);
      if (!incoming) continue;
      if (!isToolAuthorizedByIssuedSurface(incoming, normalized.issuedToolSurface)) continue;
      const existingIndex = indexByName.get(incoming.name);
      if (existingIndex != null) {
        tools[existingIndex] = { ...tools[existingIndex], ...incoming, name: incoming.name };
        continue;
      }
      indexByName.set(incoming.name, tools.length);
      tools.push(incoming);
    }
    return {
      ...normalized,
      tools,
    };
  }

  static adaptForProvider(contract = {}, provider = "generic") {
    if (provider !== "codex") return normalizeContractShape(contract);

    const sourceTools = Array.isArray(contract.tools) ? contract.tools : [];
    const deduped = [];
    const seen = new Set();
    for (const tool of sourceTools) {
      const canonicalName = canonicalToolName(tool);
      if (!canonicalName) continue;
      if (seen.has(canonicalName)) continue;
      seen.add(canonicalName);
      const providerSurfaceName = String(tool?.providerSurfaceName || tool?.surfaceName || "").trim();
      deduped.push({
        name: canonicalName,
        canonicalName,
        access: tool?.access || "unknown",
        summary: tool?.summary || "",
        ...(tool?.mcpName ? { mcpName: tool.mcpName } : {}),
        ...(providerSurfaceName ? { providerSurfaceName, surfaceName: providerSurfaceName } : {}),
        ...(tool?.transport ? { transport: tool.transport } : {}),
        ...(tool?.suite ? { suite: tool.suite } : {}),
        ...(tool?.serverName ? { serverName: tool.serverName } : {}),
        ...(tool?.providerName ? { providerName: tool.providerName } : {}),
      });
    }

    const shellAllowed = deduped.some((tool) => tool.name === "bash");

    return {
      ...normalizeContractShape(contract),
      provider: "codex",
      shellAllowed,
      shellMode: shellAllowed
        ? (contract.role === "assessor" ? "guarded-read-only" : "guarded-exception")
        : "none",
      tools: deduped,
    };
  }

  static fromCatalog(catalog = ToolCatalog, {
    role = "planner",
    roleMode = null,
    providerName = "generic",
    allowWrite = false,
    needsImageGeneration = false,
    scopedFiles = [],
    createFiles = [],
    createRoots = [],
    readRoots = [],
    deleteFiles = [],
    fallbackReads = null,
    platform = process.platform,
  } = {}) {
    const toolNames = catalog.forRole(role, { allowWrite, needsImageGeneration });
    const shellAllowed = toolNames.includes("bash");
    const shellMode = !shellAllowed
      ? "none"
      : (role === "assessor" ? "guarded-read-only" : "guarded-exception");
    return new ToolContract({
      provider: providerName,
      role,
      roleMode,
      allowWrite: !!allowWrite,
      shellAllowed,
      shellMode,
      platform,
      fallbackReads: optionalNonNegativeNumber(fallbackReads),
      scope: {
        modifyFiles: Array.isArray(scopedFiles) ? scopedFiles : [],
        createFiles: Array.isArray(createFiles) ? createFiles : [],
        createRoots: Array.isArray(createRoots) ? createRoots : [],
        readRoots: Array.isArray(readRoots) ? readRoots : [],
        deleteFiles: Array.isArray(deleteFiles) ? deleteFiles : [],
      },
      tools: resolveContractTools(toolNames, catalog),
    });
  }

  static getBaseToolNamesForRole(role, allowWrite, opts = {}) {
    return ToolCatalog.forRole(role, {
      allowWrite: !!allowWrite,
      needsImageGeneration: !!opts.needsImageGeneration,
      agentHandoff: !!opts.agentHandoff,
    });
  }
}
