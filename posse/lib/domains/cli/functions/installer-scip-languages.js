// Read-only installer entrypoint. Keep this in the shipped runtime: public
// clients omit private scripts, but setup must still preserve account policy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeScipLanguages } from "../../atlas/functions/v2/scip/languages.js";

const file = process.env.POSSE_ACCOUNT_DB_PATH || path.join(os.homedir(), ".posse", "account.db");
let value;
if (fs.existsSync(file)) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_settings'").get()) {
      value = db.prepare("SELECT setting_value FROM account_settings WHERE setting_key = ?").get("atlas_scip_languages")?.setting_value;
    }
  } finally { db.close(); }
}
process.stdout.write(normalizeScipLanguages(value).join(",") || "none");
