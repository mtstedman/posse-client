import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { demand, digest } from "../functions/policy.js";
import { parseCSV } from "../functions/csv.js";

const MAX_BYTES = 1024 * 1024;
// A held directory descriptor prevents a concurrent pathname/symlink switch
// between validation and IO. Other platforms fail closed until an equivalent
// native descriptor-relative resource adapter is installed.
export class ResourceSandbox {
  constructor(resources, grants, { signal, check = () => {}, checkpoint = () => null, namespace = "" } = {}) {
    this.resources = resources; this.grants = grants; this.signal = signal;
    this.checkpoint = checkpoint; this.namespace = namespace; this.staged = new Map(); this.checkpoints = [];
    this.checkAuthority = check;
    this.bytesRead = 0;
  }
  check() { this.signal?.throwIfAborted(); this.checkAuthority(); }
  withParent(resourceID, name, operation, fn, create = false) {
    this.check();
    const grant = this.grants.find(item => item.id === resourceID && item.operations.includes(operation));
    const resource = this.resources.find(item => item.id === resourceID && item.enabled !== false);
    demand(grant && resource && resource.operations.includes(operation), "Resource operation is not granted", "forbidden");
    demand(typeof name === "string" && !name.includes("\\") && !name.includes("\0") && !path.isAbsolute(name), "Invalid resource path");
    const parts = name.split("/");
    demand(parts.every(part => part && part !== "." && part !== ".." && part !== ".git" && part !== ".posse"), "Invalid resource path");
    if (process.platform !== "linux") return this.withPortableParent(resource, parts, fn, create);
    const handles = [];
    try {
      let fd = fs.openSync(resource.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); handles.push(fd);
      const stat = fs.fstatSync(fd);
      demand(String(stat.dev) === resource.device && String(stat.ino) === resource.inode, "Resource root identity changed", "resource_changed");
      for (const part of parts.slice(0, -1)) {
        const next = `/proc/self/fd/${fd}/${part}`;
        if (create) { try { fs.mkdirSync(next, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
        fd = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); handles.push(fd);
      }
      this.check();
      return fn(`/proc/self/fd/${fd}/${parts.at(-1)}`, fd);
    } finally { for (const fd of handles.reverse()) fs.closeSync(fd); }
  }
  withPortableParent(resource, parts, fn, create) {
    const rootStat = fs.statSync(resource.root);
    demand(rootStat.isDirectory() && String(rootStat.dev) === resource.device && String(rootStat.ino) === resource.inode, "Resource root identity changed", "resource_changed");
    let parent = resource.root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (create && !fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      const info = fs.lstatSync(parent);
      demand(info.isDirectory() && !info.isSymbolicLink(), "Resource path contains a link or non-directory", "resource_changed");
      const resolved = fs.realpathSync(parent);
      const relative = path.relative(resource.root, resolved);
      demand(relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "Resource path escaped its root", "resource_changed");
    }
    const filename = path.join(parent, parts.at(-1));
    if (fs.existsSync(filename)) demand(!fs.lstatSync(filename).isSymbolicLink(), "Resource target cannot be a link", "resource_changed");
    this.check();
    const result = fn(filename, parent);
    demand(!fs.lstatSync(parent).isSymbolicLink() && fs.realpathSync(parent) === parent, "Resource parent changed during access", "resource_changed");
    return result;
  }
  list(resource, directory = "", extension = "") {
    const prefix = directory ? directory + "/" : "";
    return this.withParent(resource, prefix + "unused", "list", (_filename, fd) => {
      const directory = fs.opendirSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : fd), entries = [];
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          this.check();
          demand(entries.length < 1000, "Resource directory exceeds 1000 entries");
          entries.push(entry);
        }
      } finally { directory.closeSync(); }
      return entries.filter(entry => entry.isFile() && !entry.name.startsWith(".") && (!extension || entry.name.endsWith(extension)))
        .map(entry => ({ path: prefix + entry.name })).sort((a, b) => a.path.localeCompare(b.path));
    });
  }
  read(resource, name) {
    return this.withParent(resource, name, "read", filename => {
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fs.fstatSync(fd);
        demand(before.isFile() && before.size <= MAX_BYTES && before.nlink === 1, "Resource must be a bounded, unaliased regular file");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let size = 0, count;
        do { this.check(); count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count; } while (count && size < buffer.length);
        demand(size <= MAX_BYTES, "Resource file exceeded limit");
        this.bytesRead += size;
        demand(this.bytesRead <= 8 * MAX_BYTES, "Aggregate resource read limit exceeded");
        const after = fs.fstatSync(fd);
        demand(before.mtimeMs === after.mtimeMs && before.size === after.size, "Resource changed while reading", "resource_changed");
        return { content: buffer.subarray(0, size).toString("utf8"), modified_at: before.mtimeMs };
      } finally { fs.closeSync(fd); }
    });
  }
  write(resource, name, content) {
    demand(typeof content === "string" && Buffer.byteLength(content) <= MAX_BYTES, "Artifact exceeds size limit");
    // Validate the grant and path even before staging; parents are created at commit.
    demand(this.grants.some(item => item.id === resource && item.operations.includes("write")), "Write resource not granted", "forbidden");
    demand(typeof name === "string" && name.split("/").every(part => part && ![".", "..", ".git", ".posse"].includes(part)) && !name.includes("\\") && !name.includes("\0") && !path.isAbsolute(name), "Invalid artifact path");
    demand(this.staged.size < 128 || this.staged.has(resource + ":" + name), "Artifact count limit exceeded");
    this.staged.set(resource + ":" + name, { resource, name, content });
    demand([...this.staged.values()].reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) <= 8 * MAX_BYTES, "Total artifact size limit exceeded");
    return { artifact: `${resource}/${name}` };
  }
  processCSV(input) {
    const processed = [], skipped = [];
    const ready = this.readyCSVFiles(input);
    for (const file of ready.files) {
      this.check();
      const data = this.read(input.source_resource, file.path);
      if (ready.kind === "stability_heuristic" && Date.now() - data.modified_at < ready.minAgeMs) { skipped.push(file.path); continue; }
      if (file.hash && contentHash(data.content) !== file.hash) demand(false, `Manifest hash mismatch for ${file.path}`, "resource_changed");
      const key = digest([this.namespace, input.source_resource, input.destination_resource, file.path, data.content]);
      const output = `${file.path}.json`;
      const previous = this.checkpoint(key);
      if (previous && this.outputMatches(input.destination_resource, output, previous.hash)) { skipped.push(file.path); continue; }
      const rows = parseCSV(data.content, () => this.check());
      const content = JSON.stringify(rows, null, 2) + "\n";
      this.write(input.destination_resource, output, content);
      this.checkpoints.push({ id: key, value: { source: file.path, output, hash: digest(content), at: new Date().toISOString() } });
      processed.push({ source: file.path, output, rows: rows.length });
    }
    return { processed, skipped };
  }
  readyCSVFiles(input) {
    const readiness = input.readiness || {};
    if (readiness.kind === "atomic_rename") {
      return { kind: readiness.kind, files: this.list(input.source_resource, "", ".ready.csv") };
    }
    if (readiness.kind === "manifest") {
      const manifest = JSON.parse(this.read(input.source_resource, readiness.manifest_path).content);
      demand(manifest?.version === 1 && Array.isArray(manifest.files) && manifest.files.length <= 1000, "Invalid CSV readiness manifest");
      const seen = new Set();
      const files = manifest.files.map(item => {
        demand(item && typeof item.path === "string" && item.path.endsWith(".csv") && /^[a-f0-9]{64}$/.test(item.sha256 || "") && !seen.has(item.path), "Invalid CSV readiness manifest entry");
        seen.add(item.path); return { path: item.path, hash: item.sha256 };
      });
      return { kind: readiness.kind, files };
    }
    demand(readiness.kind === "stability_heuristic", "CSV readiness protocol is required");
    return { kind: readiness.kind, minAgeMs: readiness.min_age_seconds * 1000, files: this.list(input.source_resource, "", ".csv") };
  }
  outputMatches(resource, name, hash) {
    try { return this.withParent(resource, name, "write", filename => {
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { return digest(this.readExisting(fd).toString("utf8")) === hash; }
      finally { fs.closeSync(fd); }
    }); } catch { return false; }
  }
  readExisting(fd) {
    const before = fs.fstatSync(fd);
    demand(before.isFile() && before.size <= MAX_BYTES, "Invalid existing artifact");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, count;
    do { this.check(); count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count; } while (count && size < buffer.length);
    const after = fs.fstatSync(fd);
    demand(size <= MAX_BYTES && before.size === after.size && before.mtimeMs === after.mtimeMs, "Existing artifact changed while reading");
    this.bytesRead += size;
    demand(this.bytesRead <= 8 * MAX_BYTES, "Aggregate resource read limit exceeded");
    return buffer.subarray(0, size);
  }
  manifest() { return { resources: this.resources, grants: this.grants, files: [...this.staged.values()].map(item => ({ resource: item.resource, name: item.name, hash: digest(item.content) })), checkpoints: this.checkpoints }; }
  reservations() {
    return [...this.staged.values()].map(item => {
      const resource = this.resources.find(value => value.id === item.resource);
      demand(resource, "Artifact resource is unavailable", "resource_changed");
      return { resource_identity: `${resource.device}:${resource.inode}`, relative_path: item.name };
    });
  }
  static reconcile(journal) {
    const sandbox = new ResourceSandbox(journal.resources, journal.grants);
    return journal.files.every(item => sandbox.outputMatches(item.resource, item.name, item.hash));
  }
  commit() {
    this.check();
    const completed = [];
    try {
      for (const item of this.staged.values()) {
        this.check();
        this.withParent(item.resource, item.name, "write", filename => {
          let original = null;
          try {
            const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try { original = this.readExisting(fd); } finally { fs.closeSync(fd); }
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          const temp = path.join(path.dirname(filename), `.posse-artifact-${randomUUID()}`);
          try {
            const fd = fs.openSync(temp, "wx", 0o600);
            try { fs.writeFileSync(fd, item.content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            this.check();
            // Rename replaces an inode; it never truncates a hard-link alias.
            fs.renameSync(temp, filename);
            completed.push({ ...item, original, stagedHash: digest(item.content) });
          } finally { try { fs.unlinkSync(temp); } catch {} }
        }, true);
      }
      return completed.map(item => `${item.resource}/${item.name}`);
    } catch (error) {
      const signal = this.signal, checkAuthority = this.checkAuthority; this.signal = null; this.checkAuthority = () => {};
      try {
        for (const item of completed.reverse()) this.withParent(item.resource, item.name, "write", filename => {
          const current = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
          try { demand(digest(this.readExisting(current).toString("utf8")) === item.stagedHash, "Artifact changed after this run wrote it", "rollback_conflict"); }
          finally { fs.closeSync(current); }
          if (item.original === null) fs.unlinkSync(filename);
          else { const temp = path.join(path.dirname(filename), `.posse-rollback-${randomUUID()}`); fs.writeFileSync(temp, item.original, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, filename); }
        });
      } catch { error.code = "rollback_failed"; }
      finally { this.signal = signal; this.checkAuthority = checkAuthority; }
      throw error;
    }
  }
}

function contentHash(value) { return createHash("sha256").update(value).digest("hex"); }
