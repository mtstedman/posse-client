// The checked-in SQLite schema is the definition for a brand-new host DB.
// Legacy databases use the versioned repair path in migrations.js instead.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FRESH_SCHEMA_PATH = path.resolve(__dirname, "..", "..", "..", "..", "schema.sql");

export function readFreshSchema() {
  if (!fs.existsSync(FRESH_SCHEMA_PATH)) return null;
  return fs.readFileSync(FRESH_SCHEMA_PATH, "utf-8");
}
