import { gitExecAsync } from "./utils.js";

// Paths in receipts are project-relative; Git object paths are repository-
// relative. Preserve both, including for a nested package worktree.
export function exactReviewedPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\")
    && !value.includes("\0") && !value.startsWith(":") && !/^[A-Za-z]:/.test(value)
    && !value.split("/").some((part) => !part || part === "." || part === "..");
}

export async function reviewedFileObject(cwd, revision, repoPath, { signal = null } = {}) {
  if (!/^[a-f0-9]{40,64}$/.test(revision) || !exactReviewedPath(repoPath)) throw new Error("Invalid pinned file identity");
  // Check the commit separately: a missing object is never a deletion.
  await gitExecAsync(["cat-file", "-e", `${revision}^{commit}`], cwd, { signal });
  const output = String(await gitExecAsync(["ls-tree", "--full-name", "-z", revision, "--", `:(top,literal)${repoPath}`], cwd, { signal, trim: false }));
  return parseReviewedTreeObject(output, repoPath);
}

export function parseReviewedTreeObject(output, repoPath) {
  if (!output) return null;
  const entries = output.split("\0").filter(Boolean);
  if (entries.length !== 1) throw new Error("Reviewed path is not an exact file");
  const match = /^(\d+) (blob|commit|tree) ([a-f0-9]+)\t([\s\S]+)$/.exec(entries[0]);
  if (!match || match[2] !== "blob" || match[4] !== repoPath || !["100644", "100755", "120000"].includes(match[1])) {
    throw new Error("Unsupported reviewed file object");
  }
  return { oid: match[3], mode: match[1] };
}

export function sameReviewedObject(left, right) {
  return left == null ? right == null : left.oid === right?.oid && left.mode === right?.mode;
}
