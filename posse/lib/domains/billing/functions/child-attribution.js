function positiveId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function nonNegativeFinite(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

// Resolve accounting ownership without rewriting the persisted execution
// identity. A child remains role=subagent in agent_calls, while role rollups
// can charge it to the root parent that authorized the spend.
export function attributeAgentCallParents(rows = [], { ancestors = [] } = {}) {
  const calls = Array.isArray(rows) ? rows : [];
  const lookupRows = [
    ...calls,
    ...(Array.isArray(ancestors) ? ancestors : []),
  ];
  const byId = new Map(lookupRows
    .map((row) => [positiveId(row?.id), row])
    .filter(([id]) => id != null));

  return calls.map((row) => {
    const immediateParentId = positiveId(row?.parent_agent_call_id);
    if (immediateParentId == null) {
      return {
        ...row,
        accounting_role: String(row?.role || "unknown"),
        accounting_parent_role: null,
        accounting_root_agent_call_id: positiveId(row?.id),
        accounting_parent_status: "root",
      };
    }

    let parent = byId.get(immediateParentId) || null;
    if (!parent) {
      return {
        ...row,
        accounting_role: String(row?.role || "unknown"),
        accounting_parent_role: null,
        accounting_root_agent_call_id: null,
        accounting_parent_status: "orphan",
      };
    }

    const seen = new Set([positiveId(row?.id)].filter(Boolean));
    let root = parent;
    while (positiveId(root?.parent_agent_call_id) != null) {
      const rootId = positiveId(root.id);
      if (rootId != null) seen.add(rootId);
      const nextId = positiveId(root.parent_agent_call_id);
      if (seen.has(nextId)) {
        return {
          ...row,
          accounting_role: String(row?.role || "unknown"),
          accounting_parent_role: String(parent?.role || "unknown"),
          accounting_root_agent_call_id: null,
          accounting_parent_status: "cycle",
        };
      }
      const next = byId.get(nextId);
      if (!next) {
        return {
          ...row,
          accounting_role: String(row?.role || "unknown"),
          accounting_parent_role: String(parent?.role || "unknown"),
          accounting_root_agent_call_id: null,
          accounting_parent_status: "orphan",
        };
      }
      root = next;
    }

    return {
      ...row,
      accounting_role: String(root?.role || "unknown"),
      accounting_parent_role: String(parent?.role || "unknown"),
      accounting_root_agent_call_id: positiveId(root?.id),
      accounting_parent_status: "attributed",
    };
  });
}

export function accountingRoleForAgentCall(row = {}) {
  return String(row.accounting_role || row.role || "unknown");
}

export function isAttributedChildAgentCall(row = {}) {
  return positiveId(row.parent_agent_call_id) != null
    && row.accounting_parent_status === "attributed";
}

export function childKindForAgentCall(row = {}) {
  return isAttributedChildAgentCall(row)
    ? String(row.child_kind || "unknown")
    : null;
}

export function firstRequestInputTokens(segments = [], call = {}) {
  const ordered = (Array.isArray(segments) ? segments : [])
    .filter((segment) => positiveId(segment?.request_ordinal) != null)
    .sort((left, right) => Number(left.request_ordinal) - Number(right.request_ordinal));
  if (ordered.length > 0 && Number(ordered[0].request_ordinal) === 1) {
    return nonNegativeFinite(ordered[0].input_tokens);
  }
  // A one-turn aggregate is itself the first turn. Multi-turn aggregates do
  // not contain enough information to reconstruct spin-up honestly.
  if (Number(call?.turns_used) === 1) {
    return nonNegativeFinite(call?.input_tokens);
  }
  return null;
}
