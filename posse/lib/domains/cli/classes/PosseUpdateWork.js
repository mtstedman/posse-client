import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isProcessAlive } from "../../../shared/platform/functions/process-liveness.js";
import { randomUUID } from "node:crypto";

// A directory lock with a recorded owner, reclaimed only once that owner has
// exited. The update parent must stay free of the SQLite addon (Windows
// cannot replace a loaded better-sqlite3 binding while it updates), so the
// SQLite-backed worktree lock is not usable here; the filesystem gives the
// same serialization for the short creation window.
async function acquireDirectoryGuard(guardPath, { waitMs = 1000, pollMs = 25 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(guardPath);
      fs.writeFileSync(path.join(guardPath, "owner.json"), `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
      return { acquired: true, release: () => fs.rmSync(guardPath, { recursive: true, force: true }) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(guardPath, "owner.json"), "utf8")); } catch { /* a guard without metadata is in creation or legacy */ }
    if (owner && isProcessAlive(owner.pid) === false) {
      fs.rmSync(guardPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return { acquired: false, release: () => {} };
    await sleep(pollMs);
  }
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
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")); } catch { /* a legacy lock without metadata remains protected */ }
      if (owner && isProcessAlive(owner.pid) === false) fs.rmSync(lockPath, { recursive: true, force: true });
      try {
        fs.mkdirSync(lockPath);
      } catch (error) {
        if (error.code === "EEXIST") throw new Error(`Another preserving update owns ${lockPath}; inspect it before removing a stale lock`);
        throw error;
      }
      this.lockPath = lockPath;
      try {
        fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
      } catch (error) {
        this.release();
        throw error;
      }
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
    fs.rmSync(this.lockPath, { recursive: true, force: true });
    this.lockPath = null;
  }
}
