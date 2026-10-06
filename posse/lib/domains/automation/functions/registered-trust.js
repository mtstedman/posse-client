import { AUTOMATION_BUILTINS } from "../../../catalog/custom-tools.js";
import { REGISTERED_AGENT_TRUST_LEVELS } from "../../../catalog/registered-agent.js";
import { authorize, demand } from "./policy.js";

export function approveEntry(store, { entry_id, trust_level, reviewed_by }) {
  demand(REGISTERED_AGENT_TRUST_LEVELS.includes(trust_level), "Unknown trust level", "invalid_request");
  demand(typeof reviewed_by === "string" && reviewed_by.trim(), "Operator audit identity is required", "invalid_request");
  const entry = store.get("entries", entry_id);
  demand(entry?.enabled, "Executable entry is unavailable", "capability_unavailable");
  const previous = store.get("registered_trust", entry_id);
  return store.put("registered_trust", entry_id, {
    entry_id, digest: entry.digest, trust_level, revision: (previous?.revision || 0) + 1,
    reviewed_by: reviewed_by.trim(), reviewed_at: new Date().toISOString(),
  });
}

export function assertRegisteredCapability(service, entryID, pinnedDigest, principal, grantID, seen = new Set()) {
  demand(!seen.has(entryID), "Cyclic executable dependency", "capability_unavailable");
  seen.add(entryID);
  const entry = service.store.get("entries", entryID);
  demand(entry?.enabled && entry.digest === pinnedDigest && service.entryAvailable(entry), "Pinned executable changed or is unavailable", "capability_unavailable");
  const trust = service.store.get("registered_trust", entryID);
  demand(trust?.trust_level === "application_safe" && trust.digest === entry.digest,
    "Executable version is not approved for applications", "forbidden");
  const grant = authorize(service.store.list("grants"), entry, principal, "invoke", grantID);
  service.checkResourceCeiling(entry, grant);
  for (const resource of grant.resources) {
    const current = service.store.get("resources", resource.id);
    demand(current?.enabled && resource.operations.every(op => current.operations.includes(op)), "Resource grant changed", "grant_changed");
  }
  if (entry.kind === "builtin") {
    const operation = AUTOMATION_BUILTINS[entry.capability]?.operation;
    demand(grant.resources.some(resource => resource.operations.includes(operation)), "Builtin needs a bounded resource grant", "forbidden");
  } else if (entry.kind === "sql") {
    demand(entry.definition?.binding?.kind === "folder", "SQL capability needs a fixed folder binding", "forbidden");
  } else if (entry.kind === "script") {
    // The exact operator-approved script and its own input/credential contract are the boundary.
    demand(entry.script && entry.digest, "Script contract is unavailable", "forbidden");
  } else if (entry.kind === "skill") {
    demand(Array.isArray(entry.definition?.capabilities), "Skill dependencies are unavailable", "capability_unavailable");
    for (const dependency of entry.definition.capabilities) {
      demand(dependency.kind === "tool", "Dynamic skill dependency is unavailable to applications", "forbidden");
      const id = dependency.id.startsWith("builtin:") || dependency.id.startsWith("script:") || dependency.id.startsWith("sql:")
        ? dependency.id : AUTOMATION_BUILTINS[dependency.id] ? `builtin:${dependency.id}@1` : dependency.id;
      const pinned = entry.issued_tools?.find(item => item.id === id)?.digest || service.store.get("entries", id)?.digest;
      const nested = assertRegisteredCapability(service, id, pinned, principal, null, new Set(seen));
      if (["external_write", "artifact_write"].includes(nested.entry.effect))
        demand(nested.grant.unattended, "Nested write needs an unattended grant", "forbidden");
      if (nested.entry.kind === "builtin") for (const resource of grant.resources) {
        const allowed = nested.grant.resources.find(item => item.id === resource.id);
        demand(allowed && resource.operations.every(operation => allowed.operations.includes(operation)),
          "Skill grant exceeds a nested resource grant", "forbidden");
      }
    }
  } else {
    demand(false, "Executable kind has no registered boundary", "forbidden");
  }
  return { entry, grant };
}
