import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { Worker as NodeWorker } from "worker_threads";
import { getDb } from "../../../shared/storage/functions/index.js";
import { UNMERGED_WORK_ITEM_MERGE_STATES } from "../../../catalog/work-item.js";
import { ACTIVE_LEASE_STATUSES, FAILED_JOB_STATUSES, PARKED_JOB_STATUSES } from "../../queue/functions/common.js";
import { listWorkItems, listJobs } from "../../queue/functions/index.js";
import { getRuntimeDbPath, getRuntimeResourcesDir, getRuntimeRoot, normalizeProjectDir } from "../../runtime/functions/paths.js";
import { sanitizeWorkerExecArgv } from "../../runtime/functions/worker-exec-argv.js";

const PENDING_MERGE_STATES = new Set(UNMERGED_WORK_ITEM_MERGE_STATES);

function _safeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function _batchReadNotes(projectDir, objectHashes) {
  // Replaces an N+1 pattern (one `git notes show` per ref) with a single
  // `git cat-file --batch` call. Cuts up to 5+ git subprocess starts per
  // CLI invocation on repos with multiple snapshot refs.
  if (objectHashes.length === 0) return new Map();
  let notesMap = null;
  try {
    const listRaw = execFileSync("git", ["notes", "--ref=refs/notes/posse-snapshots", "list"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    notesMap = new Map();
    for (const line of String(listRaw || "").split("\n").filter(Boolean)) {
      const [noteSha, annotatedSha] = line.trim().split(/\s+/);
      if (noteSha && annotatedSha) notesMap.set(annotatedSha, noteSha);
    }
  } catch {
    return new Map();
  }

  const wanted = objectHashes
    .map((hash) => ({ hash, note: notesMap.get(hash) }))
    .filter((entry) => entry.note);
  if (wanted.length === 0) return new Map();

  const out = new Map();
  try {
    const stdin = wanted.map((entry) => entry.note).join("\n") + "\n";
    const batched = execFileSync("git", ["cat-file", "--batch"], {
      cwd: projectDir,
      input: stdin,
      encoding: "buffer",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    let cursor = 0;
    for (const entry of wanted) {
      const newlineIdx = batched.indexOf(0x0a, cursor);
      if (newlineIdx === -1) break;
      const header = batched.slice(cursor, newlineIdx).toString("utf-8").trim();
      cursor = newlineIdx + 1;
      const parts = header.split(/\s+/);
      // header is "<sha> <type> <size>" on a hit; "<sha> missing" on a miss.
      if (parts.length < 3) continue;
      const size = Number(parts[2]);
      if (!Number.isFinite(size)) continue;
      const body = batched.slice(cursor, cursor + size).toString("utf-8");
      cursor += size + 1; // skip trailing newline that git appends
      out.set(entry.hash, _safeJson(body));
    }
  } catch {
    // best-effort; callers tolerate missing notes
  }
  return out;
}

function _latestRecoverySnapshots(projectDir, limit = 5) {
  const out = [];

  try {
    const refsRaw = execFileSync("git", ["for-each-ref", "--format=%(refname)|%(objectname)|%(creatordate:iso-strict)", "refs/posse/snapshots"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    const rows = String(refsRaw || "").split("\n").filter(Boolean)
      .map((line) => {
        const [refName, objectHash, createdAt] = line.split("|");
        return refName && objectHash ? { refName, objectHash, createdAt } : null;
      })
      .filter(Boolean);
    const notesByHash = _batchReadNotes(projectDir, rows.map((row) => row.objectHash));
    for (const row of rows) {
      const note = notesByHash.get(row.objectHash) || null;
      out.push({
        dir: row.refName,
        name: row.refName.split("/").at(-1),
        createdAt: note?.captured_at || row.createdAt,
        reason: note?.reason || "dirty-worktree",
        wiId: note?.work_item_id ?? null,
        branch: note?.branch_name || null,
        trackedDirty: note?.tracked_dirty || [],
        untracked: note?.untracked || [],
      });
    }
  } catch {
    // ignore
  }

  const root = path.join(getRuntimeRoot(projectDir), "recovered-worktrees");
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = path.join(root, entry.name);
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? _safeJson(fs.readFileSync(manifestPath, "utf-8"))
        : null;
      out.push({
        dir,
        name: entry.name,
        createdAt: manifest?.created_at || fs.statSync(dir).mtime.toISOString(),
        reason: manifest?.reason || "dirty-worktree",
        wiId: manifest?.wi_id ?? null,
        branch: manifest?.branch_name || null,
        trackedDirty: manifest?.tracked_dirty || [],
        untracked: manifest?.untracked || [],
      });
    }
  }

  return out
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function _recentHumanAnswers(jobs, limit = 5) {
  return jobs
    .filter((job) => job.job_type === "human_input" && job.status === "succeeded")
    .sort((a, b) => String(b.updated_at || b.finished_at || "").localeCompare(String(a.updated_at || a.finished_at || "")))
    .slice(0, limit)
    .map((job) => {
      const result = _safeJson(job.result_json) || {};
      const answers = Array.isArray(result.answers)
        ? result.answers
        : (result.answer ? [result.answer] : []);
      const answer = answers[0];
      return {
        jobId: job.id,
        wiId: job.work_item_id,
        title: job.title,
        answer: typeof answer === "string" ? answer.slice(0, 220) : JSON.stringify(answer || "").slice(0, 220),
      };
    });
}

function _recentFailures(jobs, limit = 5) {
  const failureOrAttentionStatuses = new Set([...FAILED_JOB_STATUSES, "waiting_on_review", "blocked"]);
  return jobs
    .filter((job) => failureOrAttentionStatuses.has(job.status))
    .sort((a, b) => String(b.updated_at || b.finished_at || "").localeCompare(String(a.updated_at || a.finished_at || "")))
    .slice(0, limit)
    .map((job) => ({
      jobId: job.id,
      wiId: job.work_item_id,
      status: job.status,
      title: job.title,
      error: String(job.last_error || "").split("\n")[0].slice(0, 220),
    }));
}

function _buildSummaryLines(items, formatter) {
  if (items.length === 0) return "None.";
  return items.map(formatter).join("\n");
}

export function buildStartupDigest(projectDir) {
  const workItems = listWorkItems();
  const jobs = listJobs();

  const blockedJobs = jobs
    .filter((job) => PARKED_JOB_STATUSES.includes(job.status))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 8);
  const pendingMerges = workItems
    .filter((wi) => PENDING_MERGE_STATES.has(wi.merge_state))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 8);
  const snapshots = _latestRecoverySnapshots(projectDir, 6);
  const humanAnswers = _recentHumanAnswers(jobs, 6);
  const failures = _recentFailures(jobs, 8);

  const digest = [
    "# Posse Startup Context",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Current Status",
    `- Work items: ${workItems.length}`,
    `- Active jobs: ${jobs.filter((job) => ["queued", ...ACTIVE_LEASE_STATUSES].includes(job.status)).length}`,
    `- Blocked jobs: ${blockedJobs.length}`,
    `- Pending merges: ${pendingMerges.length}`,
    `- Dirty worktree snapshots: ${snapshots.length}`,
    "",
    "## Blocked Jobs",
    _buildSummaryLines(blockedJobs, (job) => `- WI#${job.work_item_id} JOB#${job.id} [${job.status}] ${job.title}`),
    "",
    "## Pending Merges",
    _buildSummaryLines(pendingMerges, (wi) => `- WI#${wi.id} [${wi.merge_state}] ${wi.title}`),
    "",
    "## Preserved Dirty Worktrees",
    _buildSummaryLines(snapshots, (snapshot) => {
      const tracked = snapshot.trackedDirty.length;
      const untracked = snapshot.untracked.length;
      return `- ${snapshot.name} (${snapshot.reason})${snapshot.wiId ? ` WI#${snapshot.wiId}` : ""}${snapshot.branch ? ` ${snapshot.branch}` : ""} [tracked:${tracked} untracked:${untracked}]`;
    }),
    "",
    "## Recent Human Answers",
    _buildSummaryLines(humanAnswers, (entry) => `- WI#${entry.wiId} JOB#${entry.jobId} ${entry.title}: ${entry.answer || "(no answer text recorded)"}`),
    "",
    "## Latest Failures",
    _buildSummaryLines(failures, (job) => `- WI#${job.wiId} JOB#${job.jobId} [${job.status}] ${job.title}${job.error ? ` - ${job.error}` : ""}`),
    "",
  ].join("\n");

  return {
    digest,
    stats: {
      workItems: workItems.length,
      blockedJobs: blockedJobs.length,
      pendingMerges: pendingMerges.length,
      dirtySnapshots: snapshots.length,
    },
    blockedJobs,
    pendingMerges,
    snapshots,
    humanAnswers,
    failures,
  };
}

export function refreshProjectContext(projectDir, { writeDigest = true } = {}) {
  const runtimeRoot = getRuntimeRoot(projectDir);
  fs.mkdirSync(runtimeRoot, { recursive: true });

  const built = buildStartupDigest(projectDir);
  const digestPath = path.join(runtimeRoot, "startup-context.md");
  if (writeDigest) {
    fs.writeFileSync(digestPath, built.digest, "utf-8");
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO project_context (
      project_key,
      current_status_summary,
      blocked_summary,
      pending_merge_summary,
      dirty_snapshot_summary,
      recent_human_summary,
      recent_failure_summary,
      startup_digest_path,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(project_key) DO UPDATE SET
      current_status_summary = excluded.current_status_summary,
      blocked_summary = excluded.blocked_summary,
      pending_merge_summary = excluded.pending_merge_summary,
      dirty_snapshot_summary = excluded.dirty_snapshot_summary,
      recent_human_summary = excluded.recent_human_summary,
      recent_failure_summary = excluded.recent_failure_summary,
      startup_digest_path = excluded.startup_digest_path,
      updated_at = excluded.updated_at
  `).run(
    "default",
    `work_items=${built.stats.workItems}; blocked_jobs=${built.stats.blockedJobs}; pending_merges=${built.stats.pendingMerges}; dirty_snapshots=${built.stats.dirtySnapshots}`,
    _buildSummaryLines(built.blockedJobs, (job) => `WI#${job.work_item_id} JOB#${job.id} [${job.status}] ${job.title}`),
    _buildSummaryLines(built.pendingMerges, (wi) => `WI#${wi.id} [${wi.merge_state}] ${wi.title}`),
    _buildSummaryLines(built.snapshots, (snapshot) => `${snapshot.name}${snapshot.wiId ? ` WI#${snapshot.wiId}` : ""}`),
    _buildSummaryLines(built.humanAnswers, (entry) => `WI#${entry.wiId} JOB#${entry.jobId}: ${entry.answer || "(no answer)"}`),
    _buildSummaryLines(built.failures, (job) => `WI#${job.wiId} JOB#${job.jobId} [${job.status}] ${job.title}`),
    digestPath,
  );

  return { ...built, digestPath };
}

export function refreshProjectContextAsync(projectDir, { writeDigest = true, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new NodeWorker(new URL("./context-worker.js", import.meta.url), {
      execArgv: sanitizeWorkerExecArgv(),
      workerData: {
        projectDir,
        writeDigest,
        runtimePathOverrides: {
          projectDir: normalizeProjectDir(projectDir),
          runtimeRoot: getRuntimeRoot(projectDir),
          dbPath: getRuntimeDbPath(projectDir),
          resourcesDir: getRuntimeResourcesDir(projectDir),
        },
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch { /* best effort */ }
      reject(new Error(`Project context refresh timed out after ${timeoutMs}ms`));
    }, Math.max(1_000, Number(timeoutMs) || 30_000));
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    worker.on("message", (message = {}) => {
      if (message.ok) {
        settle(resolve, message.result);
      } else {
        const err = new Error(message.error || "project context worker failed");
        if (message.stack) err.stack = message.stack;
        settle(reject, err);
      }
    });
    worker.on("error", (err) => settle(reject, err));
    worker.on("exit", (code) => {
      if (code !== 0) settle(reject, new Error(`project context worker exited with code ${code}`));
      else settle(reject, new Error("project context worker exited before returning a result"));
    });
  });
}

export function getProjectContextRow() {
  return getDb().prepare(`SELECT * FROM project_context WHERE project_key = ?`).get("default") || null;
}
