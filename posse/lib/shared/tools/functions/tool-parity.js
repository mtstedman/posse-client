// Parity invariants binding the shared tool metadata to the executors each
// runtime attaches. These run at boot (cheap) and are codified as tests, so a
// tool that is advertised without an executor — or a mutating tool handed to a
// read-only role — fails loudly instead of silently misbehaving at runtime.

// Roles that never receive a worktree-mutating tool. assessor/dev/artificer are
// intentionally excluded: the assessor runs tests and a read-only bash variant
// to verify (but does not author tests or write files); dev/artificer write
// within scope. researcher/planner are discovery-only; preflight/delegator are
// routing-only.
export const READ_ONLY_ROLES = Object.freeze(["researcher", "planner", "preflight", "delegator"]);

/**
 * No worktree-mutating tool may be advertised to a strictly read-only role.
 * @param {{all: () => Array}} registry
 */
export function assertMutationRoleSafety(registry) {
  const violations = [];
  for (const entry of registry.all()) {
    if (!entry.mutatesWorktree) continue;
    const bad = entry.roles.filter((role) => READ_ONLY_ROLES.includes(role));
    if (bad.length) {
      violations.push(`${entry.id} mutates the worktree but is allowed for read-only role(s): ${bad.join(", ")}`);
    }
  }
  if (violations.length) {
    throw new Error(`Tool mutation/role safety violated:\n- ${violations.join("\n- ")}`);
  }
}

/**
 * Every tool advertised on a transport must have an attached executor.
 * @param {{advertisedNames: (t: string) => string[]}} registry
 * @param {Iterable<string>} executableNames
 * @param {string} transport
 */
export function assertAdvertisedHaveExecutors(registry, executableNames, transport) {
  const executable = new Set(executableNames);
  const missing = registry.advertisedNames(transport).filter((name) => !executable.has(name));
  if (missing.length) {
    throw new Error(
      `Tools advertised on "${transport}" transport without an attached executor: ${missing.join(", ")}`,
    );
  }
}
