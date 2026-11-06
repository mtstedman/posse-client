import { createHash } from "node:crypto";
import { LEGACY_REQUIREMENT_CONTRACT_VERSION, REQUIREMENT_CONTRACT_VERSION, REQUIREMENT_SOURCE_FIELDS, REQUIREMENT_STATES } from "../../../catalog/requirements.js";
import { pruneBlockedFileRequirements } from "../../runtime/functions/blocked-file-requirements.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Numbered-list markers are formatting, not independent requirements. Keep
// original text in the immutable contract even when its projection is compact.
const markerOnly = text => /^(?:[-*+]\s*)?(?:\d+[.)]|\[[ xX]\]|[-*+])$/.test(text.trim());
function requirementsFor(original, { legacy = false, legacyHiddenIgnores = false } = {}) {
  const requirements = [];
  for (const [field, value] of Object.entries(original)) {
    const entries = Array.isArray(value) ? value : String(value).split(/\r?\n|(?<=[.!?;])\s+/);
    for (const entry of entries) {
      let text = String(entry).trim();
      if (!legacy && field !== "must_modify") {
        if (markerOnly(text)) continue;
        text = text.replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?/, "");
      }
      if (!text) continue;
      const omissions = pruneBlockedFileRequirements({ [field]: ["success_criteria", "must_modify"].includes(field) ? [text] : text }).omissions;
      let paths = [...new Set(omissions.flatMap(item => item.paths))];
      // Version 1 originally treated ignore configuration as hidden. Validate
      // that historical projection without applying it to new contracts.
      if (legacyHiddenIgnores) {
        const tokens = (text.match(/[\w.@*?+-]+(?:[\\/][\w.@*?+-]+)*/g) || [])
          .map(token => token.replace(/[.]+$/, "").replace(/\\/g, "/").replace(/^\.\//, ""));
        paths = [...new Set(tokens.filter(file => paths.includes(file) || file.toLowerCase().split("/").includes(".gitignore")))];
      }
      requirements.push({ id: digest([field, text]), field, text, state: paths.length ? REQUIREMENT_STATES.CONSTRAINED : REQUIREMENT_STATES.OPEN, blocked_paths: paths });
    }
  }
  return requirements;
}

/** Local immutable evidence of the assigned intent, before policy projection. */
export function captureRequirementContract(payload = {}) {
  const original = Object.fromEntries(REQUIREMENT_SOURCE_FIELDS.filter(field => payload[field] != null)
    .map(field => [field, structuredClone(payload[field])]));
  return { schema_version: REQUIREMENT_CONTRACT_VERSION, digest: digest(original), original, requirements: requirementsFor(original) };
}

export function requirementContracts(payload = {}) {
  return (Array.isArray(payload._requirement_contracts) ? payload._requirement_contracts : []).filter(contract => {
    if (!contract?.original || contract.digest !== digest(contract.original)) return false;
    const expectedOriginal = captureRequirementContract(contract.original).original;
    if (JSON.stringify(expectedOriginal) !== JSON.stringify(contract.original)) return false;
    const legacy = contract.schema_version === LEGACY_REQUIREMENT_CONTRACT_VERSION;
    if (!legacy && contract.schema_version !== REQUIREMENT_CONTRACT_VERSION) return false;
    const actual = JSON.stringify(contract.requirements);
    return actual === JSON.stringify(requirementsFor(contract.original, { legacy }))
      || legacy && actual === JSON.stringify(requirementsFor(contract.original, { legacy, legacyHiddenIgnores: true }));
  });
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
