// @ts-check
// Session trees: a host's `posse/pair-*` branches and, for a tree left up on
// quit, the private GitHub repository and credentials that let the host rejoin
// it. This module keeps the registry of left-up trees, lists every tree with
// whether its work is in the trunk, and purges one (branch, repository,
// credentials, recovery refs) without ever touching the live session.

import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import fs from "node:fs";
import path from "node:path";

const REGISTRY_VERSION = 1;
const PAIR_BRANCH_PREFIX = "posse/pair-";

/** @typedef {{ branch: string, sessionId: string, remoteSessionId?: string|null, repository: string|null, remoteUrl: string|null, credentialDirectory: string|null, keptAt: string, trunkOid: string|null }} KeptTree */

export function sessionTreesRegistryPath(projectDir) {
  return path.join(projectDir, ".posse", "session-trees.json");
}

function readRegistry(projectDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionTreesRegistryPath(projectDir), "utf8"));
    if (parsed?.version !== REGISTRY_VERSION) return { trees: [], intents: {} };
    const trees = Array.isArray(parsed.trees)
      ? parsed.trees.filter((tree) => typeof tree?.branch === "string" && tree.branch.startsWith(PAIR_BRANCH_PREFIX))
      : [];
    const intents = parsed.intents && typeof parsed.intents === "object" && !Array.isArray(parsed.intents) ? parsed.intents : {};
    return { trees, intents };
  } catch {
    return { trees: [], intents: {} };
  }
}

/** @returns {KeptTree[]} */
export function readKeptTrees(projectDir) {
  return readRegistry(projectDir).trees;
}

function writeRegistry(projectDir, { trees, intents }) {
  const file = sessionTreesRegistryPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: REGISTRY_VERSION, trees, intents }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* the rename consumed it */ }
  }
}

function writeKeptTrees(projectDir, trees) {
  writeRegistry(projectDir, { ...readRegistry(projectDir), trees });
}

/**
 * What the host chose to do with a session's tree on quit, recorded before the
 * close starts so whichever process finishes the integration (this one, or a
 * later `posse session integrate`) applies it.
 *
 * @param {string} projectDir
 * @param {Array<string|null|undefined>} sessionIds ids the session is known by
 * @param {"keep"|"purge"} action
 */
export function setTreeIntent(projectDir, sessionIds, action) {
  if (action !== "keep" && action !== "purge") return;
  const registry = readRegistry(projectDir);
  for (const id of sessionIds.filter(Boolean)) registry.intents[String(id)] = action;
  writeRegistry(projectDir, registry);
}

/** @returns {"keep"|"purge"|null} */
export function readTreeIntent(projectDir, sessionIds) {
  const { intents } = readRegistry(projectDir);
  for (const id of sessionIds.filter(Boolean)) {
    const action = intents[String(id)];
    if (action === "keep" || action === "purge") return action;
  }
  return null;
}

export function clearTreeIntent(projectDir, sessionIds) {
  const registry = readRegistry(projectDir);
  let changed = false;
  for (const id of sessionIds.filter(Boolean)) {
    if (String(id) in registry.intents) { delete registry.intents[String(id)]; changed = true; }
  }
  if (changed) writeRegistry(projectDir, registry);
}

/** Record a tree left up on quit; replaces any entry for the same branch. */
export function registerKeptTree(projectDir, tree) {
  const entry = {
    branch: String(tree.branch),
    sessionId: String(tree.sessionId || ""),
    remoteSessionId: tree.remoteSessionId || null,
    repository: tree.repository || null,
    remoteUrl: tree.remoteUrl || null,
    credentialDirectory: tree.credentialDirectory || null,
    keptAt: tree.keptAt || new Date().toISOString(),
    trunkOid: tree.trunkOid || null,
  };
  const others = readKeptTrees(projectDir).filter((existing) => existing.branch !== entry.branch);
  writeKeptTrees(projectDir, [...others, entry]);
  return entry;
}

export function forgetKeptTree(projectDir, branch) {
  const remaining = readKeptTrees(projectDir).filter((tree) => tree.branch !== branch);
  writeKeptTrees(projectDir, remaining);
}

