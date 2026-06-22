import fs from "fs";
import {
  cloneOwner,
  registerActiveWorktreeLockToken,
  removeLockIfOwner,
  removeLockIfOwnerAsync,
  sleepMs,
  sleepMsAsync,
  unregisterActiveWorktreeLockToken,
  writeReleasedMarker,
  writeReleasedMarkerAsync,
} from "../functions/worktree-locks.js";

export class WorktreeLock {
  #fd;
  #owner;
  #ownerToken;
  #released = false;

  constructor({ lockPath, fd, owner }) {
    this.acquired = true;
    this.lockPath = lockPath;
    this.#fd = fd;
    this.#owner = cloneOwner(owner);
    this.#ownerToken = owner?.ownerToken || null;
    registerActiveWorktreeLockToken(this.#ownerToken);
  }

  get fd() {
    return this.#fd;
  }

  get owner() {
    return cloneOwner(this.#owner);
  }

  get ownerToken() {
    return this.#ownerToken;
  }

  get isReleased() {
    return this.#released;
  }

  release() {
    if (this.#released) return true;
    try { if (this.#fd != null) fs.closeSync(this.#fd); } catch { /* ignore */ }
    this.#fd = null;
    this.#released = true;
    unregisterActiveWorktreeLockToken(this.#ownerToken);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (removeLockIfOwner(this.lockPath, this.#ownerToken)) return true;
      sleepMs(25 * (attempt + 1));
    }
    // Waiters can still time out instead of waiting forever. Never mark a lock
    // released unless it is still owned by this lock holder.
    return writeReleasedMarker(this.lockPath, this.#ownerToken);
  }

  async releaseAsync() {
    return this.release();
  }
}

export class AsyncWorktreeLock {
  #fileHandle;
  #owner;
  #ownerToken;
  #released = false;

  constructor({ lockPath, fileHandle, owner }) {
    this.acquired = true;
    this.lockPath = lockPath;
    this.#fileHandle = fileHandle;
    this.#owner = cloneOwner(owner);
    this.#ownerToken = owner?.ownerToken || null;
    registerActiveWorktreeLockToken(this.#ownerToken);
  }

  get fileHandle() {
    return this.#fileHandle;
  }

  get owner() {
    return cloneOwner(this.#owner);
  }

  get ownerToken() {
    return this.#ownerToken;
  }

  get isReleased() {
    return this.#released;
  }

  release() {
    throw new Error("Use releaseAsync() for async worktree locks");
  }

  async releaseAsync() {
    if (this.#released) return true;
    try { if (this.#fileHandle?.close) await this.#fileHandle.close(); } catch { /* ignore */ }
    this.#fileHandle = null;
    this.#released = true;
    unregisterActiveWorktreeLockToken(this.#ownerToken);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await removeLockIfOwnerAsync(this.lockPath, this.#ownerToken)) return true;
      await sleepMsAsync(25 * (attempt + 1)).catch(() => {});
    }
    // Waiters can still time out instead of waiting forever. Never mark a lock
    // released unless it is still owned by this lock holder.
    return writeReleasedMarkerAsync(this.lockPath, this.#ownerToken);
  }
}
