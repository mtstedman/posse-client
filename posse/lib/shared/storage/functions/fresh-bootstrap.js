// Fresh database bootstrap is intentionally kept apart from legacy migrations.
// It owns only the schema-file path and initial DDL application.

import { FRESH_SCHEMA_PATH, readFreshSchema } from "./schema-definitions.js";

// Top-level `PRAGMA name = value;` lines in schema.sql. foreign_keys cannot
// change inside a transaction, and user_version marks the database as
// bootstrapped, so neither runs with the rest of the schema.
const SCHEMA_PRAGMA = /^[^\S\n]*PRAGMA[^\S\n]+(\w+)[^\S\n]*=[^\S\n]*([^;\n]+);[^\S\n]*$/gim;

export function bootstrapFreshDatabase(db) {
  const schema = readFreshSchema();
  if (!schema) {
    throw new Error(`Database has no tables and schema file not found at ${FRESH_SCHEMA_PATH}. Create the database first or check the configured runtime database path.`);
  }
  const pragmas = [...schema.matchAll(SCHEMA_PRAGMA)].map(([, name, value]) => [name.toLowerCase(), value.trim()]);
  for (const [name, value] of pragmas) if (name !== "user_version") db.pragma(`${name} = ${value}`);
  // One transaction with the version stamped last: a bootstrap that stops
  // part-way leaves an empty database, which the next start bootstraps again.
  db.transaction(() => {
    db.exec(schema.replace(SCHEMA_PRAGMA, ""));
    for (const [name, value] of pragmas) if (name === "user_version") db.pragma(`${name} = ${value}`);
  }).immediate();
}
