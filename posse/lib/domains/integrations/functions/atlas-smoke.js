import path from "path";
import {
  buildAtlasCapability,
  getAtlasIntegrationConfig,
  getAtlasProviderSupport,
} from "./atlas.js";
import { executeEmbeddedAtlasTool } from "./atlas-embedded.js";
import { shouldUseAtlasV2 } from "./atlas-v2-mode.js";

function dedupeStrings(values = []) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function readConfiguredAtlasRepos() {
  return [];
}

export function buildAtlasSmokeConfig({
  repoPath = null,
  baseConfig = getAtlasIntegrationConfig(),
} = {}) {
  const normalizedRepoPath = repoPath ? path.resolve(repoPath) : (baseConfig.requestedRepoPath || null);
  const repoId = normalizedRepoPath ? path.basename(normalizedRepoPath) : baseConfig.requestedRepoId;
  const mode = baseConfig.mode === "off" ? "preferred" : baseConfig.mode;
  return {
    ...baseConfig,
    enabled: true,
    mode,
    normalizedMode: baseConfig.normalizedMode === "off" ? mode : (baseConfig.normalizedMode || mode),
    phases: dedupeStrings([...(baseConfig.phases || []), "research", "planning"]),
    liveFunnel: true,
    requestedRepoPath: normalizedRepoPath,
    requestedRepoId: repoId || null,
  };
}

export async function runAtlasSmokeTest({
  repoPath,
  provider = "openai",
  role = "researcher",
  query = "main",
  contextTask = "Identify the main entry points, key modules, and likely control flow for this repository.",
  config = buildAtlasSmokeConfig({ repoPath }),
  execImpl,
} = {}) {
  const capability = buildAtlasCapability(role, { cwd: repoPath, config });
  const providerSupport = getAtlasProviderSupport(provider, { config });
  const repos = readConfiguredAtlasRepos();
  const configuredRepo = repos.find((repo) =>
    repo.repoId === capability.repo.repoId || repo.rootPath === capability.repo.repoPath);

  const smokeOptions = execImpl ? { cwd: repoPath, config, execFileImpl: execImpl } : { cwd: repoPath, config };
  const indexRefresh = shouldUseAtlasV2({ config })
    ? await executeEmbeddedAtlasTool("index.refresh", {
      mode: "smart",
      wait: true,
    }, smokeOptions)
    : null;
  const symbolSearch = await executeEmbeddedAtlasTool("symbol.search", {
    query,
    limit: 5,
    semantic: false,
  }, smokeOptions);
  const context = await executeEmbeddedAtlasTool("context", {
    taskText: contextTask,
    taskType: "explain",
    maxTokens: 1600,
  }, smokeOptions);
  return {
    provider,
    role,
    query,
    capability,
    providerSupport,
    configuredRepos: repos,
    configuredRepo: configuredRepo || null,
    indexRefresh,
    symbolSearch,
    context,
  };
}