function defaultGit(args, cwd) {
  // An operator surface: system Git through the sanctioned direct adapter.
  return String(adminGitExec(args, cwd, { timeoutMs: 60_000 }) || "").trim();
}

function tryGit(git, args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}

/**
 * @typedef {object} SessionTree
 * @property {string} branch
 * @property {string|null} tip
 * @property {"active"|"integrated"|"unmerged"} status
 * @property {number} ahead commits the trunk lacks: those after the recorded
 *   promotion of the branch when there is one, else those not reachable from the trunk
 * @property {boolean} keptUp a registered tree whose repository and credentials are kept
 * @property {string|null} repository
 * @property {string|null} keptAt
 * @property {string[]} recoveryRefs
 */

const PROMOTION_REF_PREFIX = "refs/posse/pairing-promotions/";
const SOURCE_REF_PREFIX = "refs/posse/pairing-sources/";

function isAncestor(git, ancestor, descendant, cwd) {
  return tryGit(git, ["merge-base", "--is-ancestor", ancestor, descendant], cwd) !== null;
}

/**
 * The session heads a close published: for each promotion record, the source
 * it fetched (`refs/posse/pairing-sources/<id>`) when its candidate
 * (`refs/posse/pairing-promotions/<id>`) is on the trunk. An abandoned
 * integration keeps its candidate ref, but that candidate never landed.
 */
function promotedSources(git, projectDir, trunkRef, recoveryRefs) {
  if (!trunkRef) return [];
  const sources = [];
  for (const ref of recoveryRefs) {
    if (!ref.startsWith(PROMOTION_REF_PREFIX)) continue;
    const candidate = tryGit(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], projectDir);
    if (!candidate || !isAncestor(git, candidate, trunkRef, projectDir)) continue;
    const source = tryGit(git, ["rev-parse", "--verify", "--quiet",
      `${SOURCE_REF_PREFIX}${ref.slice(PROMOTION_REF_PREFIX.length)}^{commit}`], projectDir);
    if (source) sources.push(source);
  }
  return sources;
}

/**
 * Every local `posse/pair-*` branch, with where it stands against the trunk.
 * "integrated" means a recorded promotion published its head (a close squashes
 * the work, so the branch shares no history with the trunk), or its tree
 * equals the trunk's, or the trunk already contains it; "unmerged" means it
 * holds work the trunk lacks, including commits made after its promotion.
 *
 * @param {string} projectDir
 * @param {{ trunkRef: string, activeBranch?: string|null, git?: (args: string[], cwd: string) => string,
 *   sessionIdsFor?: (branch: string) => string[] }} options sessionIdsFor names the session ids recorded for a
 *   branch (the recovery refs are keyed by them)
 * @returns {SessionTree[]}
 */
