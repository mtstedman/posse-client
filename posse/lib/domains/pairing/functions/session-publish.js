// In-session merge and deploy: the shared trunk squashed into the host's real
// branch, and that branch pushed to origin, while the session keeps running.
// Design: docs/posse/plans/in-flight/2026-10-03-session-merge-deploy-plan.md.
//
// This module is the git core shared by merge, deploy and close-after-merge:
// it never touches a working tree, and every answer comes from git itself.
// Each squash commit names the trunk tip it contains in a trailer, so the next
// squash merges only what the trunk gained since then; without that base, a
// change the team made and later undid would come back.

import fs from "node:fs";
import path from "node:path";

import { adminGitExec, adminGitExecAsync, adminWorktreeRoot } from "../../git/functions/admin-git.js";
import { gitPushWithGitHubCliFallback } from "../../git/functions/git-push-auth.js";
import { runHookAsync } from "../../git/functions/hooks.js";
import { getSetting } from "../../queue/functions/index.js";
import { repairVerificationPrerequisites } from "../../verification/functions/prerequisite-adapters.js";

export const SESSION_TRAILER = "Posse-Session";
export const SESSION_TRUNK_TRAILER = "Posse-Session-Trunk";
// `git merge-tree --write-tree` arrived in 2.38 and `--merge-base` in 2.40.
export const SESSION_PUBLISH_MIN_GIT = Object.freeze([2, 40]);

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/u;
// Member-written names and subjects end up in commit messages and on the
// host's terminal; control characters and bidi overrides are dropped.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;
const MESSAGE_MAX_COMMITS = 50;
const SUMMARY_MAX_COMMITS = 20;
const SUMMARY_MAX_FILES = 25;

function publishError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function validSessionId(sessionId) {
  const id = String(sessionId || "");
  if (!SESSION_ID_RE.test(id)) throw publishError("session_publish_session_invalid", "Session id is missing or malformed");
  return id;
}

function cleanText(value) {
  return String(value || "").replace(UNSAFE_TEXT, "");
}

// Exit status 1 is an answer ("no", "conflict", "no match"); a call that was
// killed for running out of time also reports 1 and must stay an error.
function exitedWithOne(error) {
  return error?.status === 1 && !error?.killed && !error?.signal;
}

async function isAncestor(projectDir, ancestor, descendant, exec) {
  try {
    await exec(["merge-base", "--is-ancestor", ancestor, descendant], projectDir, { timeoutMs: 5 * 60_000 });
    return true;
  } catch (error) {
    if (exitedWithOne(error)) return false;
    throw error;
  }
}

