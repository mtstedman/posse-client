// Sequence-allocation files: version pins and migration manifests that hand
// out the next number of a shared sequence (schema version, migration chain
// index). Two in-flight work items that both edit one of these each claim the
// same "next" number from the same base, and git cannot see the clash (two
// identical `12 -> 13` pin bumps merge cleanly). The scheduler therefore keeps
// a work-item lock on these files with its holder until that work item merges
// instead of handing the file to another work item mid-flight.
//
// Detection is deliberately conservative: exact basenames only, and a bare
// VERSION-style pin counts only under a database/migration directory, so a
// repository's release VERSION file is not serialized.
//
// Pure data and derived lookup only; no I/O.

export const SEQUENCE_ALLOCATION_MANIFEST_BASENAMES = new Set([
  "migration-chain.json",
  "migration_chain.json",
  "migration-manifest.json",
  "migration_manifest.json",
]);

export const SEQUENCE_ALLOCATION_SCHEMA_PIN_BASENAMES = new Set([
  "SCHEMA_VERSION",
  "SCHEMA_VERSION.txt",
  "schema_version",
  "schema_version.txt",
  "schema-version",
  "schema-version.txt",
  ".schema-version",
]);

export const SEQUENCE_ALLOCATION_DIRECTORY_PIN_BASENAMES = new Set([
  "VERSION",
  "VERSION.txt",
  "version.txt",
]);

export const SEQUENCE_ALLOCATION_DATABASE_DIR_SEGMENTS = new Set([
  "db",
  "database",
  "databases",
  "migration",
  "migrations",
  "schema",
  "schemas",
  "sql",
  "postgres",
  "postgresql",
  "pg",
  "mysql",
  "mariadb",
  "sqlite",
]);

/**
 * True when a repo-relative file path is a sequence-allocation file.
 * @param {string} repoPath
 * @returns {boolean}
 */
export function isSequenceAllocationPath(repoPath) {
  const normalized = String(repoPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
  if (!normalized) return false;
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  if (SEQUENCE_ALLOCATION_MANIFEST_BASENAMES.has(basename)) return true;
  if (SEQUENCE_ALLOCATION_SCHEMA_PIN_BASENAMES.has(basename)) return true;
  if (!SEQUENCE_ALLOCATION_DIRECTORY_PIN_BASENAMES.has(basename)) return false;
  return segments
    .slice(0, -1)
    .some((segment) => SEQUENCE_ALLOCATION_DATABASE_DIR_SEGMENTS.has(segment.toLowerCase()));
}
