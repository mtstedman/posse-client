// @ts-check

import fs from "node:fs";
import Database from "better-sqlite3";
import { usageDbPathFor } from "../runtime-paths.js";

/**
 * @param {string | null | undefined} ledgerPath
 * @returns {{ db: any, dbPath: string } | null}
 */
export function openUsageStoreReadOnly(ledgerPath) {
  const dbPath = usageDbPathFor(ledgerPath);
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return { db, dbPath };
}

/** @param {string | null | undefined} ledgerPath */
export function usageStoreEventSummary(ledgerPath) {
  let store = null;
  try {
    store = openUsageStoreReadOnly(ledgerPath);
    if (!store) return { available: false, events: 0, path: usageDbPathFor(ledgerPath) || null };
    const row = store.db.prepare("SELECT COUNT(*) AS count FROM usage_events").get();
    return { available: true, events: Number(row?.count || 0), path: store.dbPath };
  } catch (err) {
    return {
      available: false,
      events: 0,
      path: usageDbPathFor(ledgerPath) || null,
      error: String(/** @type {any} */ (err)?.message || err),
    };
  } finally {
    try { store?.db?.close(); } catch { /* best effort */ }
  }
}