/** True when this git can build squashes with an explicit merge base. */
export async function gitSupportsSessionPublish(projectDir, { exec = adminGitExecAsync } = {}) {
  const version = await exec(["version"], projectDir);
  const match = /(\d+)\.(\d+)/u.exec(String(version));
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [needMajor, needMinor] = SESSION_PUBLISH_MIN_GIT;
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

const FIELD = "\x1f";
const RECORD = "\x00";

function trailerValues(text) {
  return String(text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

// Squash commits are recognised by their trailers, which git parses from the
// message's last paragraph only. Posse writes that paragraph; the member
// subjects quoted above it can never pass for a trailer.
// The user's git config must not change what a lookup finds: grep.patternType
// could make the anchored pattern a fixed string, and trailer.separators could
// stop "Key: value" parsing as a trailer.
const PINNED_LOG_CONFIG = Object.freeze(["-c", "grep.patternType=basic", "-c", "trailer.separators=:"]);

function squashGrep(sessionId) {
  return ["--basic-regexp", `--grep=^${SESSION_TRAILER}: ${sessionId}$`];
}

function squashLogFormat() {
  return `--format=%H${"%x1f"}%(trailers:key=${SESSION_TRAILER},valueonly)${"%x1f"}`
    + `%(trailers:key=${SESSION_TRUNK_TRAILER},valueonly)${"%x00"}`;
}

function parseSquashRecords(out, sessionId) {
  const squashes = [];
  for (const record of String(out || "").split(RECORD)) {
    const [commit = "", sessions = "", trunks = ""] = record.split(FIELD);
    const sha = commit.trim();
    if (!SHA_RE.test(sha)) continue;
    const sessionValues = trailerValues(sessions);
    const trunkValues = trailerValues(trunks);
    if (sessionValues.length !== 1 || sessionValues[0] !== sessionId) continue;
    if (trunkValues.length !== 1 || !SHA_RE.test(trunkValues[0])) continue;
    squashes.push({ commit: sha, trunk: trunkValues[0] });
  }
  return squashes;
}

// A long session merges many times; this bounds one lookup's argv.
const SQUASH_LOOKUP_MAX = 500;

/**
 * The newest squash commit of this session reachable from `ref`, with the
 * trunk tip it contains, or null when the session has not merged into `ref`.
 * "Newest" is the squash whose trunk contains every other one's (the trunk
 * only moves forward), never commit dates, which members' clocks can skew.
 */
export async function findSessionSquash(projectDir, ref, sessionId, { exec = adminGitExecAsync, since = null } = {}) {
  const id = validSessionId(sessionId);
  // Squashes always descend from the session's starting commit; stopping
  // there keeps the walk short in a long-lived repository.
  const bound = SHA_RE.test(String(since || "")) ? [`^${since}`] : [];
  const out = await exec([
    ...PINNED_LOG_CONFIG, "log", ref, ...bound, "-n", String(SQUASH_LOOKUP_MAX), ...squashGrep(id), squashLogFormat(),
  ], projectDir, { trim: false, timeoutMs: 5 * 60_000 });
  const squashes = parseSquashRecords(out, id);
  if (squashes.length <= 1) return squashes[0] || null;
  const trunks = [...new Set(squashes.map((squash) => squash.trunk))];
  if (trunks.length === 1) return squashes[0];
  const independent = String(await exec(["merge-base", "--independent", ...trunks], projectDir))
    .split(/\s+/u).filter((value) => SHA_RE.test(value));
  if (independent.length !== 1) {
    throw publishError("session_publish_base_ambiguous",
      `${ref} holds this session's merges of trunks that are not one line of history; merge refused`);
  }
  return squashes.find((squash) => squash.trunk === independent[0]);
}

/**
 * Commits in `from..to` that are not squash commits of this session. Empty
 * means `to` is ahead of `from` only by work this feature made.
 */
export async function foreignCommitsBetween(projectDir, from, to, sessionId, { exec = adminGitExecAsync } = {}) {
  const id = validSessionId(sessionId);
  const all = String(await exec(["rev-list", `${from}..${to}`], projectDir))
    .split(/\s+/u).filter((value) => SHA_RE.test(value));
  if (all.length === 0) return [];
  const own = new Set(parseSquashRecords(await exec([
    ...PINNED_LOG_CONFIG, "log", `${from}..${to}`, ...squashGrep(id), squashLogFormat(),
  ], projectDir, { trim: false, timeoutMs: 5 * 60_000 }), id).map((squash) => squash.commit));
  return all.filter((commit) => !own.has(commit));
}

/**
 * Where a squash lands, given the host's local target and origin's tip:
 * - equal, or local behind (it fast-forwards): onto origin;
 * - local ahead only by this session's squashes (merged, not deployed): onto
 *   local, so a deploy carries them;
 * - diverged, local's extra commits only this session's squashes (origin
 *   moved under an undeployed merge): onto origin; the squash is rebuilt
 *   there and replaces local's;
 * - anything else (the host's own commits on the target): refused.
 */
export async function planSessionOnto(projectDir, {
  localSha, originSha, sessionId, targetBranch, exec = adminGitExecAsync,
}) {
  if (!SHA_RE.test(String(originSha || ""))) {
    throw publishError("session_publish_origin_missing", `Origin has no ${targetBranch} to merge into`);
  }
  if (!localSha || localSha === originSha) {
    return { onto: originSha, relation: localSha ? "equal" : "missing", undeployed: 0 };
  }
  if (await isAncestor(projectDir, localSha, originSha, exec)) {
    return { onto: originSha, relation: "behind", undeployed: 0 };
  }
  const extra = String(await exec(["rev-list", "--count", `${originSha}..${localSha}`], projectDir)).trim();
  const foreign = await foreignCommitsBetween(projectDir, originSha, localSha, sessionId, { exec });
  if (foreign.length > 0) {
    throw publishError("session_publish_target_foreign",
      `Local ${targetBranch} has ${foreign.length} commit(s) of its own that origin lacks (${foreign[0].slice(0, 8)}). `
        + `Push them or move them to another branch (git branch my-work ${targetBranch}), then try again`,
      { foreign });
  }
  const undeployed = Number(extra) || 0;
  if (await isAncestor(projectDir, originSha, localSha, exec)) {
    return { onto: localSha, relation: "ahead", undeployed };
  }
  return { onto: originSha, relation: "diverged", undeployed, replaces: localSha };
}

/**
 * The merge base for squashing `trunk` onto `onto`: the trunk tip named by the
 * newest squash of this session reachable from `onto`, else the commit the
 * session started from. It must be an ancestor of `trunk`.
 */
export async function resolveSessionSquashBase(projectDir, {
  onto, trunk, sessionId, originalHead, exec = adminGitExecAsync,
}) {
  const previous = await findSessionSquash(projectDir, onto, sessionId, { exec, since: originalHead });
  const base = previous?.trunk || originalHead;
  if (!SHA_RE.test(String(base || ""))) {
    throw publishError("session_publish_base_unknown", "The session has no recorded starting commit to merge from");
  }
  if (!(await isAncestor(projectDir, base, trunk, exec))) {
    throw publishError("session_publish_base_invalid",
      `The trunk no longer contains ${base.slice(0, 8)}, the point it was last merged from; merge refused`);
  }
  return { base, previous };
}

async function sessionCommitsSince(projectDir, base, trunk, exec) {
  const out = await exec(["log", "--no-merges", "--format=%h%x1f%an%x1f%s", `${base}..${trunk}`], projectDir, { trim: false });
  return String(out || "").split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    const [sha = "", author = "", subject = ""] = line.split("\x1f");
    return { sha, author: cleanText(author), subject: cleanText(subject) };
  });
}

/** The session's commits in `from..to` on the trunk, oldest last. */
export async function sessionCommitsBetween(projectDir, from, to, { exec = adminGitExecAsync } = {}) {
  return sessionCommitsSince(projectDir, from, to, exec);
}

async function signsCommits(projectDir, exec) {
  try {
    return String(await exec(["config", "--bool", "commit.gpgSign"], projectDir)).trim() === "true";
  } catch {
    return false;
  }
}

function squashMessage({ sessionId, trunk, commits }) {
  const authors = [...new Set(commits.map((commit) => commit.author).filter(Boolean))];
  const lines = [
    `Merge pairing session work (${commits.length} commit${commits.length === 1 ? "" : "s"}${authors.length ? ` by ${authors.join(", ")}` : ""})`,
    "",
    ...commits.slice(0, MESSAGE_MAX_COMMITS).map((commit) => `- ${commit.subject} (${commit.author})`),
    ...(commits.length > MESSAGE_MAX_COMMITS ? [`- ... and ${commits.length - MESSAGE_MAX_COMMITS} more`] : []),
    "",
    `${SESSION_TRAILER}: ${sessionId}`,
    `${SESSION_TRUNK_TRAILER}: ${trunk}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Builds the squash of `trunk` onto `onto` from `base`, without a working
 * tree. Returns `{ empty: true }` when it would change nothing, throws
 * `session_publish_conflict` (with `paths`) on conflicts, and otherwise
 * returns the new commit and what it contains.
 */
export async function buildSessionSquash(projectDir, {
  onto, trunk, base, sessionId, exec = adminGitExecAsync,
}) {
  const id = validSessionId(sessionId);
  for (const [name, value] of Object.entries({ onto, trunk, base })) {
    if (!SHA_RE.test(String(value || ""))) throw publishError("session_publish_input_invalid", `${name} must be a full commit id`);
  }
  let tree;
  try {
    const out = await exec(["merge-tree", "--write-tree", "--name-only", `--merge-base=${base}`, onto, trunk],
      projectDir, { timeoutMs: 15 * 60_000 });
    tree = String(out).split(/\r?\n/u)[0].trim();
  } catch (error) {
    if (exitedWithOne(error)) {
      // Exit 1 is a conflict: the first line is the (conflicted) tree, then the
      // conflicted paths, then a blank line and git's messages.
      const lines = String(error.stdout || "").split(/\r?\n/u);
      const blank = lines.indexOf("", 1);
      const paths = lines.slice(1, blank === -1 ? undefined : blank).filter(Boolean);
      throw publishError("session_publish_conflict",
        `The session's work conflicts with ${onto.slice(0, 8)} in ${paths.length} file(s): ${paths.slice(0, 10).join(", ")}`,
        { paths });
    }
    throw error;
  }
  const ontoTree = await exec(["rev-parse", `${onto}^{tree}`], projectDir);
  if (tree === String(ontoTree).trim()) return { empty: true, onto, trunk, base };
  const commits = await sessionCommitsSince(projectDir, base, trunk, exec);
  const message = squashMessage({ sessionId: id, trunk, commits });
  // commit-tree ignores commit.gpgSign; a repository that signs its commits
  // (and may require it on origin) gets a signed squash, as close's commit is.
  const sign = await signsCommits(projectDir, exec) ? ["-S"] : [];
  const commit = String(await exec(["commit-tree", ...sign, tree, "-p", onto, "-F", "-"], projectDir, {
    input: message, timeoutMs: 5 * 60_000,
  })).trim();
  return { empty: false, commit, tree, onto, trunk, base, commits };
}

