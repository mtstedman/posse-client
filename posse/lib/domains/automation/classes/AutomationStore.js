import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { demand } from "../functions/policy.js";

// One private store belongs to the headless owner, never to a repository queue.
export class AutomationStore {
  constructor(filename) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      if (fs.existsSync(filename)) demand(!fs.lstatSync(filename).isSymbolicLink(), "Store cannot be a symlink");
      else fs.closeSync(fs.openSync(filename, "wx", 0o600));
      fs.chmodSync(filename, 0o600);
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS automation_objects(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,idem TEXT UNIQUE,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_checkpoints(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_output_reservations(
        run_id TEXT NOT NULL,resource_identity TEXT NOT NULL,relative_path TEXT NOT NULL,state TEXT NOT NULL,
        PRIMARY KEY(run_id,resource_identity,relative_path));`);
    const leaseColumns = this.db.prepare("PRAGMA table_info(automation_leases)").all();
    if (!leaseColumns.some(column => column.name === "generation")) {
      this.db.exec("ALTER TABLE automation_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
  }
  get(kind, id) { const row = this.db.prepare("SELECT value FROM automation_objects WHERE kind=? AND id=?").get(kind, id); return row ? JSON.parse(row.value) : null; }
  list(kind) { return this.db.prepare("SELECT value FROM automation_objects WHERE kind=? ORDER BY id").all(kind).map(row => JSON.parse(row.value)); }
  put(kind, id, value) { this.db.prepare("INSERT INTO automation_objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value").run(kind, id, JSON.stringify(value)); return value; }
  remove(kind, id) { this.db.prepare("DELETE FROM automation_objects WHERE kind=? AND id=?").run(kind, id); }
  transaction(fn) { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  insertRun(run, idem) { this.db.prepare("INSERT INTO automation_runs VALUES(?,?,?)").run(run.id, idem, JSON.stringify(run)); return run; }
  updateRun(run) { this.db.prepare("UPDATE automation_runs SET value=? WHERE id=?").run(JSON.stringify(run), run.id); return run; }
  run(id) { const row = this.db.prepare("SELECT value FROM automation_runs WHERE id=?").get(id); return row ? JSON.parse(row.value) : null; }
  byIdempotency(idem) { const row = this.db.prepare("SELECT value FROM automation_runs WHERE idem=?").get(idem); return row ? JSON.parse(row.value) : null; }
  runs(limit = 1000) {
    const cap = Math.max(1, Math.min(10000, Number(limit) || 1000));
    return this.db.prepare("SELECT value FROM automation_runs ORDER BY rowid DESC LIMIT ?").all(cap).map(row => JSON.parse(row.value));
  }
  unfinishedRuns() { return this.db.prepare("SELECT value FROM automation_runs WHERE json_extract(value,'$.status') IN ('queued','running','committing')").all().map(row => JSON.parse(row.value)); }
  queuedRuns() { return this.db.prepare("SELECT value FROM automation_runs WHERE json_extract(value,'$.status')='queued' ORDER BY rowid").all().map(row => JSON.parse(row.value)); }
  retryRuns(now) { return this.db.prepare("SELECT value FROM automation_runs WHERE json_extract(value,'$.status')='retry_wait' AND json_extract(value,'$.next_retry_at')<=? ORDER BY json_extract(value,'$.next_retry_at'),rowid").all(now).map(row => JSON.parse(row.value)); }
  scheduleRunCount(id, statuses) {
    if (!Array.isArray(statuses) || statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(",");
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM automation_runs WHERE json_extract(value,'$.schedule_id')=? AND json_extract(value,'$.status') IN (${placeholders})`).get(id, ...statuses).count);
  }
  claim(id, owner, now, ttl) {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT owner,generation,expires FROM automation_leases WHERE id=?").get(id);
      if (current && current.owner !== owner && current.expires > now) return null;
      const generation = current?.owner === owner
        ? Number(current.generation)
        : Number(current?.generation || 0) + 1;
      this.db.prepare(`INSERT INTO automation_leases(id,owner,generation,expires) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires=excluded.expires`)
        .run(id, owner, generation, now + ttl);
      return { id, owner, generation, expires: now + ttl };
    });
  }
  renew(id, owner, generation, now, ttl) {
    return this.db.prepare("UPDATE automation_leases SET expires=? WHERE id=? AND owner=? AND generation=? AND expires>?")
      .run(now + ttl, id, owner, generation, now).changes === 1;
  }
  owns(id, owner, generation, now) {
    return !!this.db.prepare("SELECT 1 FROM automation_leases WHERE id=? AND owner=? AND generation=? AND expires>?")
      .get(id, owner, generation, now);
  }
  release(id, owner, generation = null) {
    if (generation == null) this.db.prepare("UPDATE automation_leases SET expires=0 WHERE id=? AND owner=?").run(id, owner);
    else this.db.prepare("UPDATE automation_leases SET expires=0 WHERE id=? AND owner=? AND generation=?").run(id, owner, generation);
  }
  reserveOutputs(runID, reservations) {
    const existing = this.db.prepare("SELECT run_id,resource_identity,relative_path,state FROM automation_output_reservations WHERE run_id<>?").all(runID);
    for (const reservation of reservations) {
      const conflict = existing.find(item => item.resource_identity === reservation.resource_identity
        && pathsOverlap(item.relative_path, reservation.relative_path));
      demand(!conflict, `Output conflicts with active run ${conflict?.run_id || "unknown"}`, "output_conflict");
    }
    const insert = this.db.prepare("INSERT OR REPLACE INTO automation_output_reservations VALUES(?,?,?,?)");
    for (const item of reservations) insert.run(runID, item.resource_identity, item.relative_path, "held");
  }
  releaseOutputs(runID) { this.db.prepare("DELETE FROM automation_output_reservations WHERE run_id=?").run(runID); }
  outputReservations(runID = null) {
    const rows = runID == null
      ? this.db.prepare("SELECT * FROM automation_output_reservations ORDER BY resource_identity,relative_path").all()
      : this.db.prepare("SELECT * FROM automation_output_reservations WHERE run_id=? ORDER BY resource_identity,relative_path").all(runID);
    return rows;
  }
  checkpoint(id) { const row = this.db.prepare("SELECT value FROM automation_checkpoints WHERE id=?").get(id); return row ? JSON.parse(row.value) : null; }
  saveCheckpoint(id, value) { this.db.prepare("INSERT INTO automation_checkpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value)); }
  close() { this.db.close(); }
}

function pathsOverlap(left, right) {
  const a = String(left || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const b = String(right || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
