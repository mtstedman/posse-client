// @ts-check
// `posse session trees` and the console's `trees` / `purge`: list the host's
// session trees and remove the ones no longer needed.

import { execFileSync } from "node:child_process";

import { getDb } from "../../../shared/storage/functions/index.js";
import { getLivePairingState } from "./state.js";
import { cleanupGitHubSessionRepository, removeSessionCredentialDirectory } from "./github-session.js";
import { listSessionTrees, purgeSessionTree } from "./session-trees.js";

function git(args, cwd) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }) || "").trim();
}

/** The ref a tree's work is compared against: the repository's trunk. */
export function resolveTrunkRef(projectDir, exec = git) {
  for (const ref of ["origin/master", "origin/main", "master", "main"]) {
    try {
      exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], projectDir);
      return ref;
    } catch { /* try the next */ }
  }
  return "HEAD";
}

/** Session ids recorded for a branch: its recovery refs are keyed by them. */
function sessionIdsRecordedFor(branch) {
  try {
    return getDb().prepare("SELECT id, remote_session_id FROM pairing_sessions WHERE shared_branch = ?").all(branch)
      .flatMap((row) => [row.id, row.remote_session_id]).filter(Boolean);
  } catch {
    return [];
  }
}

export function currentSessionBranch() {
  try { return getLivePairingState()?.shared_branch || null; } catch { return null; }
}

/** @param {string} projectDir */
export function collectSessionTrees(projectDir, { git: exec = git } = {}) {
  return listSessionTrees(projectDir, {
    trunkRef: resolveTrunkRef(projectDir, exec),
    activeBranch: currentSessionBranch(),
    git: exec,
    sessionIdsFor: sessionIdsRecordedFor,
  });
}

export function describeTree(tree) {
  const where = tree.status === "active" ? "live session"
    : tree.status === "integrated" ? "in the trunk"
      : `${tree.ahead} commit${tree.ahead === 1 ? "" : "s"} the trunk lacks`;
  const kept = tree.keptUp ? ` · left up${tree.repository ? ` (${tree.repository})` : ""}` : "";
  return `${tree.branch}  ${tree.status.padEnd(10)} ${where}${kept}`;
}

/** Resolve what a person typed (`pair-abc`, `abc`, the full branch) to one tree. */
export function resolveTree(trees, text) {
  const wanted = String(text || "").trim();
  if (!wanted) return { error: "name a tree (see `trees`)" };
  const matches = trees.filter((tree) => tree.branch === wanted
    || tree.branch === `posse/${wanted}`
    || tree.branch === `posse/pair-${wanted}`
    || tree.branch.startsWith(`posse/pair-${wanted}`));
  if (matches.length === 1) return { tree: matches[0] };
  return { error: matches.length ? `"${wanted}" matches ${matches.length} trees; type more of the name` : `no tree matches "${wanted}"` };
}

/**
 * Purge one tree or every integrated one. Returns lines to show.
 *
 * @param {string} projectDir
 * @param {{ target?: string|null, merged?: boolean, force?: boolean }} options
 */
export function purgeTrees(projectDir, { target = null, merged = false, force = false } = {}, deps = {}) {
  const exec = deps.git || git;
  const trees = collectSessionTrees(projectDir, { git: exec });
  const options = {
    trunkRef: resolveTrunkRef(projectDir, exec),
    activeBranch: currentSessionBranch(),
    force,
    git: exec,
    sessionIdsFor: sessionIdsRecordedFor,
    deleteRepository: deps.deleteRepository || ((repository) => cleanupGitHubSessionRepository(repository, { cwd: projectDir })),
    removeCredentials: deps.removeCredentials || removeSessionCredentialDirectory,
  };
  /** @type {string[]} */
  let branches = [];
  if (merged) branches = trees.filter((tree) => tree.status === "integrated").map((tree) => tree.branch);
  else {
    const resolved = resolveTree(trees, target);
    if (resolved.error) return { ok: false, lines: [`Cannot purge: ${resolved.error}`], results: [] };
    branches = [resolved.tree.branch];
  }
  if (branches.length === 0) return { ok: true, lines: ["Nothing to purge: no session tree is fully in the trunk."], results: [] };
  const results = branches.map((branch) => purgeSessionTree(projectDir, branch, options));
  const lines = results.flatMap((result, index) => {
    const name = branches[index];
    if (!result.ok && result.message) return [`${name}: not purged — ${result.message}`];
    const head = `${name}: ${result.ok ? "purged" : "partly purged"}${result.removed?.length ? ` (${result.removed.join(", ")})` : ""}`;
    return [head, ...(result.problems || []).map((problem) => `  ! ${problem}`)];
  });
  return { ok: results.every((result) => result.ok), lines, results };
}

/**
 * `posse session trees [purge <name>|--merged] [--force]`
 *
 * @param {{ projectDir: string, which?: string|null, value?: string|null, force?: boolean, merged?: boolean,
 *   json?: boolean, C?: Record<string, string> }} args
 */
export function runSessionTreesCommand({ projectDir, which = null, value = null, force = false, merged = false, json = false, C = {} }) {
  const out = (text) => { if (!json) console.log(text); };
  if (which && which !== "purge") {
    throw Object.assign(new Error("Usage: posse session trees [purge <tree>|purge --merged] [--force]"), { code: "pairing_argument_unexpected" });
  }
  if (!which) {
    const trees = collectSessionTrees(projectDir);
    if (json) { console.log(JSON.stringify({ ok: true, trees })); return { ok: true, trees }; }
    out(`\n  ${C.bold || ""}Session trees${C.reset || ""}`);
    if (trees.length === 0) out("  none");
    for (const tree of trees) out(`  ${describeTree(tree)}`);
    out(`\n  ${C.dim || ""}Remove one with \`posse session trees purge <tree>\` (or \`purge --merged\` for every one already in the trunk).${C.reset || ""}\n`);
    return { ok: true, trees };
  }
  if (!value && !merged) {
    throw Object.assign(new Error("Usage: posse session trees purge <tree> | purge --merged"), { code: "pairing_argument_required" });
  }
  const result = purgeTrees(projectDir, { target: value, merged, force });
  if (json) console.log(JSON.stringify(result));
  else for (const line of result.lines) out(`  ${line}`);
  if (!json) out("");
  return result;
}
