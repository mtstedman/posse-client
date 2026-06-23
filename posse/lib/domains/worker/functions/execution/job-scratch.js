import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { getSetting } from "../../../queue/functions/index.js";
import { getRuntimeRoot } from "../../../runtime/functions/paths.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";

export const JOB_SCRATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const JOB_SCRATCH_GC_INTERVAL_MS = 60 * 60 * 1000;
const JOB_SCRATCH_ROOT_DIR = "posse-job-scratch";
const JOB_SCRATCH_SENTINEL_FILE = ".posse-job-scratch.json";
const JOB_SCRATCH_OWNER = "posse-worker-job-scratch";

export function readIntegerSetting(key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  try {
    const raw = getSetting(key);
    const parsed = Number.parseInt(String(raw || ""), 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
  } catch {
    return fallback;
  }
}

function scratchNamespaceForProject(projectDir = process.cwd(), runtimeRoot = null) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || getRuntimeRoot(resolvedProjectDir, resolvedProjectDir));
  const basename = path.basename(resolvedProjectDir).replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 48) || "project";
  const digest = crypto.createHash("sha256")
    .update(`${resolvedProjectDir}\0${resolvedRuntimeRoot}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${basename}-${digest}`;
}

function jobScratchOwnerPayload(projectDir = process.cwd(), runtimeRoot = null) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || getRuntimeRoot(resolvedProjectDir, resolvedProjectDir));
  return {
    owner: JOB_SCRATCH_OWNER,
    version: 1,
    projectDir: resolvedProjectDir,
    runtimeRoot: resolvedRuntimeRoot,
    namespace: scratchNamespaceForProject(resolvedProjectDir, resolvedRuntimeRoot),
  };
}

function markerMatchesProject(marker, expected) {
  return marker
    && marker.owner === JOB_SCRATCH_OWNER
    && marker.projectDir === expected.projectDir
    && marker.runtimeRoot === expected.runtimeRoot
    && marker.namespace === expected.namespace;
}

function readJobScratchSentinel(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJobScratchSentinelAsync(dir) {
  try {
    const raw = await fs.promises.readFile(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function jobScratchRootForProject({
  tmpDir = os.tmpdir(),
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  return path.join(tmpDir, JOB_SCRATCH_ROOT_DIR, scratchNamespaceForProject(projectDir, runtimeRoot));
}

export function jobScratchDirForJob(jobId, {
  tmpDir = os.tmpdir(),
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  return path.join(jobScratchRootForProject({ tmpDir, projectDir, runtimeRoot }), `posse-job-${jobId}`);
}

export function writeJobScratchSentinel(dir, {
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  const payload = jobScratchOwnerPayload(projectDir, runtimeRoot);
  fs.writeFileSync(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return payload;
}

export async function writeJobScratchSentinelAsync(dir, {
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  const payload = jobScratchOwnerPayload(projectDir, runtimeRoot);
  await fs.promises.writeFile(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return payload;
}

export function cleanupOldJobScratchDirs({
  tmpDir = os.tmpdir(),
  scratchRoot = null,
  projectDir = process.cwd(),
  runtimeRoot = null,
  retentionMs = JOB_SCRATCH_RETENTION_MS,
  activeJobIds = [],
  nowMs = Date.now(),
} = {}) {
  const root = scratchRoot || jobScratchRootForProject({ tmpDir, projectDir, runtimeRoot });
  const expectedOwner = jobScratchOwnerPayload(projectDir, runtimeRoot);
  const active = new Set([...activeJobIds].map((id) => String(id)));
  let removed = 0;
  let failed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, failed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^posse-job-(\d+)$/.exec(entry.name);
    if (!match || active.has(match[1])) continue;
    const fullPath = path.join(root, entry.name);
    try {
      if (!markerMatchesProject(readJobScratchSentinel(fullPath), expectedOwner)) continue;
      const stat = fs.statSync(fullPath);
      const ageMs = nowMs - Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0);
      if (ageMs < retentionMs) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}

export async function cleanupOldJobScratchDirsAsync({
  tmpDir = os.tmpdir(),
  scratchRoot = null,
  projectDir = process.cwd(),
  runtimeRoot = null,
  retentionMs = JOB_SCRATCH_RETENTION_MS,
  activeJobIds = [],
  nowMs = Date.now(),
} = {}) {
  const root = scratchRoot || jobScratchRootForProject({ tmpDir, projectDir, runtimeRoot });
  const expectedOwner = jobScratchOwnerPayload(projectDir, runtimeRoot);
  const active = new Set([...activeJobIds].map((id) => String(id)));
  let removed = 0;
  let failed = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { removed, failed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^posse-job-(\d+)$/.exec(entry.name);
    if (!match || active.has(match[1])) continue;
    const fullPath = path.join(root, entry.name);
    try {
      if (!markerMatchesProject(await readJobScratchSentinelAsync(fullPath), expectedOwner)) continue;
      const stat = await fs.promises.stat(fullPath);
      const ageMs = nowMs - Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0);
      if (ageMs < retentionMs) continue;
      await fs.promises.rm(fullPath, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}

export function providerCircuitTtlSetting(fallback) {
  return readIntegerSetting(SETTING_KEYS.WORKER_PROVIDER_CIRCUIT_TTL_MS, fallback, { min: 1000 });
}
