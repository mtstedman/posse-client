// @ts-check
import { readonlySet } from "./readonly-collections.js";



export const WORKSPACE_SKIP_DIR_NAMES = Object.freeze([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".cache",
  ".vscode",
  ".idea",
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
  ".claude",
  ".codex",
]);

export const WORKSPACE_SKIP_DIRS = readonlySet(WORKSPACE_SKIP_DIR_NAMES);

/** Pure profile derivation; directory walking and symlink policy stay in consumers. */
function traversalProfile({ add = [], remove = [] } = {}) {
  const removed = new Set(remove);
  return readonlySet([...WORKSPACE_SKIP_DIR_NAMES.filter(name => !removed.has(name)), ...add]);
}

export const WORKSPACE_TRAVERSAL_PROFILES = Object.freeze({
  // Omit caches, dependencies and generated test output; provider config directories may contain tests.
  unit_tests: traversalProfile({
    add: [".hg",".svn",".nuxt","target","vendor","venv",".venv"],
    remove: ["__pycache__",".claude",".codex"],
  }),
  // Include editor/provider configuration; omit dependency roots and generated output.
  dependency_discovery: traversalProfile({
    add: [".hg",".svn","vendor",".nuxt"],
    remove: [".vscode",".idea",".claude",".codex"],
  }),
  // Package roots may live under build/output directories, so prune only dependencies and runtime metadata.
  package_discovery: traversalProfile({
    add: ["vendor"],
    remove: [".next","dist","build","coverage","__pycache__",".cache",".vscode",".idea",".claude",".codex"],
  }),
  // Keep source-bearing configuration; bound broad fuzzy searches by excluding large generated trees.
  fuzzy_scope: traversalProfile({
    add: ["target","vendor"],
    remove: [".next","coverage","__pycache__",".vscode",".idea",".posse-worktrees",".posse-test-suites",".claude",".codex"],
  }),
  // Skip native build/dependency trees and Python bytecode while preserving configuration sources.
  same_name_index: traversalProfile({
    add: ["target","vendor"],
    remove: [".next","coverage",".cache",".vscode",".idea",".posse-worktrees",".posse-test-suites",".claude",".codex"],
  }),
});