/**
 * What a squash (or a deploy of `from..to`) would publish, in the shape the
 * close approval printer takes.
 */
export async function describeSessionPublish(projectDir, {
  target, commits, from, to, exec = adminGitExecAsync,
}) {
  const stat = String(await exec(["diff", "--stat=120", from, to], projectDir, { trim: false }))
    .split(/\r?\n/u).filter((line) => line.trim());
  const changeSummary = stat.length > 0 ? stat.pop().trim() : "";
  const counts = new Map();
  for (const commit of commits) counts.set(commit.author, (counts.get(commit.author) || 0) + 1);
  return {
    target,
    strategy: "squash",
    commitCount: commits.length,
    commits: commits.slice(0, SUMMARY_MAX_COMMITS),
    authors: [...counts].map(([name, count]) => ({ name, count })),
    files: stat.slice(0, SUMMARY_MAX_FILES).map((line) => line.trim()),
    moreFiles: Math.max(0, stat.length - SUMMARY_MAX_FILES),
    changeSummary,
  };
}

function originGitArgs(sshCommand, args) {
  // During a session the repository's own core.sshCommand is the session's
  // deploy key; origin is reached with the host's own ssh, as close does.
  return ["-c", `core.sshCommand=${sshCommand || "ssh"}`, ...args];
}

