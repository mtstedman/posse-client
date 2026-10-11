// Canonical engine and grant vocabulary for opt-in project database access.

export const PROJECT_DB_TYPES = Object.freeze(["sqlite", "postgres", "mysql"]);
export const PROJECT_DB_TYPE_LIST_SQL = PROJECT_DB_TYPES.map((type) => `'${type}'`).join(", ");

// WRITE does not imply READ. Version 1 used separate mutating verb grants;
// those grants remain suspended until the operator saves under version 2.
export const PROJECT_DB_PERMISSIONS = Object.freeze(["read", "write"]);
export const PROJECT_DB_PERMISSIONS_VERSION = 2;
export const PROJECT_DB_LEGACY_MUTATING_PERMISSIONS = Object.freeze(["write", "insert", "delete", "create", "alter"]);

export const PROJECT_DB_CONFIG_TABLE = "project_db_config";