export function listSessionTrees(projectDir, { trunkRef, activeBranch = null, git = defaultGit, sessionIdsFor = () => [] }) {
  const registry = new Map(readKeptTrees(projectDir).map((tree) => [tree.branch, tree]));
  const heads = (tryGit(git, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${PAIR_BRANCH_PREFIX}*`], projectDir) || "")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const recovery = (tryGit(git, ["for-each-ref", "--format=%(refname)", "refs/posse/pairing-sources", "refs/posse/pairing-promotions"], projectDir) || "")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const published = heads.length > 0 ? promotedSources(git, projectDir, trunkRef, recovery) : [];
  const count = (branch, excluded) => {
    const text = tryGit(git, ["rev-list", "--count", branch, ...excluded.filter(Boolean).map((ref) => `^${ref}`)], projectDir);
    // A failed count is not zero commits ahead.
    return /^\d+$/u.test(String(text ?? "")) ? Number(text) : NaN;
  };
  return heads.map((branch) => {
    const kept = registry.get(branch) || null;
    const tip = tryGit(git, ["rev-parse", "--verify", `refs/heads/${branch}`], projectDir);
    // The promotion record first: a head it published is in the trunk whatever
    // the git shape; commits after the newest promoted head it extends are not.
    const promoted = tip !== null && published.some((source) => isAncestor(git, tip, source, projectDir));
    const extended = tip !== null && !promoted
      ? published.filter((source) => isAncestor(git, source, tip, projectDir)) : [];
    const ahead = promoted ? 0
      : extended.length > 0 ? Math.min(...extended.map((source) => count(branch, [source, trunkRef])))
        : trunkRef ? count(branch, [trunkRef]) : NaN;
    const identical = trunkRef
      ? tryGit(git, ["diff", "--quiet", trunkRef, branch], projectDir) !== null
      : false;
    /** @type {SessionTree["status"]} */
    const status = branch === activeBranch ? "active"
      : (promoted || identical || ahead === 0) ? "integrated" : "unmerged";
    const ids = [...new Set([kept?.sessionId, kept?.remoteSessionId, ...sessionIdsFor(branch)].filter(Boolean))];
    return {
      branch,
      tip,
      status,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      keptUp: Boolean(kept),
      repository: kept?.repository || null,
      keptAt: kept?.keptAt || null,
      recoveryRefs: recovery.filter((ref) => ids.some((id) => ref.endsWith(`/${id}`))),
    };
  });
}

/**
 * Remove one tree: its local branch, its kept GitHub repository and
 * credentials, its recovery refs and its registry entry. Never the live
 * session's branch, and never a tree holding work the trunk lacks unless
 * forced.
 *
 * @param {string} projectDir
 * @param {string} branch
 * @param {{ trunkRef: string, activeBranch?: string|null, force?: boolean,
 *   git?: (args: string[], cwd: string) => string, sessionIdsFor?: (branch: string) => string[],
 *   deleteRepository?: (repository: string) => { ok: boolean, absent?: boolean, message?: string },
 *   removeCredentials?: (directory: string) => unknown }} options
 */
export function purgeSessionTree(projectDir, branch, {
  trunkRef, activeBranch = null, force = false, git = defaultGit, sessionIdsFor = () => [],
  deleteRepository = () => ({ ok: true }), removeCredentials = () => false,
}) {
  const name = String(branch || "");
  if (!name.startsWith(PAIR_BRANCH_PREFIX)) {
    return { ok: false, reason: "not_a_session_tree", message: `${name || "(none)"} is not a session tree (posse/pair-*)` };
  }
  if (name === activeBranch) {
    return { ok: false, reason: "active_session", message: `${name} is the live session's branch; close the session first` };
  }
  const tree = listSessionTrees(projectDir, { trunkRef, activeBranch, git, sessionIdsFor }).find((candidate) => candidate.branch === name);
  const kept = readKeptTrees(projectDir).find((candidate) => candidate.branch === name) || null;
  if (!tree && !kept) return { ok: false, reason: "unknown_tree", message: `No session tree named ${name}` };
  if (tree?.status === "unmerged" && !force) {
    return {
      ok: false,
      reason: "unmerged_work",
      message: `${name} holds ${tree.ahead} commit(s) the trunk does not; purge it with --force only if that work is not needed`,
    };
  }
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const problems = [];
  if (kept?.repository) {
    const outcome = deleteRepository(kept.repository);
    if (outcome?.ok) removed.push(`GitHub repository ${kept.repository}${outcome.absent ? " (already gone)" : ""}`);
    else problems.push(`could not delete ${kept.repository}: ${outcome?.message || "unknown error"} (gh repo delete ${kept.repository} --yes)`);
  }
  if (kept?.credentialDirectory) {
    try {
      if (removeCredentials(kept.credentialDirectory)) removed.push("session credentials");
    } catch (error) {
      problems.push(`could not remove the session credentials: ${error?.message || error}`);
    }
  }
  if (tree) {
    for (const ref of tree.recoveryRefs) {
      if (tryGit(git, ["update-ref", "-d", ref], projectDir) !== null) removed.push(`ref ${ref}`);
    }
    if (tryGit(git, ["branch", "-D", name], projectDir) !== null) removed.push(`branch ${name}`);
    else problems.push(`could not delete the local branch ${name}`);
  }
  // A repository we failed to delete stays registered so the purge can be retried.
  if (!problems.some((problem) => problem.startsWith("could not delete ") && kept?.repository && problem.includes(kept.repository))) {
    forgetKeptTree(projectDir, name);
  }
  return { ok: problems.length === 0, removed, problems, branch: name };
}
