import { createHash } from "node:crypto";
import { REQUIREMENT_CONTRACT_VERSION, REQUIREMENT_SOURCE_FIELDS, REQUIREMENT_STATES } from "../../../catalog/requirements.js";
import { pruneBlockedFileRequirements } from "../../runtime/functions/blocked-file-requirements.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Local immutable evidence of the assigned intent, before policy projection. */
export function captureRequirementContract(payload = {}) {
  const original = Object.fromEntries(REQUIREMENT_SOURCE_FIELDS.filter(field => payload[field] != null)
    .map(field => [field, structuredClone(payload[field])]));
  const requirements = [];
  for (const [field, value] of Object.entries(original)) {
    const entries = Array.isArray(value) ? value : String(value).split(/\r?\n|(?<=[.!?;])\s+/);
    for (const entry of entries) {
      const text = String(entry).trim();
      if (!text) continue;
      const omissions = pruneBlockedFileRequirements({ [field]: ["success_criteria", "must_modify"].includes(field) ? [text] : text }).omissions;
      const paths = [...new Set(omissions.flatMap(item => item.paths))];
      requirements.push({ id: digest([field, text]), field, text, state: paths.length ? REQUIREMENT_STATES.CONSTRAINED : REQUIREMENT_STATES.OPEN, blocked_paths: paths });
    }
  }
  return { schema_version: REQUIREMENT_CONTRACT_VERSION, digest: digest(original), original, requirements };
}

export function requirementContracts(payload = {}) {
  return (Array.isArray(payload._requirement_contracts) ? payload._requirement_contracts : [])
    .filter(contract => contract?.schema_version === REQUIREMENT_CONTRACT_VERSION && contract.digest === digest(contract.original)
      && JSON.stringify(captureRequirementContract(contract.original).requirements) === JSON.stringify(contract.requirements));
}

export function inheritRequirementContracts(payload = {}) {
  const contracts = requirementContracts(payload);
  return contracts.length ? { _requirement_contracts: structuredClone(contracts) } : {};
}

export function compileRequirementContracts(task, parent = {}) {
  const contracts = [...requirementContracts(parent), captureRequirementContract(task)];
  return [...new Map(contracts.map(contract => [contract.digest, contract])).values()];
}

export function renderRequirementContracts(payload = {}) {
  const contracts = requirementContracts(payload);
  if (!contracts.length) return "";
  return ["ORIGINAL REQUIREMENT EVIDENCE (local, immutable; not additional tool authority):",
    "Policy-constrained requirements remain unresolved unless their behavior is established through permitted evidence or explicitly waived. Protected paths must not be read or changed. A safe equivalent may establish behavior; omission from executable instructions is not completion. Inherited requirements may span sibling tasks: evaluate only the assigned scope and report remaining work separately.",
    JSON.stringify(contracts.map(({ digest, requirements }) => ({ digest, requirements }))),
  ].join("\n");
}
