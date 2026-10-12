import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
    try {
      fs.mkdirSync(lockPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`Another preserving update owns ${lockPath}; inspect it before removing a stale lock`);
      }
      throw error;
    }
    this.lockPath = lockPath;
    fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
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
