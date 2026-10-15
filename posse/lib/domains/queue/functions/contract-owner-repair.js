import { CONTRACT_OWNER_REPAIR_LIMIT } from "../../../catalog/repair.js";
import { createHash } from "node:crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import { parseJobPayload } from "./payload.js";
import { updateJobPayload } from "./queue-store.js";
import { addDependency } from "./dependencies.js";
import { FINAL_REVIEW_CONTRACT_FIELDS } from "../../../catalog/final-review.js";

// Called inside the assessor's existing transaction after the provider stopped.
// Authority comes from the compiled contract binding AND the owner's exact
// planned scope. Historical prose or a shared filename alone grants nothing.
export function coordinateContractOwnerRepair({ job, paths, proposedFix, spawn }) {
  const db = getDb();
  if (!db.inTransaction) throw new Error("Contract repair requires an assessor transaction");
  const consumer = parseJobPayload(job);
  const contracts = consumer._shared_contracts || [];
  if (!paths.length || !contracts.length || consumer.oneshot_origin || consumer.oneshot) return null;
  const siblings = db.prepare("SELECT * FROM jobs WHERE work_item_id = ?").all(job.work_item_id);
  const candidates = siblings.filter((owner) => {
    if (owner.id === job.id || !["dev", "fix"].includes(owner.job_type) || !["queued", "succeeded"].includes(owner.status)) return false;
    const payload = parseJobPayload(owner);
    if (payload._contract_owner_repair) return false;
    const ownsContract = contracts.some((contract) => contract.owner_task_id === payload._plan_task_id
      && (payload._shared_contracts || []).some((owned) => owned.id === contract.id && owned.owner_task_id === contract.owner_task_id));
    const scope = [...(payload.files_to_modify || []), ...(payload.files_to_create || []), ...(payload.files_to_delete || [])];
    return ownsContract && paths.every((path) => scope.includes(path));
  });
  if (candidates.length !== 1) return null;
  const owner = candidates[0];
  const dependsOnConsumer = (id) => db.prepare(`WITH RECURSIVE ancestors(id) AS (
    SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?
    UNION SELECT d.depends_on_job_id FROM job_dependencies d JOIN ancestors a ON d.job_id = a.id
  ) SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`).get(id, job.id);
  if (dependsOnConsumer(owner.id)) return null;
  const ownerPayload = parseJobPayload(owner);
  const fingerprint = createHash("sha256").update(JSON.stringify([owner.id, [...paths].sort(), proposedFix.payload_json.fix_instructions])).digest("hex");
  const existingContinuation = siblings.find((sibling) => sibling.parent_job_id === job.id
    && ["queued", "leased", "running", "assessing", "waiting_on_review"].includes(sibling.status)
    && parseJobPayload(sibling)._contract_consumer_repair?.fingerprint === fingerprint);
  if (existingContinuation) {
    const repairId = parseJobPayload(existingContinuation)._contract_consumer_repair.repair_job_id;
    const existingRepair = siblings.find((sibling) => sibling.id === repairId);
    if (existingRepair && !dependsOnConsumer(existingRepair.id) && !["failed", "canceled", "dead_letter"].includes(existingRepair.status)) return { repair: existingRepair, continuation: existingContinuation };
  }
  const prior = siblings.filter((sibling) => parseJobPayload(sibling)._contract_owner_repair?.owner_job_id === owner.id);
  let repair = prior.find((sibling) => ["queued", "leased", "running", "assessing", "waiting_on_review"].includes(sibling.status)
    && parseJobPayload(sibling)._contract_owner_repair.fingerprint === fingerprint);
  if (!repair && prior.length >= CONTRACT_OWNER_REPAIR_LIMIT) return null;
  if (repair && dependsOnConsumer(repair.id)) return null;
  const repairInstructions = `Repair the producer contract in its declared scope. Consumer evidence:\n${proposedFix.payload_json.fix_instructions}`;
  const producerTaskSpec = ownerPayload.task_spec || ownerPayload.fix_instructions || ownerPayload.instructions || owner.title;
  const repairTaskSpec = [repairInstructions, `Original producer task:\n${producerTaskSpec}`].join("\n\n");
  // Pending producers can complete their declared contract first. If the
  // consumer still fails, a subsequent bounded repair uses reviewed evidence.
  if (!repair && owner.status === "queued") {
    repair = owner;
    const updatedPayload = { ...ownerPayload, original_task_spec: ownerPayload.original_task_spec || producerTaskSpec,
      task_spec: repairTaskSpec, fix_instructions: repairInstructions,
      _contract_owner_repair_request: { consumer_job_id: job.id, paths, fingerprint } };
    delete updatedPayload._assess_only;
    updateJobPayload(owner.id, JSON.stringify(updatedPayload));
    repair = { ...owner, payload_json: JSON.stringify(updatedPayload) };
  }
  if (!repair) {
    const payload = Object.fromEntries(FINAL_REVIEW_CONTRACT_FIELDS.filter((key) => ownerPayload[key] !== undefined).map((key) => [key, ownerPayload[key]]));
    repair = spawn({ work_item_id: owner.work_item_id, job_type: "fix", title: `Repair contract: ${owner.title}`,
      parent_job_id: owner.id, priority: job.priority, model_tier: owner.model_tier, provider: owner.provider,
      reasoning_effort: owner.reasoning_effort,
      payload_json: JSON.stringify({ ...payload, task_mode: ownerPayload.task_mode || "code",
        task_spec: repairTaskSpec, original_task_spec: producerTaskSpec,
        root_job_id: owner.id, root_task_spec: producerTaskSpec,
        root_success_criteria: ownerPayload.success_criteria || [], success_criteria: ownerPayload.success_criteria || [],
        declared_output_contract: false,
        fix_instructions: repairInstructions,
        _plan_task_id: ownerPayload._plan_task_id, _shared_contracts: ownerPayload._shared_contracts,
        _contract_owner_repair: { owner_job_id: owner.id, consumer_job_id: job.id, paths, fingerprint } }) });
  }
  const continuationInstructions = `Producer job #${repair.id} owns the repair of ${paths.join(", ")}. After it succeeds, verify and adapt this consumer within its original scope; do not edit producer files.\n${consumer.task_spec || ""}`;
  const continuationPayload = { ...proposedFix.payload_json,
    task_spec: continuationInstructions,
    files_to_modify: consumer.files_to_modify || [], files_to_create: consumer.files_to_create || [],
    files_to_delete: consumer.files_to_delete || [], create_roots: consumer.create_roots || [],
    _plan_task_id: consumer._plan_task_id, _shared_contracts: contracts,
    fix_instructions: continuationInstructions,
    _contract_consumer_repair: { owner_job_id: owner.id, repair_job_id: repair.id, paths, fingerprint } };
  const continuation = spawn({ ...proposedFix, payload_json: JSON.stringify(continuationPayload) });
  if (!addDependency(continuation.id, repair.id, "hard")) throw new Error("Contract repair dependency rejected");
  return { repair, continuation };
}
