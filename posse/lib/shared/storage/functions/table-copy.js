import { log } from "../../telemetry/functions/logging/logger.js";
import { isJsonValidityColumn as isKnownJsonValidityColumn } from "./installers.js";
import { getTableColumnNames, quoteIdent } from "./table-definitions.js";

// Legacy rebuilds create the replacement from historical inline SQL, which
// predates columns that startup ALTERs added later; copying only the columns
// both tables share would drop them and their data. Append each to the
// replacement with its type, and its NOT NULL and default when the default
// is a literal (ALTER TABLE cannot add an expression default).
export function addMissingColumns(db, fromTable, toTable) {
  const present = new Set(getTableColumnNames(db, toTable));
  for (const { name, type, notnull, dflt_value: dflt } of db.pragma(`table_info(${quoteIdent(fromTable)})`)) {
    if (present.has(name)) continue;
    const literal = dflt !== null && /^(?:'(?:[^']|'')*'|[-+]?\d+(?:\.\d+)?|NULL)$/i.test(dflt);
    const constraints = literal ? `${notnull ? " NOT NULL" : ""} DEFAULT ${dflt}` : "";
    db.exec(`ALTER TABLE ${quoteIdent(toTable)} ADD COLUMN ${quoteIdent(name)} ${type}${constraints}`);
  }
}

export function copyCompatibleColumns(db, fromTable, toTable, aliases = {}) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  const repairedJsonColumns = [];
  for (const col of newCols) {
    if (oldCols.has(col)) {
      targetCols.push(col);
      recordJsonRepairCount(db, fromTable, col, col, repairedJsonColumns);
      sourceExprs.push(copySourceExpr(fromTable, col, col));
      continue;
    }
    const alias = aliases[col];
    if (alias && oldCols.has(alias)) {
      targetCols.push(col);
      recordJsonRepairCount(db, fromTable, alias, col, repairedJsonColumns);
      sourceExprs.push(copySourceExpr(fromTable, alias, col));
    }
  }
  if (repairedJsonColumns.length > 0) {
    log.warn("db", "Repairing legacy invalid JSON while copying compatible columns", {
      fromTable,
      toTable,
      columns: repairedJsonColumns,
      repaired: repairedJsonColumns.reduce((sum, entry) => sum + entry.count, 0),
    });
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

function isJsonValidityColumn(fromTable, sourceCol, targetCol) {
  return isKnownJsonValidityColumn(fromTable, targetCol) || isKnownJsonValidityColumn(fromTable, sourceCol);
}

function recordJsonRepairCount(db, fromTable, sourceCol, targetCol, out) {
  if (!isJsonValidityColumn(fromTable, sourceCol, targetCol)) return;
  const quoted = quoteIdent(sourceCol);
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM ${quoteIdent(fromTable)}
     WHERE ${quoted} IS NOT NULL
       AND json_valid(${quoted}) = 0`
  ).get();
  const count = Number(row?.cnt || 0);
  if (count > 0) out.push({ sourceColumn: sourceCol, targetColumn: targetCol, count });
}

export function copySourceExpr(fromTable, sourceCol, targetCol) {
  const quoted = quoteIdent(sourceCol);
  if (!isJsonValidityColumn(fromTable, sourceCol, targetCol)) {
    return quoted;
  }
  return `CASE WHEN ${quoted} IS NULL OR json_valid(${quoted}) THEN ${quoted} ELSE json_quote(${quoted}) END`;
}

export function _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs) {
  const targets = targetCols.map(quoteIdent).join(", ");
  db.exec(
    `INSERT INTO ${quoteIdent(toTable)} (${targets}) SELECT ${sourceExprs.join(", ")} FROM ${quoteIdent(fromTable)}`
  );
}
