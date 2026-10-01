import fsp from "fs/promises";
import path from "path";
import { performance } from "perf_hooks";
import { CLAUDE_USAGE_LOG_SCAN_LIMITS } from "../../../../catalog/provider.js";

const SCAN_CACHE_VERSION = 1;
const TAIL_FINGERPRINT_BYTES = 64;
const NEWLINE = 0x0a;
const USAGE_KEY = Buffer.from("\"usage\"");

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function newCursor() {
  return { size: -1, mtimeMs: null, ino: null, offset: 0, tail: "", entries: new Map() };
}

// Incremental scanner over Claude's local project logs
// (`<configDir>/projects/<project>/**/*.jsonl`). It keeps a per-file cursor
// (size, mtime, inode, consumed byte offset, and a fingerprint of the bytes
// just before that offset) plus the per-message usage entries each file
// contributed, persisted next to the OAuth usage cache. A refresh reads only
// bytes appended since the last refresh, streams them in bounded chunks,
// yields to the event loop between slices, and stops at the byte/time budget,
// leaving the remaining files for the next refresh. Dedupe matches the former
// whole-file reader: per file, lines sharing a message id collapse to the
// largest token total and latest timestamp; lines older than the window are
// ignored.
export class ClaudeUsageLogScanner {
  constructor({ configDir, cachePath, windowMs, limits = CLAUDE_USAGE_LOG_SCAN_LIMITS }) {
    this.configDir = configDir;
    this.projectsDir = path.join(configDir, "projects");
    this.cachePath = cachePath;
    this.windowMs = windowMs;
    this.limits = { ...CLAUDE_USAGE_LOG_SCAN_LIMITS, ...(limits || {}) };
    this.cursors = new Map();
    this.loaded = false;
    this.complete = false;
    this.dirty = false;
    this.inflight = null;
    this.sliceStart = 0;
  }

  // Concurrent callers share one in-flight scan.
  refresh(nowMs = Date.now()) {
    if (!this.inflight) {
      this.inflight = this.#refresh(nowMs).finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  // In-memory entries inside the window, or null until a refresh has covered
  // every file. Performs no I/O.
  snapshot(nowMs = Date.now()) {
    if (!this.complete) return null;
    const cutoff = nowMs - this.windowMs;
    const entries = [];
    for (const cursor of this.cursors.values()) {
      if (!(cursor.mtimeMs >= cutoff)) continue;
      for (const entry of cursor.entries.values()) {
        if (entry.timestampMs >= cutoff) entries.push(entry);
      }
    }
    return entries;
  }

  async #refresh(nowMs) {
    const started = performance.now();
    this.sliceStart = started;
    const budget = { bytesRead: 0, deadline: started + this.limits.refreshTimeBudgetMs };
    if (!this.loaded) {
      await this.#loadPersisted();
      this.loaded = true;
    }

    const cutoff = nowMs - this.windowMs;
    const files = await this.#listFiles();
    const seen = new Set(files);
    for (const filePath of Array.from(this.cursors.keys())) {
      if (seen.has(filePath)) continue;
      this.cursors.delete(filePath);
      this.dirty = true;
    }

    let deferred = false;
    for (const filePath of files) {
      if (this.#budgetExhausted(budget)) {
        deferred = true;
        break;
      }
      if (!(await this.#scanFile(filePath, cutoff, budget))) {
        deferred = true;
        break;
      }
    }

    this.#prune(cutoff);
    this.complete = !deferred;
    if (this.dirty) await this.#persist();
    return { complete: this.complete, bytesRead: budget.bytesRead, files: files.length };
  }

  #budgetExhausted(budget) {
    return budget.bytesRead >= this.limits.refreshByteBudget || performance.now() >= budget.deadline;
  }

  #shouldYield() {
    return performance.now() - this.sliceStart >= this.limits.yieldSliceMs;
  }

