import { C } from "../../../shared/format/functions/colors.js";
import { abandonSharedTrunkOperation } from "../../git/functions/shared-trunk.js";
import {
  listSharedTrunkMergeOperations,
  updateSharedTrunkRuntimeStatus,
} from "../../queue/functions/index.js";

function printUsage() {
  console.log(`Usage:
  posse shared-trunk ops [--json]
  posse shared-trunk ops abandon <operation-id> [--json]
  posse shared-trunk provenance reset [--json]`);
}

export async function runSharedTrunkCommand(args = [], { projectDir = process.cwd() } = {}) {
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional[0] === "ops" && positional[1] === "abandon") {
    const operationId = String(positional[2] || "").trim();
    if (!operationId) {
      printUsage();
      return { ok: false, reason: "operation_id_required" };
    }
    let result;
    try {
      result = await abandonSharedTrunkOperation(projectDir, operationId);
    } catch (error) {
      result = {
        ok: false,
        reason: error?.code || "shared_trunk_abandon_failed",
        message: error?.message || String(error),
      };
    }
    if (json) console.log(JSON.stringify(result));
    else if (result.ok) console.log(`${C.green}Abandoned${C.reset} shared-trunk operation ${operationId}.`);
    else console.error(`${C.red}Unable to abandon${C.reset} ${operationId}: ${result.reason}`);
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (positional[0] === "ops" && positional.length === 1) {
    const operations = listSharedTrunkMergeOperations();
    if (json) console.log(JSON.stringify({ ok: true, operations }));
    else if (operations.length === 0) console.log("No shared-trunk operations.");
    else for (const operation of operations) {
      console.log(`${operation.operationId}  WI#${operation.workItemId}  ${operation.phase}  ${operation.remote}/${operation.targetBranch}  ${operation.lastErrorCode || "-"}`);
    }
    return { ok: true, operations };
  }
  if (positional[0] === "provenance" && positional[1] === "reset") {
    updateSharedTrunkRuntimeStatus({
      provenance_gate_rejected: false,
      provenance_gate_rejected_oid: null,
      provenance_gate_job_id: null,
    });
    const result = { ok: true, reset: "provenance_gate" };
    if (json) console.log(JSON.stringify(result));
    else console.log(`${C.green}Reset${C.reset} shared-trunk provenance rejection state.`);
    return result;
  }
  printUsage();
  process.exitCode = 1;
  return { ok: false, reason: "invalid_shared_trunk_command" };
}