/** Fetches origin's target with the host's credentials; returns its tip. */
export async function fetchSessionOrigin(projectDir, {
  remote, targetBranch, sshCommand, exec = adminGitExecAsync,
}) {
  const remoteRef = `refs/remotes/${remote}/${targetBranch}`;
  await exec(originGitArgs(sshCommand, [
    "fetch", "--no-tags", remote, `+refs/heads/${targetBranch}:${remoteRef}`,
  ]), projectDir, { timeoutMs: 10 * 60_000 });
  const sha = String(await exec(["rev-parse", "--verify", remoteRef], projectDir)).trim();
  if (!SHA_RE.test(sha)) throw publishError("session_publish_origin_missing", `Could not resolve ${remote}/${targetBranch}`);
  return sha;
}

/** The commit a local branch points at, or "" when it does not exist. */
export async function localBranchSha(projectDir, branch, { exec = adminGitExecAsync } = {}) {
  try {
    const sha = String(await exec(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], projectDir)).trim();
    return SHA_RE.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

/** Worktrees (this checkout included) that have `branch` checked out. */
export async function worktreesWithBranch(projectDir, branch, { exec = adminGitExecAsync } = {}) {
  const out = String(await exec(["worktree", "list", "--porcelain"], projectDir, { trim: false }));
  const found = [];
  let current = null;
  for (const line of out.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) found.push(current);
  }
  return found;
}

/**
 * Moves the local target to `next` only if it still points at `expected`
 * ("" for a branch that does not exist yet). A branch checked out anywhere is
 * never moved behind its working tree's back.
 */
export async function moveLocalTarget(projectDir, {
  targetBranch, next, expected, sessionId, exec = adminGitExecAsync,
}) {
  const checkedOut = await worktreesWithBranch(projectDir, targetBranch, { exec });
  if (checkedOut.length > 0) {
    throw publishError("session_publish_target_checked_out",
      `${targetBranch} is checked out in ${checkedOut[0]}; switch that checkout to another branch first`);
  }
  const replacing = Boolean(expected) && !(await isAncestor(projectDir, expected, next, exec));
  try {
    // An empty old value means "must not exist yet", in SHA-1 and SHA-256
    // repositories alike.
    await exec(["update-ref", "-m", "posse session merge", `refs/heads/${targetBranch}`, next, expected || ""], projectDir);
  } catch (error) {
    throw publishError("session_publish_target_moved",
      `Local ${targetBranch} moved while this ran; nothing was changed. Try again`, { cause: error });
  }
  if (replacing) {
    // Undeployed merges that origin moved under were replaced: keep the old tip.
    await exec(["update-ref", `refs/posse/session-merges/${validSessionId(sessionId)}`, expected], projectDir);
  }
}

