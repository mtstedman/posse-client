import fs from "fs";
import path from "path";
import { getRuntimeLogDir } from "../../../../domains/runtime/functions/paths.js";

export class DatedRotatingLog {
  constructor({
    dir = null,
    retentionDays = 3,
    filePrefix,
    fileSuffix = ".log",
    clock = () => new Date(),
    onOpenError = null,
  } = {}) {
    if (!filePrefix) throw new Error("DatedRotatingLog requires filePrefix");
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.filePrefix = filePrefix;
    this.fileSuffix = fileSuffix;
    this.clock = clock;
    this.onOpenError = onOpenError;
    this._fd = null;
    this._currentDate = "";
    this._lastPruneDate = "";
    this._initFailed = false;
  }

  _today() {
    return this.clock().toISOString().slice(0, 10);
  }

  _resolveLogDir() {
    return this.dir || getRuntimeLogDir();
  }

  _filePath(logDir, stamp = this._today()) {
    return path.join(logDir, `${this.filePrefix}${stamp}${this.fileSuffix}`);
  }

  open() {
    const logDir = this._resolveLogDir();
    const today = this._today();
    if (this._fd && this._currentDate === today) return { fd: this._fd, logDir };
    this.close();
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this._fd = fs.openSync(this._filePath(logDir, today), "a");
      this._currentDate = today;
      this._initFailed = false;
      return { fd: this._fd, logDir };
    } catch (err) {
      if (!this._initFailed && typeof this.onOpenError === "function") {
        this._initFailed = true;
        this.onOpenError(err, logDir);
      }
      return { fd: null, logDir };
    }
  }

  pruneOldLogs(logDir = this._resolveLogDir()) {
    const today = this._today();
    if (this._lastPruneDate === today) return;
    this._lastPruneDate = today;
    try {
      const cutoff = this.clock();
      cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
      const cutoffStamp = cutoff.toISOString().slice(0, 10);
      for (const name of fs.readdirSync(logDir)) {
        if (!name.startsWith(this.filePrefix) || !name.endsWith(this.fileSuffix)) continue;
        const stamp = name.slice(this.filePrefix.length, this.filePrefix.length + 10);
        if (stamp && stamp < cutoffStamp) {
          try { fs.rmSync(path.join(logDir, name), { force: true }); } catch { /* ignore */ }
        }
      }
    } catch {
      // Best effort retention.
    }
  }

  write(line) {
    const { fd, logDir } = this.open();
    if (!fd) return false;
    this.pruneOldLogs(logDir);
    try {
      fs.writeSync(fd, `${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  listFiles() {
    try {
      const logDir = this._resolveLogDir();
      return fs.readdirSync(logDir)
        .filter((name) => name.startsWith(this.filePrefix) && name.endsWith(this.fileSuffix))
        .sort()
        .map((name) => path.join(logDir, name));
    } catch {
      return [];
    }
  }

  readRecentEntries({
    limit = 50,
    parseLine = (line) => line,
    predicate = () => true,
  } = {}) {
    const files = this.listFiles().reverse();
    const out = [];
    for (const file of files) {
      let lines;
      try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); }
      catch { continue; }
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i].trim();
        if (!raw) continue;
        let record;
        try { record = parseLine(raw); } catch { continue; }
        if (!predicate(record)) continue;
        out.push(record);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  close() {
    if (this._fd) {
      try { fs.closeSync(this._fd); } catch { /* ignore */ }
      this._fd = null;
      this._currentDate = "";
    }
  }
}
