// Statement-level authorization for the project_db_query tool.
//
// Defense-in-depth on top of whatever the configured DB account itself permits:
//   1. single-statement guard  — one statement per call, no stacked SQL
//   2. verb allowlist          — only SELECT / INSERT / UPDATE / DELETE /
//                                CREATE / ALTER + read-only inspection verbs;
//                                DROP/TRUNCATE and other DDL are never allowed
//   3. permission gate         — the statement's verb must map to a permission
//                                the operator granted
//                                (read/write/insert/delete/create/alter)
//
// The engine is *also* opened read-only when only `read` is granted (see
// drivers.js), so a verb-parser miss still can't mutate a read-only grant.

import { PROJECT_DB_PERMISSIONS } from "./config.js";

// Leading verb -> required granted permission. CREATE/ALTER are the only
// grantable DDL verbs; everything destructive (DROP/TRUNCATE) stays blocked.
const WRITE_VERB_PERMISSION = Object.freeze({
  INSERT: "insert",
  UPDATE: "write",
  DELETE: "delete",
  CREATE: "create",
  ALTER: "alter",
});

// Read-only verbs all gated behind the `read` permission.
const READ_VERBS = new Set([
  "SELECT", "WITH", "VALUES", "TABLE",
  "PRAGMA", "EXPLAIN", "SHOW", "DESCRIBE", "DESC",
]);

// Postgres dollar-quoted string delimiter: `$tag$` where tag is an optional
// identifier (letter/underscore first, then alphanumerics; never digit-led, so
// numbered params like `$1` are NOT delimiters). Inside `$tag$ … $tag$` every
// `'`, `"`, `` ` `` and `;` is literal — the ONLY terminator is the matching
// `$tag$`. A scan that didn't understand this would treat an apostrophe inside
// `$$ it's $$` as a string opener, swallow a following `;`, and mis-count the
// statements — defeating the single-statement guard. Returns the delimiter text
// (e.g. `$$` or `$fn$`) if one opens at `i`, else null.
function dollarQuoteDelimiter(text, i) {
  if (text[i] !== "$") return null;
  let j = i + 1;
  if (j < text.length && /[A-Za-z_]/.test(text[j])) {
    j += 1;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
  }
  return text[j] === "$" ? text.slice(i, j + 1) : null;
}

/**
 * Strip SQL comments and split into statements, quote/identifier aware so that
 * a `;` or comment marker inside a string/identifier is not treated as
 * structure. Returns the list of non-empty trimmed statements.
 */
export function splitSqlStatements(sql) {
  const text = String(sql || "");
  const statements = [];
  let current = "";
  let quote = null; // "'" string, '"' identifier, "`" mysql identifier
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      current += ch;
      if (ch === quote) {
        // Doubled quote is an escaped literal quote, not a terminator.
        if (next === quote) { current += next; i += 1; }
        else quote = null;
      }
      continue;
    }
    if (ch === "$") {
      const delim = dollarQuoteDelimiter(text, i);
      if (delim) {
        // Consume the whole dollar-quoted span so its content never splits. An
        // unterminated span swallows the rest (the engine will reject it, and no
        // phantom `;` can leak a stacked statement past the guard).
        const end = text.indexOf(delim, i + delim.length);
        const stop = end === -1 ? text.length : end + delim.length;
        current += text.slice(i, stop);
        i = stop - 1;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; current += ch; continue; }
    if (ch === "-" && next === "-") {
      // Line comment: skip to end of line.
      while (i < text.length && text[i] !== "\n") i += 1;
      current += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment: skip to closing */.
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1; // land on the trailing '/'
      current += " ";
      continue;
    }
    if (ch === ";") { statements.push(current); current = ""; continue; }
    current += ch;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter(Boolean);
}

function leadingVerb(statement) {
  const match = String(statement || "").match(/^[A-Za-z]+/);
  return match ? match[0].toUpperCase() : "";
}

// Blank out string/identifier literal contents so a keyword scan can't be
// fooled by data (e.g. SELECT 'please delete me') or a column named "delete".
// Comments are already stripped by splitSqlStatements before we get here.
export function maskSqlLiterals(statement) {
  const s = String(statement || "");
  let out = "";
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        if (s[i + 1] === quote) { out += "  "; i += 1; continue; } // escaped quote
        quote = null; out += " "; continue;
      }
      out += " ";
      continue;
    }
    if (ch === "$") {
      const delim = dollarQuoteDelimiter(s, i);
      if (delim) {
        // Blank the whole dollar-quoted literal (length-preserving) so a keyword
        // inside `$$ … UPDATE … $$` can't trip the DML scan.
        const end = s.indexOf(delim, i + delim.length);
        const stop = end === -1 ? s.length : end + delim.length;
        out += " ".repeat(stop - i);
        i = stop - 1;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; out += " "; continue; }
    out += ch;
  }
  return out;
}

