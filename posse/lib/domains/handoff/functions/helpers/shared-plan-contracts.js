import { AGENT_HANDOFF_SHARED_PLAN_CONTRACT_POLICY } from "../../../../catalog/handoff.js";
import { recordHandoffSoftening } from "./field-diagnostics.js";
import { truncateCompletionProse } from "./shape-normalizer.js";

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const {
  acceptedTaskRoles: ACCEPTED_TASK_ROLES,
  maxContracts: MAX_CONTRACTS,
  maxDeclarations: MAX_DECLARATIONS,
  maxRefsPerTask: MAX_REFS_PER_TASK,
  minTaskRefs: MIN_TASK_REFS,
  taskRoles: TASK_ROLES,
} = AGENT_HANDOFF_SHARED_PLAN_CONTRACT_POLICY;
const NON_DEV_ROLE_RULE = "shared_contract_non_dev_role";
const DEGRADED_RULE = "shared_contract_degraded_to_constraints";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an object`);
  }
  return value;
}

function exactObject(value, keys, label) {
  const object = objectValue(value, label);
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${key} is not allowed`);
    }
  }
  return object;
}

function requiredString(value, label, maxLength, { identity = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is required`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    // Identifiers are join keys. Truncating them can alias distinct contracts
    // or orphan a valid owner; preserve their spelling while softening the cap.
    recordHandoffSoftening(label, identity ? "identity_length_preserved" : "text_truncated", {
      max: maxLength, received: text.length,
    });
    if (!identity) return truncateCompletionProse(text, maxLength);
  }
  return text;
}

function stringList(value, label, { maxItems, maxLength, required = false, identity = false } = {}) {
  if (value == null && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      `${label} must be ${required ? "a non-empty" : "an"} array`,
    );
  }
  if (value.length > maxItems) {
    recordHandoffSoftening(label, "list_trimmed", { max: maxItems, received: value.length });
  }
  return value.slice(0, maxItems).map((entry, index) => requiredString(entry, `${label}[${index}]`, maxLength, { identity }));
}

/**
 * Resolve plan-local shared contracts into identical downstream task text.
 * The canonical handoff packet stays backward compatible: declarations become
 * ordinary task constraints and an explicit success criterion for each user.
 * A contract that breaks the role, reference-count or owner rules is not
 * rejected: its declarations become plain constraints on each task that
 * referenced it, with no owner line or success criterion, and the repair is
 * recorded. Only an unknown contract or owner id still fails.
 */
export function sharedPlanContractAdditions(tasks, rawContracts) {
  if (!Array.isArray(tasks)) return new Map();
  const contractsInput = rawContracts ?? [];
  if (!Array.isArray(contractsInput)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.shared_contracts must be an array");
  }
  if (contractsInput.length > MAX_CONTRACTS) {
    recordHandoffSoftening("agent_handoff.shared_contracts", "list_trimmed", { max: MAX_CONTRACTS, received: contractsInput.length });
  }

  const taskInfo = tasks.map((raw, index) => {
    const task = objectValue(raw, `agent_handoff.tasks[${index}]`);
    const id = task.id == null
      ? `task-${index + 1}`
      : requiredString(task.id, `agent_handoff.tasks[${index}].id`, 80, { identity: true });
    const refs = stringList(task.contract_refs, `agent_handoff.tasks[${index}].contract_refs`, {
      maxItems: MAX_REFS_PER_TASK,
      maxLength: 64,
      identity: true,
    });
    if (new Set(refs).size !== refs.length) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `agent_handoff.tasks[${index}].contract_refs contains duplicates`);
    }
    return { id, role: task.role ?? task.job_type, refs };
  });
  const taskIds = new Set(taskInfo.map(({ id }) => id));

  const contracts = new Map();
  for (const [index, raw] of contractsInput.slice(0, MAX_CONTRACTS).entries()) {
    const label = `agent_handoff.shared_contracts[${index}]`;
    const contract = exactObject(raw, ["id", "owner_task_id", "declarations"], label);
    const id = requiredString(contract.id, `${label}.id`, 64, { identity: true });
    if (!CONTRACT_ID_PATTERN.test(id)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.id must use lowercase letters, digits, and hyphens`);
    }
    if (contracts.has(id)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `agent_handoff.shared_contracts has duplicate id ${id}`);
    }
    const ownerTaskId = requiredString(contract.owner_task_id, `${label}.owner_task_id`, 80, { identity: true });
    if (!taskIds.has(ownerTaskId)) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", `${label}.owner_task_id references unknown task ${ownerTaskId}`);
    }
    const declarations = stringList(contract.declarations, `${label}.declarations`, {
      maxItems: MAX_DECLARATIONS,
      maxLength: 500,
      required: true,
    });
    contracts.set(id, { id, index, ownerTaskId, declarations, users: [], counted: [], nonDevRefs: [] });
  }

  const droppedIds = new Set(contractsInput.slice(MAX_CONTRACTS)
    .map((raw) => typeof raw?.id === "string" ? raw.id.trim() : null)
    .filter((id) => id && !contracts.has(id)));
  for (const [index, task] of taskInfo.entries()) {
    for (const ref of task.refs) {
      if (!contracts.has(ref) && !droppedIds.has(ref)) {
        fail("AGENT_HANDOFF_SEMANTIC_INVALID", `agent_handoff.tasks[${index}].contract_refs references unknown contract ${ref}`);
      }
    }
  }
  for (const [index, task] of taskInfo.entries()) {
    const dropped = task.refs.filter((ref) => droppedIds.has(ref));
    if (dropped.length) {
      recordHandoffSoftening(`agent_handoff.tasks[${index}].contract_refs`, "capped_contract_refs_removed", { received: dropped.length });
      task.refs = task.refs.filter((ref) => !droppedIds.has(ref));
    }
    for (const ref of task.refs) {
      const contract = contracts.get(ref);
      if (!contract) {
        fail("AGENT_HANDOFF_SEMANTIC_INVALID", `agent_handoff.tasks[${index}].contract_refs references unknown contract ${ref}`);
      }
      contract.users.push(task.id);
      if (!ACCEPTED_TASK_ROLES.includes(task.role)) continue;
      contract.counted.push(task.id);
      if (!TASK_ROLES.includes(task.role)) contract.nonDevRefs.push({ index, role: task.role });
    }
  }

  // Rejecting over contract framing cost the names: a live planner told its
  // artificer-owned contract was invalid deleted it, and the dev task that
  // used the art lost the exact file names. A contract that still breaks a
  // rule keeps its declarations; only the owner and success framing go.
  const degraded = new Set();
  for (const contract of contracts.values()) {
    const reasons = [
      ...(contract.counted.length < contract.users.length ? ["task_role"] : []),
      ...(contract.counted.length < MIN_TASK_REFS ? ["min_task_refs"] : []),
      ...(!contract.counted.includes(contract.ownerTaskId) ? ["owner_reference"] : []),
    ];
    if (reasons.length > 0) {
      degraded.add(contract.id);
      recordHandoffSoftening(`agent_handoff.shared_contracts[${contract.index}]`, DEGRADED_RULE, {
        contract: contract.id,
        reasons,
        task_ids: contract.users,
      });
      continue;
    }
    for (const { index, role } of contract.nonDevRefs) {
      recordHandoffSoftening(`agent_handoff.tasks[${index}].contract_refs`, NON_DEV_ROLE_RULE, {
        contract: contract.id,
        role,
      });
    }
  }

  return new Map(taskInfo.map((task, index) => {
    const selected = task.refs.map((ref) => contracts.get(ref));
    const kept = selected.filter((contract) => !degraded.has(contract.id));
    return [index, {
      constraints: selected.flatMap((contract) => (degraded.has(contract.id)
        ? contract.declarations
        : [
          `[shared contract ${contract.id}] owner task: ${contract.ownerTaskId}`,
          `[shared contract ${contract.id}] Ownership coordinates the interface; it does not expand file scope. Implement declarations only in this task's declared write scope. Declarations in sibling-owned files are read-only context for this task.`,
          ...contract.declarations.map((declaration) => `[shared contract ${contract.id}] ${declaration}`),
        ])),
      successCriteria: kept.map(
        (contract) => `[shared contract ${contract.id}] All declared names, paths, signatures, and data shapes are used exactly.`,
      ),
    }];
  }));
}
