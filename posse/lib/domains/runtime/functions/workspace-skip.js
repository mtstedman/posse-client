import { WORKSPACE_SKIP_DIR_NAMES } from "../../../catalog/workspace-traversal.js";
export { WORKSPACE_SKIP_DIR_NAMES, WORKSPACE_SKIP_DIRS } from "../../../catalog/workspace-traversal.js";




export function createWorkspaceSkipDirs(extra = []) {
  return new Set([
    ...WORKSPACE_SKIP_DIR_NAMES,
    ...(Array.isArray(extra) ? extra : []),
  ]);
}
