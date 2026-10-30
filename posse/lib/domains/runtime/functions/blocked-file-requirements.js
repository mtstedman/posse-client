import { isSensitiveEnvRepoPath, normalizeRepoRelativePath, protectedMutablePathReason } from "./protected-paths.js";
import { agentHiddenReadablePathReason } from "../../../shared/scope/functions/agent-hidden-paths.js";

// Match explicit path tokens, including bare dotfiles, without treating
// process.env or env.example as references to a protected environment file.
function blockedPaths(text) {
  const tokens = String(text || "").match(/[\w.@*?+-]+(?:[\\/][\w.@*?+-]+)*/g) || [];
  return [...new Set(tokens.map((token) => normalizeRepoRelativePath(token.replace(/[.]+$/, "")))
    .filter((file) => isSensitiveEnvRepoPath(file)
      || agentHiddenReadablePathReason(file) || protectedMutablePathReason(file)))];
}

/** Remove explicit requirements for policy-blocked files; retain an audit trail. */
export function pruneBlockedFileRequirements(payload = {}) {
  const cleaned = { ...payload };
  const omissions = [];
  const keep = (field, requirement) => {
    const paths = blockedPaths(requirement);
    if (paths.length === 0) return true;
    omissions.push({ field, requirement, paths });
    return false;
  };
  for (const field of ["success_criteria", "must_modify"]) {
    if (payload[field] == null) continue;
    const requirements = Array.isArray(payload[field]) ? payload[field] : [payload[field]];
    cleaned[field] = requirements.filter((requirement) => keep(field, requirement));
  }
  for (const field of ["task_spec", "instructions", "fix_instructions"]) {
    if (typeof payload[field] !== "string") continue;
    const parts = payload[field].split(/\r?\n|(?<=[.!?;])\s+/);
    const kept = parts.filter((requirement) => keep(field, requirement));
    if (kept.length !== parts.length) cleaned[field] = kept.join("\n");
  }
  return { payload: cleaned, omissions };
}
