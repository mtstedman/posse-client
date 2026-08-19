import { getDb } from "../../../shared/storage/functions/index.js";

const MAX_COMMAND_ID_CHARS = 256;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value ?? {}));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function validDurableCommandId(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_COMMAND_ID_CHARS
  );
}

/**
 * Durable idempotency owner for bridge mutations. A pending claim survives a
 * process crash and deliberately blocks blind replay: operators can reconcile
 * it through command.status instead of risking a second destructive effect.
 */
export class CommandResultStore {
  constructor({ getDatabase = getDb } = {}) {
    this.getDatabase = getDatabase;
  }

  claim(commandId, commandName, args = {}) {
    const id = String(commandId).trim();
    const name = String(commandName).trim();
    const argsJson = stableJson(args);
    const db = this.getDatabase();
    const inserted = db.prepare(`
      INSERT INTO bridge_command_results (
        command_id, command_name, args_json, state
      ) VALUES (?, ?, ?, 'pending')
      ON CONFLICT(command_id) DO NOTHING
    `).run(id, name, argsJson).changes > 0;
    const row = this.readRow(id, db);
    if (!row) throw new Error("durable command claim disappeared");
    if (row.command_name !== name || row.args_json !== argsJson) {
      return { state: "conflict" };
    }
    if (inserted) return { state: "claimed" };
    if (row.state === "completed") {
      const ack = parseJson(row.ack_json);
      if (!ack || typeof ack !== "object") {
        throw new Error("durable command result is corrupt");
      }
      return { state: "completed", ack };
    }
    return { state: "pending" };
  }

  complete(commandId, ack) {
    const id = String(commandId).trim();
    const ackJson = JSON.stringify(ack);
    const db = this.getDatabase();
    const changed = db.prepare(`
      UPDATE bridge_command_results
      SET state = 'completed',
          ack_json = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id = ? AND state = 'pending'
    `).run(ackJson, id).changes;
    if (changed > 0) {
      // Terminal history is useful for offline reconciliation but should not
      // grow forever. Pending/ambiguous outcomes are never pruned here.
      db.prepare(`
        DELETE FROM bridge_command_results
        WHERE state = 'completed'
          AND completed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
      `).run();
      return ack;
    }
    const existing = this.readRow(id, db);
    if (existing?.state === "completed" && existing.ack_json === ackJson) return ack;
    throw new Error("durable command completion lost its pending claim");
  }

  status(commandId) {
    if (!validDurableCommandId(commandId)) {
      return { ok: false, reason: "invalid_command_id" };
    }
    const id = String(commandId).trim();
    const row = this.readRow(id);
    if (!row) return { command_id: id, status: "not_found" };
    if (row.state === "pending") {
      return {
        command_id: id,
        command_name: row.command_name,
        status: "pending",
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }
    const ack = parseJson(row.ack_json);
    if (!ack || typeof ack !== "object") {
      return { ok: false, reason: "command_result_corrupt" };
    }
    return {
      command_id: id,
      command_name: row.command_name,
      status: ack.ok === true ? "succeeded" : "failed",
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      ack,
    };
  }

  readRow(commandId, db = this.getDatabase()) {
    return db.prepare(`
      SELECT command_id, command_name, args_json, state, ack_json,
             created_at, updated_at, completed_at
      FROM bridge_command_results
      WHERE command_id = ?
    `).get(commandId) || null;
  }
}
