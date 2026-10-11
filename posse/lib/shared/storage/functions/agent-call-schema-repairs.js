import { _copyTableColumns, copySourceExpr } from "./table-copy.js";
import { agentCallsCreateSql, createAgentCallsIndexes, getTableColumnNames, quoteIdent, withForeignKeysDisabled } from "./table-definitions.js";

function copyAgentCallsForExtendedThinkingRepair(db, fromTable, toTable) {
  const oldCols = new Set(getTableColumnNames(db, fromTable));
  const newCols = getTableColumnNames(db, toTable);
  const targetCols = [];
  const sourceExprs = [];
  for (const col of newCols) {
    if (!oldCols.has(col)) continue;
    targetCols.push(col);
    if (col === "extended_thinking") {
      sourceExprs.push(`CASE WHEN COALESCE(${quoteIdent(col)}, 0) = 0 THEN 0 ELSE 1 END`);
    } else {
      sourceExprs.push(copySourceExpr(fromTable, col, col));
    }
  }
  if (targetCols.length === 0) return;
  _copyTableColumns(db, fromTable, toTable, targetCols, sourceExprs);
}

function agentCallsExtendedThinkingCheckIsCurrent(tableSql = "") {
  return /extended_thinking\s+INTEGER\b[\s\S]*?CHECK\s*\(\s*extended_thinking\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(tableSql);
}

export function needsAgentCallsExtendedThinkingRepair(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
  ).get();
  if (!row?.sql) return false;
  const cols = new Set(getTableColumnNames(db, "agent_calls"));
  if (!cols.has("extended_thinking")) return true;
  if (!agentCallsExtendedThinkingCheckIsCurrent(row.sql)) return true;
  const invalid = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM agent_calls
    WHERE extended_thinking IS NULL
       OR extended_thinking NOT IN (0,1)
  `).get();
  return (invalid?.cnt || 0) > 0;
}

export function repairAgentCallsExtendedThinkingSchema(db) {
  if (!needsAgentCallsExtendedThinkingRepair(db)) return false;
  withForeignKeysDisabled(db, () => db.transaction(() => {
    const tmpName = "_agent_calls_extended_thinking_repair";
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
    db.exec(agentCallsCreateSql(tmpName));
    copyAgentCallsForExtendedThinkingRepair(db, "agent_calls", tmpName);
    db.exec(`DROP TABLE ${quoteIdent("agent_calls")}`);
    db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("agent_calls")}`);
    createAgentCallsIndexes(db);
  })());
  return true;
}

export function needsAgentCallsParentageRepair(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
  ).get();
  if (!row?.sql) return false;
  const cols = new Set(getTableColumnNames(db, "agent_calls"));
  if (!cols.has("parent_agent_call_id") || !cols.has("child_kind")) return true;
  return !/child_kind\s+TEXT\s+CHECK[\s\S]*?'citation'/iu.test(row.sql)
    || !/FOREIGN KEY\s*\(\s*parent_agent_call_id\s*\)\s*REFERENCES\s+["`\[]?agent_calls[\s\S]*?ON DELETE CASCADE/iu.test(row.sql)
    || !/parent_agent_call_id IS NULL AND child_kind IS NULL/iu.test(row.sql)
    || !/parent_agent_call_id IS NOT NULL AND child_kind IS NOT NULL/iu.test(row.sql);
}

export function repairAgentCallsParentageSchema(db) {
  if (!needsAgentCallsParentageRepair(db)) return false;
  withForeignKeysDisabled(db, () => db.transaction(() => {
    const tmpName = "_agent_calls_parentage_repair";
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
    db.exec(agentCallsCreateSql(tmpName));
    copyAgentCallsForExtendedThinkingRepair(db, "agent_calls", tmpName);
    db.exec(`DROP TABLE ${quoteIdent("agent_calls")}`);
    db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("agent_calls")}`);
    createAgentCallsIndexes(db);
  })());
  return true;
}

export function needsAgentCallsChildKindsRepair(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
  ).get();
  if (!row?.sql) return false;
  return needsAgentCallsParentageRepair(db)
    || !/child_kind\s+TEXT\s+CHECK[\s\S]*?'web_research'/iu.test(row.sql)
    || !/child_kind\s+TEXT\s+CHECK[\s\S]*?'research_claim_review'/iu.test(row.sql)
    || !/child_kind\s+TEXT\s+CHECK[\s\S]*?'final_review'/iu.test(row.sql)
    || !/child_kind\s+TEXT\s+CHECK[\s\S]*?'research'/iu.test(row.sql);
}

export function repairAgentCallsChildKindsSchema(db) {
  if (!needsAgentCallsChildKindsRepair(db)) return false;
  withForeignKeysDisabled(db, () => db.transaction(() => {
    const tmpName = "_agent_calls_child_kinds_repair";
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
    db.exec(agentCallsCreateSql(tmpName));
    copyAgentCallsForExtendedThinkingRepair(db, "agent_calls", tmpName);
    db.exec(`DROP TABLE ${quoteIdent("agent_calls")}`);
    db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("agent_calls")}`);
    createAgentCallsIndexes(db);
  })());
  return true;
}

export function needsAgentCallsInterruptedStatusRepair(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
  ).get();
  if (!row?.sql) return false;
  return !/status\s+TEXT[\s\S]*?CHECK\s*\([\s\S]*?'interrupted'/iu.test(row.sql);
}

export function repairAgentCallsInterruptedStatusSchema(db) {
  if (!needsAgentCallsInterruptedStatusRepair(db)) return false;
  withForeignKeysDisabled(db, () => db.transaction(() => {
    const tmpName = "_agent_calls_interrupted_status_repair";
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tmpName)}`);
    db.exec(agentCallsCreateSql(tmpName));
    copyAgentCallsForExtendedThinkingRepair(db, "agent_calls", tmpName);
    db.exec(`DROP TABLE ${quoteIdent("agent_calls")}`);
    db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent("agent_calls")}`);
    createAgentCallsIndexes(db);
  })());
  return true;
}
