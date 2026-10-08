import * as host from "./migrations.js";

// Ordered host migrations run after the legacy schema repairs and before
// bootstrap postflight. Agent-call table repairs are owned by the connection
// module and passed explicitly to avoid a new import cycle.
export function runRegisteredHostMigrations(db, {
  needsAgentCallsExtendedThinkingRepair, repairAgentCallsExtendedThinkingSchema,
  needsAgentCallsParentageRepair, repairAgentCallsParentageSchema,
  needsAgentCallsChildKindsRepair, repairAgentCallsChildKindsSchema,
  needsAgentCallsInterruptedStatusRepair, repairAgentCallsInterruptedStatusSchema,
}) {
  // ── Migration: ATLAS v2 host outbox support ───────────────────────────────
  host.runHostMigration(db, {
    version: 5,
    name: "atlas_v2_host_schema",
    needs: host.needsAtlasV2HostSchemaRepair,
    migrate: host.repairAtlasV2HostSchema,
  });
  host.runHostMigration(db, {
    version: 6,
    name: "agent_calls_extended_thinking",
    needs: needsAgentCallsExtendedThinkingRepair,
    migrate: repairAgentCallsExtendedThinkingSchema,
  });
  host.runHostMigration(db, {
    version: 8,
    name: "human_gate_assessment_lifecycle",
    needs: host.needsHumanGateAssessmentSchemaRepair,
    migrate: host.repairHumanGateAssessmentSchema,
  });
  host.runHostMigration(db, {
    version: 9,
    name: "queue_foreign_key_orphans",
    needs: host.needsQueueForeignKeyOrphanRepair,
    migrate: host.repairQueueForeignKeyOrphans,
  });
  host.runHostMigration(db, {
    version: 10,
    name: "bridge_command_results",
    needs: host.needsBridgeCommandResultsSchema,
    migrate: host.installBridgeCommandResultsSchema,
  });
  host.runHostMigration(db, {
    version: 11,
    name: "waiting_lane_preparation_contracts",
    needs: host.needsWaitingLanePreparationSchema,
    migrate: host.repairWaitingLanePreparationSchema,
  });
  host.runHostMigration(db, {
    version: 12,
    name: "shared_trunk_merge_operations",
    needs: host.needsSharedTrunkMergeOperationSchema,
    migrate: host.installSharedTrunkMergeOperationSchema,
  });
  host.runHostMigration(db, {
    version: 13,
    name: "pairing_sessions",
    needs: host.needsPairingSessionSchema,
    migrate: host.installPairingSessionSchema,
  });
  host.runHostMigration(db, {
    version: 14,
    name: "agent_calls_parentage",
    needs: needsAgentCallsParentageRepair,
    migrate: repairAgentCallsParentageSchema,
  });
  host.runHostMigration(db, {
    version: 15,
    name: "agent_calls_web_research_child_kind",
    needs: needsAgentCallsChildKindsRepair,
    migrate: repairAgentCallsChildKindsSchema,
  });
  host.runHostMigration(db, {
    version: 16,
    name: "pairing_sessions_pending_phase",
    needs: host.needsPairingSessionPendingPhaseSchema,
    migrate: host.repairPairingSessionPendingPhaseSchema,
  });
  host.runHostMigration(db, {
    version: 17,
    name: "pairing_session_policy",
    needs: host.needsPairingSessionPolicySchema,
    migrate: host.installPairingSessionPolicySchema,
  });
  host.runHostMigration(db, {
    version: 18,
    name: "work_item_delegations",
    needs: host.needsWorkItemDelegationSchema,
    migrate: host.installWorkItemDelegationSchema,
  });
  host.runHostMigration(db, {
    version: 19, name: "agent_calls_investigating_research_child",
    needs: needsAgentCallsChildKindsRepair, migrate: repairAgentCallsChildKindsSchema,
  });
  host.runHostMigration(db, {
    version: 20,
    name: "pairing_submission_approval",
    needs: host.needsPairingSubmissionApprovalSchema,
    migrate: host.installPairingSubmissionApprovalSchema,
  });
  host.runHostMigration(db, {
    version: 21,
    name: "shared_trunk_abandoned_phase",
    needs: host.needsSharedTrunkAbandonedPhaseSchema,
    migrate: host.repairSharedTrunkAbandonedPhaseSchema,
  });
  host.runHostMigration(db, {
    version: 22,
    name: "agent_calls_interrupted_status",
    needs: needsAgentCallsInterruptedStatusRepair,
    migrate: repairAgentCallsInterruptedStatusSchema,
  });
  host.runHostMigration(db, {
    version: 23,
    name: "waiting_lane_scoped_layer_token",
    needs: host.needsWaitingLanePreparationSchema,
    migrate: host.repairWaitingLanePreparationSchema,
  });
}
