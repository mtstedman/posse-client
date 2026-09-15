import { AGENT_HANDOFF_SHARED_PLAN_CONTRACT_POLICY } from "../../../../catalog/handoff.js";

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const {
  maxContracts: MAX_CONTRACTS,
  maxDeclarations: MAX_DECLARATIONS,
  maxRefsPerTask: MAX_REFS_PER_TASK,
  minTaskRefs: MIN_TASK_REFS,
} = AGENT_HANDOFF_SHARED_PLAN_CONTRACT_POLICY;

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

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is required`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${maxLength} characters`);
  }
  return text;
}

function stringList(value, label, { maxItems, maxLength, required = false } = {}) {
  if (value == null && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      `${label} must be ${required ? "a non-empty" : "an"} array`,
    );
  }
  if (value.length > maxItems) {
    fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${maxItems} entries`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`, maxLength));
}

/**
 * Resolve plan-local shared contracts into identical downstream task text.
 * The canonical handoff packet stays backward compatible: declarations become
 * ordinary task constraints and an explicit success criterion for each user.
 */
export function sharedPlanContractAdditions(tasks, rawContracts) {
  if (!Array.isArray(tasks)) return new Map();
  const contractsInput = rawContracts ?? [];
  if (!Array.isArray(contractsInput)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.shared_contracts must be an array");
  }
  if (contractsInput.length > MAX_CONTRACTS) {
    fail("AGENT_HANDOFF_TOO_LARGE", `agent_handoff.shared_contracts exceeds ${MAX_CONTRACTS} entries`);
  }

  const taskInfo = tasks.map((raw, index) => {
    const task = objectValue(raw, `agent_handoff.tasks[${index}]`);
    const id = task.id == null
      ? `task-${index + 1}`
      : requiredString(task.id, `agent_handoff.tasks[${index}].id`, 80);
    const refs = stringList(task.contract_refs, `agent_handoff.tasks[${index}].contract_refs`, {
      maxItems: MAX_REFS_PER_TASK,
      maxLength: 64,
    });
    if (new Set(refs).size !== refs.length) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `agent_handoff.tasks[${index}].contract_refs contains duplicates`);
    }
    return { id, role: task.role ?? task.job_type, refs };
  });
  const taskIds = new Set(taskInfo.map(({ id }) => id));

  const contracts = new Map();
  for (const [index, raw] of contractsInput.entries()) {
    const label = `agent_handoff.shared_contracts[${index}]`;
    const contract = exactObject(raw, ["id", "owner_task_id", "declarations"], label);
    const id = requiredString(contract.id, `${label}.id`, 64);
    if (!CONTRACT_ID_PATTERN.test(id)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.id must use lowercase letters, digits, and hyphens`);
    }
    if (contracts.has(id)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `agent_handoff.shared_contracts has duplicate id ${id}`);
    }
    const ownerTaskId = requiredString(contract.owner_task_id, `${label}.owner_task_id`, 80);
    if (!taskIds.has(ownerTaskId)) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", `${label}.owner_task_id references unknown task ${ownerTaskId}`);
    }
    const declarations = stringList(contract.declarations, `${label}.declarations`, {
      maxItems: MAX_DECLARATIONS,
      maxLength: 500,
      required: true,
    });
    contracts.set(id, { id, ownerTaskId, declarations });
  }

  const users = new Map([...contracts.keys()].map((id) => [id, []]));
  for (const [index, task] of taskInfo.entries()) {
    for (const ref of task.refs) {
      const contract = contracts.get(ref);
      if (!contract) {
        fail("AGENT_HANDOFF_SEMANTIC_INVALID", `agent_handoff.tasks[${index}].contract_refs references unknown contract ${ref}`);
      }
      if (!AGENT_HANDOFF_SHARED_PLAN_CONTRACT_POLICY.taskRoles.includes(task.role)) {
        fail("AGENT_HANDOFF_SEMANTIC_INVALID", `shared contract ${ref} may only be assigned to dev tasks`);
      }
      users.get(ref).push(task.id);
    }
  }

  for (const contract of contracts.values()) {
    const contractUsers = users.get(contract.id);
    if (contractUsers.length < MIN_TASK_REFS) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", `shared contract ${contract.id} must be referenced by at least ${MIN_TASK_REFS} dev tasks`);
    }
    if (!contractUsers.includes(contract.ownerTaskId)) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", `owner task ${contract.ownerTaskId} must reference shared contract ${contract.id}`);
    }
  }

  return new Map(taskInfo.map((task, index) => {
    const selected = task.refs.map((ref) => contracts.get(ref));
    return [index, {
      constraints: selected.flatMap((contract) => [
        `[shared contract ${contract.id}] owner task: ${contract.ownerTaskId}`,
        ...contract.declarations.map((declaration) => `[shared contract ${contract.id}] ${declaration}`),
      ]),
      successCriteria: selected.map(
        (contract) => `[shared contract ${contract.id}] All declared names, paths, signatures, and data shapes are used exactly.`,
      ),
    }];
  }));
}
