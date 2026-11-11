import fs from "node:fs";
import path from "node:path";
import { gitExecAsync } from "./utils.js";

async function assertRecoverableIndex(cwd, files, trees) {
  let conflicts = new Set(files);
  for (const tree of trees.filter(Boolean)) {
    if (!conflicts.size) return;
    const changed = new Set(String(await gitExecAsync([
      "diff", "--cached", "--relative", "--name-only", "--no-ext-diff", "--no-renames", "-z", tree,
      "--", ...[...conflicts].map(file => `:(literal)${file}`),
    ], cwd, { trim: false })).split("\0"));
    conflicts = new Set([...conflicts].filter(file => changed.has(file)));
  }
  if (conflicts.size) throw new Error(`Recovery snapshot conflicts with newer staged work: ${[...conflicts].join(", ")}`);
}

// Caller holds the worktree lock and has checked live writer conflicts.
// Restore only exact, authorized paths whose current bytes still match the
// snapshot's base (or already match its result). Never apply a whole stash.
// Scope is relative to cwd, the project directory, which is a subdirectory of
// the repository when the project is nested; --relative and `:./` keep the
// paths Git reports and resolves in that same form.
export async function restoreScopedSnapshotAsync(cwd, snapshot, scope) {
  const literal = file => `:(literal)${file}`;
  const parents = String(await gitExecAsync(["show", "-s", "--format=%P", snapshot], cwd)).trim().split(/\s+/);
  if (!parents[0]) throw new Error("Recovery snapshot has no base commit");
  const tracked = String(await gitExecAsync([
    "diff", "--relative", "--name-only", "--no-renames", "-z", parents[0], snapshot,
  ], cwd, { trim: false })).split("\0").filter(file => file && scope.contains(file));
  const untracked = parents[2] ? String(await gitExecAsync([
    "ls-tree", "-rz", "--name-only", parents[2],
  ], cwd, { trim: false })).split("\0").filter(file => file && scope.contains(file)) : [];
  // A working copy may match the base/result while its index holds a newer
  // edit. Validate staging before even treating an already-restored path as
  // safe: finalization will stage these paths and would erase that edit.
  await assertRecoverableIndex(cwd, tracked, [parents[0], parents[1], snapshot]);
  await assertRecoverableIndex(cwd, untracked, [parents[0], parents[2]]);
  const restoreTracked = [];
  const restoreUntracked = [];
  for (const file of tracked) {
    const currentDiff = String(await gitExecAsync(["diff", "--no-ext-diff", snapshot, "--", literal(file)], cwd));
    if (!currentDiff) continue;
    const baseDiff = String(await gitExecAsync(["diff", "--no-ext-diff", parents[0], "--", literal(file)], cwd));
    if (baseDiff) throw new Error(`Recovery snapshot conflicts with newer work: ${file}`);
    // git diff omits untracked replacements of deleted/added paths.
    const baseEntry = String(await gitExecAsync(["ls-tree", parents[0], "--", file], cwd));
    if (!baseEntry && fs.existsSync(path.join(cwd, file))) {
      throw new Error(`Recovery snapshot would overwrite an untracked file: ${file}`);
    }
    restoreTracked.push(file);
  }
  for (const file of untracked) {
    if (fs.existsSync(path.join(cwd, file))) {
      const stat = fs.lstatSync(path.join(cwd, file));
      if (!stat.isFile()) throw new Error(`Recovery snapshot conflicts with existing path: ${file}`);
      const current = String(await gitExecAsync(["hash-object", "--no-filters", "--", file], cwd)).trim();
      const saved = String(await gitExecAsync(["rev-parse", `${parents[2]}:./${file}`], cwd)).trim();
      if (current !== saved) throw new Error(`Recovery snapshot conflicts with newer work: ${file}`);
    } else restoreUntracked.push(file);
  }
  let patch = "";
  if (restoreTracked.length) patch += await gitExecAsync([
    "diff", "--binary", "--no-ext-diff", "--no-renames", parents[0], snapshot, "--", ...restoreTracked.map(literal),
  ], cwd, { trim: false });
  if (restoreUntracked.length) {
    const emptyTree = String(await gitExecAsync(["hash-object", "-w", "-t", "tree", "--stdin"], cwd, { input: "" })).trim();
    patch += await gitExecAsync([
      "diff", "--binary", "--no-ext-diff", emptyTree, parents[2], "--", ...restoreUntracked.map(literal),
    ], cwd, { trim: false });
  }
  if (patch) {
    await gitExecAsync(["apply", "--check", "-"], cwd, { input: patch });
    await gitExecAsync(["apply", "-"], cwd, { input: patch });
  }
  return [...restoreTracked, ...restoreUntracked];
}
