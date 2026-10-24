import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isProcessAlive } from "../../../shared/platform/functions/process-liveness.js";
import { randomUUID } from "node:crypto";

// Publish a nonempty owner directory atomically. Stale recovery only unlinks
// the observed owner's unique filename; a concurrent replacement is nonempty
// and cannot be removed by rmdir. No SQLite binding is loaded by the updater.
async function acquireDirectoryGuard(guardPath, { waitMs = 1000, pollMs = 25 } = {}) {
  const deadline = Date.now() + waitMs;
  const token = `owner-${process.pid}-${randomUUID()}.json`;
  const candidate = `${guardPath}.${token}.pending`;
  fs.mkdirSync(candidate);
  try {
    fs.writeFileSync(path.join(candidate, token), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: "wx" });
    for (;;) {
      let entries = null;
      try { entries = fs.readdirSync(guardPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (entries?.length === 0) {
        // Legacy mkdir-before-metadata locks have no identity. Give an active
        // legacy writer time to publish; new acquisitions have no empty window.
        try { if (Date.now() - fs.statSync(guardPath).mtimeMs < 5000) entries = ["initializing"]; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (entries === null || entries.length === 0) {
        try {
          // Windows does not replace even an empty directory on rename.
          // A replacement owner is nonempty, so rmdir cannot remove it.
          if (entries?.length === 0) fs.rmdirSync(guardPath);
          fs.renameSync(candidate, guardPath);
          return { acquired: true, release: () => {
            try { fs.unlinkSync(path.join(guardPath, token)); } catch (error) { if (error.code !== "ENOENT") throw error; }
            try { fs.rmdirSync(guardPath); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
          } };
        } catch (error) { if (!["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error; }
      } else if (!entries.includes("initializing")) {
        for (const entry of entries) {
          if (entry !== "owner.json" && !/^owner-\d+-[a-f0-9-]+\.json$/.test(entry)) continue;
          let owner;
          try { owner = JSON.parse(fs.readFileSync(path.join(guardPath, entry), "utf8")); } catch { continue; }
          if (isProcessAlive(owner.pid) !== false) continue;
          try { fs.unlinkSync(path.join(guardPath, entry)); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        try { fs.rmdirSync(guardPath); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
      }
      if (entries?.some((entry) => entry.startsWith("owner")) && !fs.existsSync(guardPath)) continue;
      if (Date.now() >= deadline) return { acquired: false, release: () => {} };
      await sleep(pollMs);
    }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}

// Owns the preservation window for an opt-in update of a dirty installation.
// Saved work stays in Git; it is never reapplied over the fresh installation.
export class PosseUpdateWork {
  constructor({ repoRoot, git }) {
    this.repoRoot = repoRoot;
    this.git = git;
    this.lockPath = null;
    this.savedWork = null;
  }

  async acquire() {
    const result = await this.git(["rev-parse", "--git-path", "posse-update.lock"], { cwd: this.repoRoot });
    const lockPath = path.resolve(this.repoRoot, String(result.stdout).trim());
    // The guard serializes directory creation and stale-owner recovery,
    // including a reclaimer that itself dies midway through cleanup.
    const guard = await acquireDirectoryGuard(`${lockPath}.guard`, { waitMs: 1000 });
    if (!guard.acquired) throw new Error(`Another preserving update owns ${lockPath}`);
    try {
      const lock = await acquireDirectoryGuard(lockPath, { waitMs: 0 });
      if (!lock.acquired) throw new Error(`Another preserving update owns ${lockPath}`);
      this.lockPath = lockPath;
      this.releaseLock = lock.release;
    } finally { guard.release(); }
  }

  async save() {
    const label = `posse-update-${randomUUID()}`;
    // Record the searchable label before Git runs: even a partially failed
    // stash remains recoverable without trusting a moving stash@{0} ref.
    this.savedWork = { message: label, retained: false };
    await this.git(["stash", "push", "--include-untracked", "--message", label], { cwd: this.repoRoot });
    const list = await this.git(["stash", "list", "--format=%H%x09%gs"], { cwd: this.repoRoot });
    const entry = String(list.stdout).split(/\r?\n/u).find((line) => line.endsWith(`: ${label}`));
    const oid = entry?.split("\t")[0];
    if (!/^[0-9a-f]{40,64}$/iu.test(oid || "")) {
      throw new Error(`Could not verify saved local work; inspect git stash list for ${label}`);
    }
    this.savedWork.oid = oid;
    this.savedWork.retained = true;
  }

  release() {
    if (!this.lockPath) return;
    this.releaseLock?.();
    this.lockPath = null;
  }
}
