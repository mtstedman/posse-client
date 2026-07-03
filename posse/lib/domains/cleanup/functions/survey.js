// lib/cleanup/survey.js
//
// Inventory the five buckets of posse leftovers: recovery snapshots, posse/*
// branches, orphan worktree dirs, dirty main tree, posse-labeled stashes.
// Pure deterministic — no LLM, no mutations.

import fs from "fs";
import path from "path";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { listWorkItems } from "../../queue/functions/index.js";
import { dirSizeBytes, worktreeRoot } from "../../git/functions/worktree.js";
import { gitExec, gitExecSafe } from "../../git/functions/utils.js";

const TERMINAL_WI_STATUS = new Set(TERMINAL_WORK_ITEM_STATUSES);

function git(argv, cwd) {
  if (!Array.isArray(argv)) {
    throw new TypeError(`survey.git requires an array of args, got ${typeof argv}`);
  }
  return gitExecSafe(argv, cwd, { timeoutMs: 10000 });
}

function gitStatus(argv, cwd) {
  if (!Array.isArray(argv)) {
    throw new TypeError(`survey.gitStatus requires an array of args, got ${typeof argv}`);
  }
  try {
    return {
      ok: true,
      stdout: gitExec(argv, cwd, { timeoutMs: 10000 }).trim(),
      error: null,
    };
  } catch (err) {
    return { ok: false, stdout: "", error: err?.message || String(err) };
  }
}

function humanizeAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function safeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function surveySnapshots(projectDir) {
  const now = Date.now();
  const out = [];

  // Preferred format: git refs under refs/posse/snapshots/*
  const refsRaw = git(["for-each-ref", "--format=%(refname)|%(objectname)|%(creatordate:unix)", "refs/posse/snapshots"], projectDir);
  for (const line of String(refsRaw || "").split("\n").filter(Boolean)) {
    const [refName, objectHash, createdUnix] = line.split("|");
    if (!refName || !objectHash) continue;
    const noteRaw = git(["notes", "--ref=refs/notes/posse-snapshots", "show", objectHash], projectDir);
    const note = safeJson(noteRaw) || {};
    let capturedAt = note.captured_at ? Date.parse(note.captured_at) : (Number(createdUnix) * 1000);
    if (!Number.isFinite(capturedAt)) capturedAt = now;
    const ageMs = Math.max(0, now - capturedAt);
    const id = refName.split("/").at(-1);
    out.push({
      id,
      storageType: note.storage === "branch-ref" ? "branch-ref" : "git-ref",
      projectDir: projectDir,
      refName,
      objectHash,
      path: null,
      ageMs,
      ageHuman: humanizeAge(ageMs),
      reason: note.reason || "dirty-worktree",
      branchName: note.branch_name || null,
      wiId: note.work_item_id ?? null,
      trackedCount: Array.isArray(note.tracked_dirty) ? note.tracked_dirty.length : 0,
      untrackedCount: Array.isArray(note.untracked) ? note.untracked.length : 0,
      sizeBytes: Number(note.diff_patch?.length || 0) + Number(note.staged_patch?.length || 0),
      headSha: note.head_sha || null,
      capturedAt: Number.isFinite(capturedAt) ? new Date(capturedAt).toISOString() : null,
    });
  }

  // Backward compatibility: legacy directory snapshots.
  const root = path.join(getRuntimeRoot(projectDir), "recovered-worktrees");
  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of entries) {
      const snapshotPath = path.join(root, entry.name);
      let manifest = {};
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(snapshotPath, "manifest.json"), "utf-8"));
      } catch { /* missing or malformed; keep empty */ }
      let capturedAt = manifest.captured_at ? Date.parse(manifest.captured_at) : NaN;
      if (!Number.isFinite(capturedAt)) {
        try { capturedAt = Number(fs.statSync(snapshotPath).mtimeMs); } catch { capturedAt = now; }
      }
      const ageMs = Math.max(0, now - capturedAt);
      out.push({
        id: entry.name,
        storageType: "directory",
        projectDir: projectDir,
        refName: null,
        objectHash: null,
        path: snapshotPath,
        ageMs,
        ageHuman: humanizeAge(ageMs),
        reason: manifest.reason || "unknown",
        branchName: manifest.branch_name || null,
        wiId: manifest.work_item_id ?? null,
        trackedCount: Array.isArray(manifest.tracked_dirty) ? manifest.tracked_dirty.length : 0,
        untrackedCount: Array.isArray(manifest.untracked) ? manifest.untracked.length : 0,
        sizeBytes: dirSizeBytes(snapshotPath),
        headSha: manifest.head_sha || null,
        capturedAt: Number.isFinite(capturedAt) ? new Date(capturedAt).toISOString() : null,
      });
    }
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

