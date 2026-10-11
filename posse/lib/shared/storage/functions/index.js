// SQLite connection owner. Schema installation and upgrades live in their
// named storage modules and run in the historical order on each new handle.
import path from "node:path";
import { getRuntimeDbPath } from "../../../domains/runtime/functions/paths.js";
import { bumpRunTelemetryEpoch } from "../../telemetry/functions/run-telemetry.js";
import { installEventState } from "./event-state.js";
import {
  installBridgeChangeTracking,
  installExportClaimColumns,
  installJsonValidityTriggers,
  installTerminalTransitionTracking,
} from "./installers.js";
import { runRegisteredHostMigrations } from "./host-migration-series.js";
import { installLegacyCoreTables } from "./legacy-core-tables.js";
import { repairLegacyJobColumns } from "./legacy-job-columns.js";
import { repairLegacyReferences } from "./legacy-reference-repairs.js";
import { repairLegacyRoleEnums } from "./legacy-role-enums.js";
import { installLegacyFeatureTables } from "./legacy-feature-tables.js";
import {
  ensureRuntimeDbDir,
  openDatabaseHandle,
  quarantineStaleIncompleteDb,
} from "./database-lifecycle.js";
import { HOST_SCHEMA_VERSION, ensureHostSchemaVersion } from "./migrations.js";
import {
  createHashRefStoreTables,
  createAgentHandoffPacketTable,
  createResearchReportClaimDraftTable,
} from "./table-definitions.js";
import {
  needsAgentCallsExtendedThinkingRepair,
  repairAgentCallsExtendedThinkingSchema,
  needsAgentCallsParentageRepair,
  repairAgentCallsParentageSchema,
  needsAgentCallsChildKindsRepair,
  repairAgentCallsChildKindsSchema,
  needsAgentCallsInterruptedStatusRepair,
  repairAgentCallsInterruptedStatusSchema,
} from "./agent-call-schema-repairs.js";

// Existing catalog and migration import paths remain stable for consumers.
export {
  HOST_SCHEMA_VERSION,
  __testRepairArtifactsTableSchema,
  __testRepairRunInsightsPromotionSchema,
  __testRepairAtlasV2HostSchema,
  __testRepairHumanGateAssessmentSchema,
  __testRepairQueueForeignKeyOrphans,
  __testRepairWaitingLanePreparationSchema,
  __testInstallSharedTrunkMergeOperationSchema,
  __testRepairSharedTrunkAbandonedPhaseSchema,
  __testInstallPairingSessionSchema,
  __testRepairPairingSessionPendingPhaseSchema,
  __testInstallPairingSessionPolicySchema,
  __testInstallWorkItemDelegationSchema,
  __testRepairWorkItemsGovernanceTierSchema,
  getHostSchemaVersion as __testGetHostSchemaVersion,
  runHostMigration as __testRunHostMigration,
} from "./migrations.js";
export {
  JOB_ATTEMPT_WORKER_TYPES,
  JOB_ATTEMPT_WORKER_TYPE_LIST_SQL,
  JOB_TYPES,
  JOB_TYPE_LIST_SQL,
} from "../../../catalog/job.js";
export {
  WORK_ITEM_GOVERNANCE_TIER_LIST_SQL,
  WORK_ITEM_MERGE_STATES,
  WORK_ITEM_MERGE_STATE_LIST_SQL,
  WORK_ITEM_MODE_LIST_SQL,
  WORK_ITEM_PLAN_APPROVAL_STATE_LIST_SQL,
  WORK_ITEM_PRIORITY_LIST_SQL,
  WORK_ITEM_SESSION_RECYCLE_LIST_SQL,
  WORK_ITEM_STATUS_LIST_SQL,
} from "../../../catalog/work-item.js";
export { ARTIFACT_TYPES } from "../../../catalog/artifact.js";

let _db = null;
let _dbPath = null;
let _dbReady = false;

export function getDb() {
  const dbPath = path.resolve(getRuntimeDbPath());
  if (_db) {
    if (_dbPath === dbPath && _dbReady) return _db;
    closeDb();
  }

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  ensureRuntimeDbDir(dir);

  quarantineStaleIncompleteDb(dbPath);

  _db = openDatabaseHandle(dbPath);
  _dbPath = dbPath;
  // Keep the handle provisional until every bootstrap and migration step succeeds.
  try {
    // Legacy upgrades must run in their historical order before the registered
    // host migrations. Keep the sequence with the connection lifecycle.
    installLegacyCoreTables(_db);
    repairLegacyJobColumns(_db);
    repairLegacyReferences(_db);
    repairLegacyRoleEnums(_db);
    installLegacyFeatureTables(_db);

    runRegisteredHostMigrations(_db, {
      needsAgentCallsExtendedThinkingRepair, repairAgentCallsExtendedThinkingSchema,
      needsAgentCallsParentageRepair, repairAgentCallsParentageSchema,
      needsAgentCallsChildKindsRepair, repairAgentCallsChildKindsSchema,
      needsAgentCallsInterruptedStatusRepair, repairAgentCallsInterruptedStatusSchema,
    });
    installBridgeChangeTracking(_db);
    ensureHostSchemaVersion(_db, HOST_SCHEMA_VERSION);

    createHashRefStoreTables(_db);
    createAgentHandoffPacketTable(_db);
    createResearchReportClaimDraftTable(_db);
    installJsonValidityTriggers(_db);
    installTerminalTransitionTracking(_db);
    installEventState(_db);
    installExportClaimColumns(_db);

    _dbReady = true;
    return _db;
  } catch (err) {
    try { _db?.close(); } catch { /* preserve the initialization error */ }
    _db = null;
    _dbPath = null;
    _dbReady = false;
    throw err;
  }
}

export function __testInstallJsonValidityTriggers(db) {
  installJsonValidityTriggers(db);
}

export function __testInstallBridgeChangeTracking(db) {
  return installBridgeChangeTracking(db);
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
  _dbPath = null;
  _dbReady = false;
  bumpRunTelemetryEpoch();
}
