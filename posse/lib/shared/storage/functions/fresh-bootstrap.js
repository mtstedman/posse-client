// Fresh database bootstrap is intentionally kept apart from legacy migrations.
// It owns only the schema-file path and initial DDL application.

import { FRESH_SCHEMA_PATH, readFreshSchema } from "./schema-definitions.js";

export function bootstrapFreshDatabase(db) {
  const schema = readFreshSchema();
  if (!schema) {
    throw new Error(`Database has no tables and schema file not found at ${FRESH_SCHEMA_PATH}. Create the database first or check the configured runtime database path.`);
  }
  db.exec(schema);
}