// Data-modifying SQL keywords matched as standalone tokens anywhere in the
// statement (not just at its head), each paired with the permission it requires.
// Note UPDATE maps to the `write` permission, not a literal "update" grant.
const DML_OP_SCANS = Object.freeze([
  { label: "INSERT", permission: "insert", pattern: /\bINSERT\b/i },
  { label: "UPDATE", permission: "write", pattern: /\bUPDATE\b/i },
  { label: "DELETE", permission: "delete", pattern: /\bDELETE\b/i },
  // DDL scans skip read statements: DDL cannot ride a read verb (EXPLAIN
  // ANALYZE and SELECT ... INTO are blocked outright, and CTEs cannot contain
  // DDL), while scanning reads would false-positive legitimate inspection
  // such as mysql's SHOW CREATE TABLE.
  { label: "CREATE", permission: "create", pattern: /\bCREATE\b/i, skipReads: true },
  { label: "ALTER", permission: "alter", pattern: /\bALTER\b/i, skipReads: true },
]);

/**
 * Classify a single statement: its verb, the permission it requires, whether
 * it's a read, and whether it is a recognized/allowed verb at all.
 */
export function classifyStatement(statement) {
  const verb = leadingVerb(statement);
  if (!verb) return { verb: "", requiredPermission: null, isRead: false, allowedVerb: false };

  if (WRITE_VERB_PERMISSION[verb]) {
    return { verb, requiredPermission: WRITE_VERB_PERMISSION[verb], isRead: false, allowedVerb: true };
  }
  if (READ_VERBS.has(verb)) {
    return { verb, requiredPermission: "read", isRead: true, allowedVerb: true };
  }
  // DROP / TRUNCATE / REPLACE / MERGE / GRANT / ATTACH / etc.
  return { verb, requiredPermission: null, isRead: false, allowedVerb: false };
}

/**
 * Authorize a SQL request for the granted permission set.
 * @returns {{ ok: true, statement, verb, requiredPermission, isRead }
 *          | { ok: false, error: string }}
 */
export function authorizeProjectDbStatement(sql, grantedPermissions = []) {
  const granted = new Set(
    (Array.isArray(grantedPermissions) ? grantedPermissions : [])
      .map((p) => String(p || "").trim().toLowerCase())
      .filter((p) => PROJECT_DB_PERMISSIONS.includes(p)),
  );
  if (granted.size === 0) {
    return { ok: false, error: "Project DB access is not enabled (no permissions granted)." };
  }

  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    return { ok: false, error: "No SQL statement provided." };
  }
  if (statements.length > 1) {
    return { ok: false, error: "Only a single SQL statement is allowed per call." };
  }

  const statement = statements[0];
  const { verb, requiredPermission, isRead, allowedVerb } = classifyStatement(statement);
  if (!allowedVerb) {
    return {
      ok: false,
      error: `Statement type ${verb || "(unknown)"} is not permitted. Allowed: SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER (each per its granted permission), and read-only inspection (PRAGMA/EXPLAIN/SHOW/DESCRIBE). DROP, TRUNCATE, and other DDL are never allowed.`,
    };
  }

  if (!granted.has(requiredPermission)) {
    return {
      ok: false,
      error: `Permission '${requiredPermission}' is required for a ${verb} statement, but the granted permissions are: ${[...granted].join(", ") || "(none)"}.`,
    };
  }

  // Defense-in-depth: do NOT rely on the DB engine (read-only mode / privileges)
  // to block disallowed operations. The leading-verb check above is bypassable
  // — `EXPLAIN ANALYZE DELETE ...` executes in Postgres, `WITH x AS (DELETE...)`
  // is a data-modifying CTE, and `SELECT ... INTO` writes a table — so the tool
  // itself rejects any operation outside the grant, regardless of leading verb.
  const masked = maskSqlLiterals(statement);

  // EXPLAIN ANALYZE actually executes the analyzed statement.
  if (/^\s*EXPLAIN\b/i.test(masked) && /\bANALYZE\b/i.test(masked)) {
    return { ok: false, error: "EXPLAIN ANALYZE executes the statement and is not permitted; use plain EXPLAIN for the query plan." };
  }
  // SELECT ... INTO creates/populates a table (a write) under a read leading verb.
  if (isRead && /\bINTO\b/i.test(masked)) {
    return { ok: false, error: "SELECT ... INTO writes data and is not permitted." };
  }
  // Any data-modifying verb whose permission the grant doesn't include —
  // anywhere in the body, regardless of the leading keyword.
  for (const scan of DML_OP_SCANS) {
    if (scan.skipReads && isRead) continue;
    if (!granted.has(scan.permission) && scan.pattern.test(masked)) {
      return {
        ok: false,
        error: `Statement appears to perform a ${scan.label} operation (requires the '${scan.permission}' permission); granted: ${[...granted].join(", ") || "none"}.`,
      };
    }
  }

  return { ok: true, statement, verb, requiredPermission, isRead };
}

/** True if the configured grant is read-only (so the engine can open read-only). */
export function isReadOnlyGrant(grantedPermissions = []) {
  const granted = new Set(
    (Array.isArray(grantedPermissions) ? grantedPermissions : [])
      .map((p) => String(p || "").trim().toLowerCase()),
  );
  return granted.has("read") && [...granted].every((p) => p === "read");
}
