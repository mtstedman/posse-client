// Remove launch directories left by earlier Node CLI provider executions.
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const LOADER_BASE_DIR = path.join(os.tmpdir(), "posse-agent-loaders");

export function loaderPathForJob(projectDir, jobId) {
  if (!projectDir) throw new Error("loaderPathForJob: projectDir is required");
  if (jobId == null) throw new Error("loaderPathForJob: jobId is required");
  const resolved = fs.existsSync(projectDir)
    ? fs.realpathSync.native(projectDir)
    : path.resolve(projectDir);
  const safeName = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "project";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return path.join(LOADER_BASE_DIR, `${safeName}-${hash}`, `task-${jobId}`);
}

export async function cleanupAgentLoaderAsync(loaderPath) {
  if (!loaderPath) return;
  await fs.promises.rm(loaderPath, { recursive: true, force: true });
}
