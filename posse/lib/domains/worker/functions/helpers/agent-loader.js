// lib/domains/worker/functions/helpers/agent-loader.js
//
// Provisions empty launch directories for sub-agents outside the target tree so
// Claude/Codex CLI auto-discovery cannot parent-walk into project memory or git
// metadata. Agents still access the real repo via the deterministic MCP server,
// which receives the workspace path in its boot payload rather than relying on
// process.cwd.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { slugify } from "../../../../shared/format/functions/slug.js";

const LOADER_BASE_DIR = path.join(os.tmpdir(), "posse-agent-loaders");

function projectLoaderKey(projectDir) {
  if (!projectDir) throw new Error("agentLoaderRoot: projectDir is required");
  const resolved = fs.existsSync(projectDir)
    ? fs.realpathSync.native(projectDir)
    : path.resolve(projectDir);
  const safeName = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "project";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `${safeName}-${hash}`;
}

async function projectLoaderKeyAsync(projectDir) {
  if (!projectDir) throw new Error("agentLoaderRoot: projectDir is required");
  let resolved;
  try {
    resolved = await fs.promises.realpath(projectDir);
  } catch {
    resolved = path.resolve(projectDir);
  }
  const safeName = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "project";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `${safeName}-${hash}`;
}

export function agentLoaderRoot(projectDir) {
  return path.join(LOADER_BASE_DIR, projectLoaderKey(projectDir));
}

export async function agentLoaderRootAsync(projectDir) {
  return path.join(LOADER_BASE_DIR, await projectLoaderKeyAsync(projectDir));
}

export function loaderPathForJob(projectDir, jobId) {
  if (!projectDir) throw new Error("loaderPathForJob: projectDir is required");
  if (jobId == null) throw new Error("loaderPathForJob: jobId is required");
  return path.join(agentLoaderRoot(projectDir), `task-${jobId}`);
}

export async function loaderPathForJobAsync(projectDir, jobId) {
  if (!projectDir) throw new Error("loaderPathForJob: projectDir is required");
  if (jobId == null) throw new Error("loaderPathForJob: jobId is required");
  return path.join(await agentLoaderRootAsync(projectDir), `task-${jobId}`);
}

function safeLoaderSegment(value, fallback = "item") {
  return slugify(value, { alphabet: "filename", fallback, maxLength: 48 });
}

export function loaderPathForSessionLane(projectDir, {
  workItemId,
  lane,
  provider,
  skillKey = "",
} = {}) {
  if (!projectDir) throw new Error("loaderPathForSessionLane: projectDir is required");
  if (!Number.isFinite(Number(workItemId))) throw new Error("loaderPathForSessionLane: workItemId is required");
  if (!lane) throw new Error("loaderPathForSessionLane: lane is required");
  if (!provider) throw new Error("loaderPathForSessionLane: provider is required");
  const key = {
    workItemId: Number(workItemId),
    lane: String(lane || "").trim().toLowerCase(),
    provider: String(provider || "").trim().toLowerCase(),
    skillKey: String(skillKey || ""),
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 12);
  const readable = [
    `wi-${key.workItemId}`,
    safeLoaderSegment(key.lane, "lane"),
    safeLoaderSegment(key.provider, "provider"),
  ].join("-");
  return path.join(agentLoaderRoot(projectDir), `session-${readable}-${hash}`);
}

export async function loaderPathForSessionLaneAsync(projectDir, sessionKey = {}) {
  if (!projectDir) throw new Error("loaderPathForSessionLane: projectDir is required");
  const {
    workItemId,
    lane,
    provider,
    skillKey = "",
  } = sessionKey;
  if (!Number.isFinite(Number(workItemId))) throw new Error("loaderPathForSessionLane: workItemId is required");
  if (!lane) throw new Error("loaderPathForSessionLane: lane is required");
  if (!provider) throw new Error("loaderPathForSessionLane: provider is required");
  const key = {
    workItemId: Number(workItemId),
    lane: String(lane || "").trim().toLowerCase(),
    provider: String(provider || "").trim().toLowerCase(),
    skillKey: String(skillKey || ""),
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 12);
  const readable = [
    `wi-${key.workItemId}`,
    safeLoaderSegment(key.lane, "lane"),
    safeLoaderSegment(key.provider, "provider"),
  ].join("-");
  return path.join(await agentLoaderRootAsync(projectDir), `session-${readable}-${hash}`);
}

export function provisionAgentLoader(projectDir, jobId) {
  const dir = loaderPathForJob(projectDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function provisionAgentLoaderAsync(projectDir, jobId) {
  const dir = await loaderPathForJobAsync(projectDir, jobId);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export function provisionSessionLaneLoader(projectDir, sessionKey) {
  const dir = loaderPathForSessionLane(projectDir, sessionKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function provisionSessionLaneLoaderAsync(projectDir, sessionKey) {
  const dir = await loaderPathForSessionLaneAsync(projectDir, sessionKey);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export function assertLoaderClean(loaderPath) {
  if (!loaderPath) throw new Error("assertLoaderClean: loaderPath is required");
  let entries;
  try {
    entries = fs.readdirSync(loaderPath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`assertLoaderClean: cannot read loader dir ${loaderPath}: ${err.message}`);
  }
  const offenders = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => e.name);
  if (offenders.length > 0) {
    throw new Error(
      `Agent loader dir ${loaderPath} must not contain .md files (found: ${offenders.join(", ")}). ` +
      `Claude/Codex auto-load these into the prompt.`
    );
  }
}

export async function assertLoaderCleanAsync(loaderPath) {
  if (!loaderPath) throw new Error("assertLoaderClean: loaderPath is required");
  let entries;
  try {
    entries = await fs.promises.readdir(loaderPath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`assertLoaderClean: cannot read loader dir ${loaderPath}: ${err.message}`);
  }
  const offenders = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => e.name);
  if (offenders.length > 0) {
    throw new Error(
      `Agent loader dir ${loaderPath} must not contain .md files (found: ${offenders.join(", ")}). ` +
      `Claude/Codex auto-load these into the prompt.`
    );
  }
}

export function cleanupAgentLoader(loaderPath) {
  if (!loaderPath) return;
  try {
    fs.rmSync(loaderPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; next provision recreates the dir.
  }
}

export async function cleanupAgentLoaderAsync(loaderPath) {
  if (!loaderPath) return;
  try {
    await fs.promises.rm(loaderPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; next provision recreates the dir.
  }
}