const CONFLICT_MARKER_ARGS = Object.freeze(["-e", "^<<<<<<<", "-e", "^=======$", "-e", "^>>>>>>>"]);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function removeGateWorktree(projectDir, dir, exec) {
  try { await exec(["worktree", "remove", "--force", dir], projectDir); } catch { /* not registered */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

// A gate worktree left by a run that crashed is removed by the next run.
async function removeStaleGateWorktrees(projectDir, root, exec) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const name of entries) {
    const match = /^session-deploy-(\d+)$/u.exec(name);
    if (match && !processAlive(Number(match[1]))) await removeGateWorktree(projectDir, path.join(root, name), exec);
  }
  try { await exec(["worktree", "prune"], projectDir); } catch { /* best effort */ }
}

/**
 * The push gate for exactly what a deploy sends: conflict markers in the
 * candidate's tree, then the repository's pre-push gate (.env and secret
 * scans of origin..candidate, the risky-config check, and its verify command)
 * in a temporary detached checkout of the candidate whose dependencies are
 * linked from this checkout, as work-item checkouts get them.
 */
export async function validateSessionPushCandidate(projectDir, {
  candidate, originSha, exec = adminGitExecAsync, onProgress = () => {},
  runGate = (ctx) => runHookAsync("pre_push_gate", ctx),
  readVerifyCommand = defaultVerifyCommand,
  prepareDependencies = defaultPrepareDependencies,
}) {
  try {
    const out = String(await exec(["grep", "-l", "--basic-regexp", ...CONFLICT_MARKER_ARGS, candidate, "--", ".", ":(exclude).posse/**"],
      projectDir, { timeoutMs: 5 * 60_000 }));
    const files = out.split(/\r?\n/u).filter(Boolean).map((file) => file.replace(`${candidate}:`, ""));
    if (files.length > 0) return { ok: false, reason: "conflict_markers", files };
  } catch (error) {
    if (!exitedWithOne(error)) return { ok: false, reason: "marker_check_failed", output: String(error?.message || error).split("\n")[0] };
  }
  const root = adminWorktreeRoot(projectDir);
  await removeStaleGateWorktrees(projectDir, root, exec);
  const dir = path.join(root, `session-deploy-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  await removeGateWorktree(projectDir, dir, exec);
  await exec(["worktree", "add", "--detach", "--quiet", dir, candidate], projectDir, { timeoutMs: 10 * 60_000 });
  try {
    const verifyCommand = readVerifyCommand(dir);
    if (verifyCommand) {
      onProgress("Preparing the candidate's dependencies for the verify command");
      try {
        await prepareDependencies({ projectDir: dir, command: verifyCommand, onProgress });
      } catch { /* a verify command that needs them fails below and says why */ }
    }
    onProgress("Running the push gate on the candidate");
    const gate = await runGate({ cwd: dir, upstream: originSha });
    return gate?.ok ? { ok: true } : { ok: false, reason: "gate_failed", output: gate?.output || "" };
  } finally {
    await removeGateWorktree(projectDir, dir, exec);
  }
}

function defaultVerifyCommand(dir) {
  const read = (key, options) => {
    try {
      return String(getSetting(key, options) ?? "").trim();
    } catch {
      return "";
    }
  };
  return read("canonical_verify_cmd", { projectDir: dir }) || read("pre_push_verify_cmd", {});
}

async function defaultPrepareDependencies({ projectDir, command, onProgress }) {
  return repairVerificationPrerequisites({ projectDir, command, onProgress });
}

/**
 * Pushes `candidate` to origin's target as a plain fast-forward: no lease and
 * no force, so origin refuses anything that would drop someone else's
 * commits. Uses the host's own credentials (and GitHub CLI auth as close does).
 */
export function pushSessionCandidate(projectDir, {
  remote, targetBranch, candidate, sshCommand, push = gitPushWithGitHubCliFallback, gitExec = adminGitExec,
}) {
  push(originGitArgs(sshCommand, ["push", remote, `${candidate}:refs/heads/${targetBranch}`]), projectDir, {
    remote,
    gitExecFn: gitExec,
    fallbackGitExecFn: gitExec,
    gitOptions: { timeoutMs: 15 * 60_000 },
  });
}

export async function isSessionAncestor(projectDir, ancestor, descendant, { exec = adminGitExecAsync } = {}) {
  return isAncestor(projectDir, ancestor, descendant, exec);
}
