import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildWindowsSpawn } from "../shared/windows-spawn.js";

const execFileAsync = promisify(execFile);

function parseCatalog(raw, source, model) {
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    throw new Error(`Codex native batching cannot parse the model catalog from ${source}.`);
  }
  if (!Array.isArray(catalog?.models)) {
    throw new Error(`Codex native batching requires a models array in the catalog from ${source}.`);
  }
  // Alias slugs are valid when the active CLI explicitly catalogs them. Do
  // not infer family/prefix aliases or borrow another model's instructions.
  const profiles = catalog.models.filter((profile) => profile?.slug === model);
  if (profiles.length !== 1) {
    throw new Error(`Codex native batching requires exactly one profile for selected model "${model}" in ${source}; found ${profiles.length}. Supply an explicit matching model catalog or update the selected Codex CLI.`);
  }
  return { catalog, profile: profiles[0] };
}

function validateNativeBatchingProfile(profile, model) {
  if (profile.tool_mode !== "direct" || profile.use_responses_lite !== false
    || profile.multi_agent_version !== "v1" || profile.apply_patch_tool_type !== null) {
    throw new Error(`Codex native batching catalog profile "${model}" must set tool_mode="direct", use_responses_lite=false, multi_agent_version="v1", and apply_patch_tool_type=null.`);
  }
}

/** Prepare one provider invocation's transport catalog without model inference. */
export async function prepareCodexNativeBatchingCatalog({
  cmd,
  args = [],
  model,
  catalogPath = null,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 10000,
  signal = undefined,
  tempParent = os.tmpdir(),
} = {}) {
  const selectedModel = String(model || "").trim();
  if (!selectedModel) throw new Error("Codex native batching requires an explicit selected model.");
  const explicitCatalog = String(catalogPath || "").trim();
  if (explicitCatalog) {
    const resolvedPath = path.resolve(cwd, explicitCatalog);
    let raw;
    try {
      raw = await fs.promises.readFile(resolvedPath, "utf8");
    } catch (error) {
      throw new Error(`Codex native batching cannot read the explicit model catalog at ${resolvedPath}.`, { cause: error });
    }
    const { profile } = parseCatalog(raw, resolvedPath, selectedModel);
    validateNativeBatchingProfile(profile, selectedModel);
    return { catalogPath: resolvedPath, temporary: false, cleanup: () => {} };
  }

  if (!cmd) throw new Error("Codex native batching requires the selected Codex CLI command.");
  const launch = buildWindowsSpawn(cmd, [...args, "debug", "models", "--bundled"]);
  let raw;
  try {
    ({ stdout: raw } = await execFileAsync(launch.command, launch.args, {
      cwd,
      env,
      signal,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      timeout: Math.min(30000, Math.max(1, Number(timeoutMs) || 10000)),
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    // Avoid echoing CLI stderr or launch arguments: inherited configuration
    // can contain credentials. Keep the original error available as a cause.
    throw new Error("Codex native batching could not read the selected CLI's bundled model catalog (`debug models --bundled`). Supply an explicit matching model catalog or use a CLI supporting this command.", { cause: error });
  }
  const { catalog, profile } = parseCatalog(raw, "the selected CLI's bundled catalog", selectedModel);
  // Retain model instructions, reasoning levels, context limits and all
  // unrelated metadata exactly as shipped by the selected executable.
  profile.tool_mode = "direct";
  profile.use_responses_lite = false;
  profile.multi_agent_version = "v1";
  profile.apply_patch_tool_type = null;

  const tempDir = await fs.promises.mkdtemp(path.join(tempParent, "posse-codex-native-batching-"));
  const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  const generatedPath = path.join(tempDir, "models.json");
  try {
    await fs.promises.writeFile(generatedPath, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    cleanup();
    throw error;
  }
  return { catalogPath: generatedPath, temporary: true, cleanup };
}
