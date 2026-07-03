// Inspector helpers for posse admin: list recovered worktree snapshots
// (both git-ref-stored and legacy directory-stored) and render a quick
// console summary.

import fs from "fs";
import path from "path";
import { C } from "../../../shared/format/functions/colors.js";
import { GIT_OPERATION_TIMEOUT_MS, gitExec } from "../../git/functions/utils.js";
import { _batchReadNotes } from "../../project/functions/context.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";

function safeJsonLoose(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function fmtSnapshotAge(isoString) {
  const ts = Date.parse(String(isoString || ""));
  if (!Number.isFinite(ts)) return "unknown";
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 48) return `${hours}h ${remMin}m ago`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h ago`;
}

export function listRecoveredWorktreeSnapshots(projectDir, limit = 100) {
  const rows = [];

  // Preferred: git-native snapshot refs.
  try {
    const refsRaw = gitExec(
      [
        "for-each-ref",
        "--format=%(refname)|%(objectname)|%(creatordate:iso-strict)",
        "refs/posse/snapshots",
      ],
      projectDir,
      { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
    ).trim();
    const refRows = String(refsRaw || "").split("\n").filter(Boolean)
      .map((line) => {
        const [refName, objectHash, createdIso] = line.split("|");
        return refName && objectHash ? { refName, objectHash, createdIso } : null;
      })
      .filter(Boolean);
    const notesByHash = _batchReadNotes(projectDir, refRows.map((row) => row.objectHash));
    for (const { refName, objectHash, createdIso } of refRows) {
      const note = notesByHash.get(objectHash) || null;
      const createdAt = note?.captured_at || createdIso;
      const trackedDirty = Array.isArray(note?.tracked_dirty) ? note.tracked_dirty : [];
      const untracked = Array.isArray(note?.untracked) ? note.untracked : [];
      rows.push({
        name: refName.split("/").at(-1),
        storage: "git-ref",
        refName,
        dir: null,
        createdAt,
        age: fmtSnapshotAge(createdAt),
        reason: note?.reason || "dirty-worktree",
        wiId: note?.work_item_id ?? null,
        branch: note?.branch_name || null,
        trackedCount: trackedDirty.length,
        untrackedCount: untracked.length,
      });
    }
  } catch {
    // ignore
  }

  // Backward compatibility: directory snapshots.
  const root = path.join(getRuntimeRoot(projectDir), "recovered-worktrees");
  if (fs.existsSync(root)) {
    const legacy = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name);
        const manifestPath = path.join(dir, "manifest.json");
        const manifest = fs.existsSync(manifestPath)
          ? safeJsonLoose(fs.readFileSync(manifestPath, "utf-8"))
          : null;
        const stat = fs.statSync(dir);
        const createdAt = manifest?.created_at || stat.mtime.toISOString();
        const trackedDirty = Array.isArray(manifest?.tracked_dirty) ? manifest.tracked_dirty : [];
        const untracked = Array.isArray(manifest?.untracked) ? manifest.untracked : [];
        return {
          name: entry.name,
          storage: "directory",
          refName: null,
          dir,
          createdAt,
          age: fmtSnapshotAge(createdAt),
          reason: manifest?.reason || "dirty-worktree",
          wiId: manifest?.wi_id ?? null,
          branch: manifest?.branch_name || null,
          trackedCount: trackedDirty.length,
          untrackedCount: untracked.length,
        };
      });
    rows.push(...legacy);
  }

  return rows
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.max(1, limit));
}

export function cmdAdminWorktrees(projectDir) {
  const snapshots = listRecoveredWorktreeSnapshots(projectDir, 200);
  console.log(`\n  ${C.bold}Recovered Worktree Snapshots${C.reset}`);
  if (snapshots.length === 0) {
    console.log(`  ${C.dim}No recovered-worktrees snapshots found.${C.reset}\n`);
    return;
  }

  const trackedTotal = snapshots.reduce((sum, row) => sum + (row.trackedCount || 0), 0);
  const untrackedTotal = snapshots.reduce((sum, row) => sum + (row.untrackedCount || 0), 0);
  console.log(`  ${C.dim}Snapshots: ${snapshots.length}  tracked-dirty files: ${trackedTotal}  untracked files: ${untrackedTotal}${C.reset}`);
  console.log("");
  for (const row of snapshots) {
    const wiTag = row.wiId != null ? `WI#${row.wiId}` : "WI#?";
    const branch = row.branch ? ` ${C.dim}${row.branch}${C.reset}` : "";
    const storage = row.storage === "git-ref" ? "ref" : "dir";
    console.log(`  ${wiTag.padEnd(8)} ${row.age.padEnd(12)} ${String(row.reason || "dirty-worktree").padEnd(28)} tracked=${String(row.trackedCount).padStart(3)} untracked=${String(row.untrackedCount).padStart(3)} [${storage}]${branch}`);
    console.log(`           ${C.dim}${row.refName || row.dir}${C.reset}`);
  }
  console.log(`\n  ${C.dim}Tip: inspect ref snapshots with 'git show <ref>' and apply with 'git stash apply <ref>'.${C.reset}\n`);
}