function surveyBranches(projectDir, targetBranch) {
  const raw = git(["for-each-ref", "--format=%(refname:short)|%(committerdate:iso-strict)", "refs/heads/posse/"], projectDir);
  if (!raw) return [];
  const branches = raw.split("\n").filter(Boolean);
  const wis = listWorkItems();
  const byBranch = new Map(wis.filter((w) => w.branch_name).map((w) => [w.branch_name, w]));
  const now = Date.now();
  const out = [];
  for (const line of branches) {
    const [name, lastCommitIso] = line.split("|");
    if (!name) continue;
    const wi = byBranch.get(name) || null;
    const wiId = wi ? wi.id : (name.match(/^posse\/wi-(\d+)/) || [])[1] || null;
    const wiStatus = wi ? wi.status : null;
    const mergeState = wi ? wi.merge_state : null;
    let mergedToTarget = false;
    if (targetBranch) {
      const mergedList = git(["branch", "--merged", targetBranch], projectDir);
      mergedToTarget = mergedList.split("\n").map((s) => s.replace(/^\*?\s+/, "").trim()).includes(name);
    }
    const lastCommitAt = lastCommitIso ? Date.parse(lastCommitIso) : NaN;
    const ageMs = Number.isFinite(lastCommitAt) ? Math.max(0, now - lastCommitAt) : null;
    out.push({
      name,
      wiId: wiId != null ? Number(wiId) : null,
      wiStatus,
      mergeState,
      mergedToTarget,
      targetBranch: targetBranch || null,
      lastCommitAt: Number.isFinite(lastCommitAt) ? new Date(lastCommitAt).toISOString() : null,
      ageMs,
      ageHuman: ageMs != null ? humanizeAge(ageMs) : null,
    });
  }
  return out.sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));
}

function surveyWorktrees(projectDir) {
  const root = worktreeRoot(projectDir);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("wi-"));
  const wis = new Map(listWorkItems().map((w) => [w.id, w]));
  const now = Date.now();
  const out = [];
  for (const entry of entries) {
    const wtPath = path.join(root, entry.name);
    const wiId = Number((entry.name.match(/^wi-(\d+)/) || [])[1]);
    const wi = Number.isFinite(wiId) ? wis.get(wiId) : null;
    const statusResult = gitStatus(["status", "--porcelain"], wtPath);
    const statusUnknown = !statusResult.ok;
    const hasChanges = statusUnknown ? true : Boolean(statusResult.stdout);
    let ageMs = null;
    try { ageMs = Math.max(0, now - Number(fs.statSync(wtPath).mtimeMs)); } catch { /* ignore */ }
    out.push({
      path: wtPath,
      wiId: Number.isFinite(wiId) ? wiId : null,
      wiStatus: wi ? wi.status : null,
      wiMissing: !wi,
      wiTerminal: wi ? TERMINAL_WI_STATUS.has(wi.status) : false,
      hasChanges,
      statusUnknown,
      statusError: statusUnknown ? statusResult.error : null,
      ageMs,
      ageHuman: ageMs != null ? humanizeAge(ageMs) : null,
    });
  }
  return out;
}

function surveyMainTree(projectDir) {
  const status = git(["status", "--porcelain"], projectDir);
  if (!status) return { dirty: false, fileCount: 0, files: [] };
  const lines = status.split("\n").filter(Boolean);
  return {
    dirty: true,
    fileCount: lines.length,
    files: lines.slice(0, 20).map((l) => l.trim()),
  };
}

function surveyStashes(projectDir) {
  const raw = git(["stash", "list", "--format=%gd%x00%H%x00%gs"], projectDir);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line, index) => {
    const parts = line.split("\0");
    let ref = parts[0] || `stash@{${index}}`;
    let objectHash = parts[1] || null;
    let label = parts.slice(2).join("\0") || line;
    if (parts.length < 3) {
      const m = line.match(/^(stash@\{\d+\}):\s*(.*)$/);
      ref = m ? m[1] : `stash@{${index}}`;
      label = m ? m[2] : line;
      objectHash = git(["rev-parse", ref], projectDir) || null;
    }
    const parsedIndex = Number((ref.match(/\{(\d+)\}/) || [])[1]);
    return {
      ref,
      index: Number.isFinite(parsedIndex) ? parsedIndex : index,
      objectHash,
      label,
      posseLabeled: /^(On\s+\S+:\s*)?posse:/.test(label) || label.includes("posse:"),
    };
  }).filter((s) => s.posseLabeled);
}

export function buildInventory(projectDir, targetBranch = null) {
  return {
    projectDir,
    targetBranch,
    capturedAt: new Date().toISOString(),
    snapshots: surveySnapshots(projectDir),
    branches: surveyBranches(projectDir, targetBranch),
    worktrees: surveyWorktrees(projectDir),
    mainTreeDirt: surveyMainTree(projectDir),
    stashes: surveyStashes(projectDir),
  };
}

export function inventoryIsEmpty(inv) {
  return inv.snapshots.length === 0
    && inv.branches.length === 0
    && inv.worktrees.length === 0
    && !inv.mainTreeDirt.dirty
    && inv.stashes.length === 0;
}

export function inventorySummary(inv) {
  return {
    snapshots: inv.snapshots.length,
    branches: inv.branches.length,
    worktrees: inv.worktrees.length,
    mainTreeDirty: inv.mainTreeDirt.dirty ? inv.mainTreeDirt.fileCount : 0,
    stashes: inv.stashes.length,
  };
}