  async #yield() {
    await yieldToEventLoop();
    this.sliceStart = performance.now();
  }

  async #readdir(dir) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      this.sliceStart = performance.now();
      return entries;
    } catch {
      return null;
    }
  }

  // Same file set as the former reader: every *.jsonl file beneath each
  // directory directly under projects/.
  async #listFiles() {
    const projectEntries = await this.#readdir(this.projectsDir);
    if (!projectEntries) return [];
    const files = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;
      const stack = [path.join(this.projectsDir, projectEntry.name)];
      while (stack.length) {
        const current = stack.pop();
        const entries = await this.#readdir(current);
        if (!entries) continue;
        for (const entry of entries) {
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(fullPath);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
        }
      }
    }
    return files;
  }

  // Returns false when the budget ran out mid-file; the cursor keeps the
  // offset of the last complete line so the next refresh resumes there.
  async #scanFile(filePath, cutoff, budget) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      if (this.cursors.delete(filePath)) this.dirty = true;
      return true;
    }
    this.sliceStart = performance.now();
    if (stat.mtimeMs < cutoff) {
      // Not read by the former reader either; drop its entries so a later
      // append re-reads it from the start.
      if (this.cursors.delete(filePath)) this.dirty = true;
      return true;
    }

    let cursor = this.cursors.get(filePath);
    if (cursor && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs && cursor.ino === stat.ino) return true;
    if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.offset) {
      cursor = newCursor();
      this.cursors.set(filePath, cursor);
    }

    let handle;
    try {
      handle = await fsp.open(filePath, "r");
    } catch {
      if (this.cursors.delete(filePath)) this.dirty = true;
      return true;
    }
    this.dirty = true;
    try {
      if (cursor.offset > 0 && !(await this.#tailMatches(handle, cursor))) {
        // Rewritten in place (same inode): start over.
        cursor = newCursor();
        this.cursors.set(filePath, cursor);
      }
      const finished = await this.#readAppended(handle, filePath, cursor, stat.size, cutoff, budget);
      cursor.tail = await this.#readTail(handle, cursor.offset);
      if (finished) {
        cursor.size = stat.size;
        cursor.mtimeMs = stat.mtimeMs;
        cursor.ino = stat.ino;
      } else {
        cursor.size = -1;
        cursor.ino = stat.ino;
      }
      return finished;
    } catch {
      this.cursors.delete(filePath);
      return true;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async #readTail(handle, offset) {
    if (offset <= 0) return "";
    const length = Math.min(TAIL_FINGERPRINT_BYTES, offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    return buffer.subarray(0, bytesRead).toString("base64");
  }

  async #tailMatches(handle, cursor) {
    return (await this.#readTail(handle, cursor.offset)) === cursor.tail;
  }

  async #readAppended(handle, filePath, cursor, endOffset, cutoff, budget) {
    const chunk = Buffer.allocUnsafe(Math.max(4096, this.limits.readChunkBytes));
    let position = cursor.offset;
    let pending = [];
    while (position < endOffset) {
      if (this.#budgetExhausted(budget)) return false;
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, endOffset - position), position);
      this.sliceStart = performance.now();
      if (bytesRead <= 0) break;
      budget.bytesRead += bytesRead;
      const view = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (;;) {
        const newline = view.indexOf(NEWLINE, lineStart);
        if (newline === -1) break;
        const piece = view.subarray(lineStart, newline);
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        this.#ingestLine(line, filePath, cursor, cutoff);
        lineStart = newline + 1;
        cursor.offset = position + lineStart;
        if (this.#shouldYield()) await this.#yield();
      }
      if (lineStart < bytesRead) pending.push(Buffer.from(view.subarray(lineStart)));
      position += bytesRead;
    }
    // The former reader also parsed a final line without a trailing newline.
    // Keep the offset at its start so an append re-reads it; the per-message
    // merge is idempotent.
    if (pending.length) this.#ingestLine(Buffer.concat(pending), filePath, cursor, cutoff);
    return true;
  }

  #ingestLine(line, filePath, cursor, cutoff) {
    if (line.indexOf(USAGE_KEY) === -1) return;
    const text = line.toString("utf8");
    if (!text.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    const usage = parsed?.message?.usage;
    const timestamp = parsed?.timestamp;
    if (!usage || !timestamp) return;

    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < cutoff) return;

    const totalTokens =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.output_tokens || 0);
    if (totalTokens <= 0) return;

    const messageId = parsed?.message?.id || parsed?.requestId || parsed?.uuid || `${filePath}:${timestamp}`;
    const existing = cursor.entries.get(messageId);
    if (!existing) {
      cursor.entries.set(messageId, { messageId, timestampMs, totalTokens });
      return;
    }
    if (totalTokens > existing.totalTokens) existing.totalTokens = totalTokens;
    if (timestampMs > existing.timestampMs) existing.timestampMs = timestampMs;
  }

  #prune(cutoff) {
    for (const cursor of this.cursors.values()) {
      for (const [messageId, entry] of cursor.entries) {
        if (entry.timestampMs >= cutoff) continue;
        cursor.entries.delete(messageId);
        this.dirty = true;
      }
    }
  }

  async #loadPersisted() {
    let raw;
    try {
      raw = await fsp.readFile(this.cachePath, "utf8");
    } catch {
      return;
    }
    this.sliceStart = performance.now();
    const lines = raw.split("\n");
    let header;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      return;
    }
    if (header?.version !== SCAN_CACHE_VERSION) return;
    if (path.resolve(String(header.configDir || "")) !== path.resolve(this.configDir)) return;
    for (let index = 1; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      try {
        const [filePath, size, mtimeMs, ino, offset, tail, entries] = JSON.parse(lines[index]);
        if (typeof filePath !== "string" || !Array.isArray(entries)) continue;
        const cursor = newCursor();
        cursor.size = Number.isFinite(size) ? size : -1;
        cursor.mtimeMs = Number.isFinite(mtimeMs) ? mtimeMs : null;
        cursor.ino = ino ?? null;
        cursor.offset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
        cursor.tail = typeof tail === "string" ? tail : "";
        for (const [messageId, timestampMs, totalTokens] of entries) {
          cursor.entries.set(messageId, { messageId, timestampMs, totalTokens });
        }
        this.cursors.set(filePath, cursor);
      } catch {
        continue;
      }
      if (this.#shouldYield()) await this.#yield();
    }
  }

  async #persist() {
    const lines = [JSON.stringify({ version: SCAN_CACHE_VERSION, configDir: this.configDir })];
    for (const [filePath, cursor] of this.cursors) {
      lines.push(JSON.stringify([
        filePath,
        cursor.size,
        cursor.mtimeMs,
        cursor.ino,
        cursor.offset,
        cursor.tail,
        Array.from(cursor.entries.values(), (entry) => [entry.messageId, entry.timestampMs, entry.totalTokens]),
      ]));
      if (this.#shouldYield()) await this.#yield();
    }
    const tempPath = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fsp.writeFile(tempPath, `${lines.join("\n")}\n`, "utf8");
      await fsp.rename(tempPath, this.cachePath);
      this.dirty = false;
    } catch {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
