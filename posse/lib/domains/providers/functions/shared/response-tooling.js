import { appendExecutionTools } from "../../../../shared/tools/functions/contract.js";
import {
  TOOL_BASH,
  safePath as sharedSafePath,
  buildScopePredicates as sharedBuildScopePredicates,
  createDeterministicToolkit,
  createBashExecutor,
} from "../../../../shared/tools/functions/toolkit/index.js";
import { executeEmbeddedAtlasTool, resolveEmbeddedAtlasAction } from "../../../integrations/functions/atlas-embedded.js";
import {
  buildLockedToolError as buildGateLockedToolError,
  isGateActive,
  isGatedTool,
  checkNativeToolAllowed,
  noteAtlasToolResult as noteGateAtlasToolResult,
} from "../../../integrations/functions/deterministic-mcp/gate.js";
import { buildEmbeddedToolDefinitions } from "./embedded-tools.js";
import { execGenerateImageInternal } from "./image-generate-internal.js";
import { createStandardToolHandlerMap, executeToolWithMap } from "./tool-runtime.js";

export { appendExecutionTools, sharedBuildScopePredicates, sharedSafePath };

export const DEFAULT_FALLBACK_READS = 3;

function bashReadOnly(extra = "") {
  return {
    ...TOOL_BASH,
    description:
      "Execute a READ-ONLY shell command for repo-native inspection or verification (git log, git diff, test/build runners, etc.). " +
      "On Windows, use PowerShell-compatible syntax and avoid Unix-only filters such as head/wc or Bash-only operators. " +
      "Do NOT use this to modify files or run destructive commands." +
      (extra ? " " + extra : ""),
  };
}

async function execGenerateImage(args, cwd, scopePredicates) {
  return execGenerateImageInternal(args, {
    cwd,
    scopePredicates,
    safePathImpl: sharedSafePath,
  });
}

const {
  execReadFile: deterministicReadFile,
  execWriteFile: deterministicWriteFile,
  execEditFile: deterministicEditFile,
  execListFiles: deterministicListFiles,
  execSearchFiles: deterministicSearchFiles,
  execGitHistory: deterministicGitHistory,
  execInspectFile: deterministicInspectFile,
  execHashFile: deterministicHashFile,
  execResizeImage: deterministicResizeImage,
  execValidateArtifactOutput: deterministicValidateArtifactOutput,
  execPruneArtifactOutput: deterministicPruneArtifactOutput,
  execReadImageMetadata: deterministicReadImageMetadata,
  execOptimizeImage: deterministicOptimizeImage,
  execReencodeImage: deterministicReencodeImage,
  execCleanImage: deterministicCleanImage,
  execExtractImageText: deterministicExtractImageText,
  execRunScopedChecks: deterministicRunScopedChecks,
  execGetBrief: deterministicGetBrief,
} = createDeterministicToolkit({ safePath: sharedSafePath });

const deterministicBash = createBashExecutor();
const standardToolHandlers = createStandardToolHandlerMap({
  deterministicReadFile,
  deterministicWriteFile,
  deterministicEditFile,
  deterministicListFiles,
  deterministicSearchFiles,
  deterministicGitHistory,
  deterministicInspectFile,
  deterministicHashFile,
  deterministicResizeImage,
  deterministicValidateArtifactOutput,
  deterministicPruneArtifactOutput,
  deterministicReadImageMetadata,
  deterministicOptimizeImage,
  deterministicReencodeImage,
  deterministicCleanImage,
  deterministicExtractImageText,
  deterministicRunScopedChecks,
  deterministicBash,
  deterministicGetBrief,
  execGenerateImage,
  safePath: sharedSafePath,
});

export function parseToolInput(argsStr) {
  try {
    return JSON.parse(argsStr);
  } catch {
    return null;
  }
}

function parseGateToolArgs(argsStr) {
  try {
    const parsed = typeof argsStr === "string" ? JSON.parse(argsStr || "{}") : argsStr;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createOpenAiCompatibleTooling({ buildImageTool } = {}) {
  function getToolsForRole(contract) {
    return buildEmbeddedToolDefinitions(contract, {
      bash: contract?.role === "assessor"
        ? bashReadOnly("For lint/typecheck, including PHP syntax checks, call run_scoped_checks first; use bash only for verification commands scoped checks cannot cover.")
        : TOOL_BASH,
      generate_image: typeof buildImageTool === "function" ? buildImageTool() : null,
    });
  }

  async function executeTool(name, argsStr, cwd, allowWrite, scopePredicates, atlasConfig = null, gateScopeKey = null, declaredScope = {}, executionContract = null, mcpGate = null) {
    const atlasAction = resolveEmbeddedAtlasAction(name);
    const canonicalName = atlasAction || String(name || "");
    if (executionContract && !(executionContract.tools || []).some((tool) => (tool?.canonicalName || tool?.name) === canonicalName)) {
      return `Error: Tool "${name}" is not authorized by the active execution contract.`;
    }
    const gateArgs = parseGateToolArgs(argsStr);
    if (mcpGate) {
      try {
        return await mcpGate.callTool(canonicalName, gateArgs);
      } catch (error) {
        return `Error: ${error?.message || String(error)}`;
      }
    }
    if (isGateActive({ scopeKey: gateScopeKey }) && isGatedTool(name)) {
      const gateDecision = checkNativeToolAllowed(name, gateArgs, { cwd, scopeKey: gateScopeKey });
      if (!gateDecision.allowed) {
        return buildGateLockedToolError(name, { args: gateArgs, cwd, scopeKey: gateScopeKey, atlasNameStyle: "embedded" });
      }
    }

    const result = await executeToolWithMap(name, argsStr, { cwd, allowWrite, scopePredicates, chainScopeKey: gateScopeKey, declaredScope }, {
      handlers: standardToolHandlers,
      onUnknown: (toolName, args) => {
        if (atlasAction) {
          return executeEmbeddedAtlasTool(atlasAction, args, { cwd, config: atlasConfig || undefined });
        }
        return `Error: Unknown tool "${toolName}"`;
      },
    });

    if (atlasAction) {
      return noteGateAtlasToolResult(result, { action: atlasAction, args: gateArgs, cwd, scopeKey: gateScopeKey });
    }

    return result;
  }

  return {
    getToolsForRole,
    executeTool,
    parseToolInput,
    safePath: sharedSafePath,
    buildScopePredicates: sharedBuildScopePredicates,
    deterministicInspectFile,
    deterministicResizeImage,
  };
}
