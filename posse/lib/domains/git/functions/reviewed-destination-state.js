import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gitExecAsync } from "./utils.js";
import { exactReviewedPath } from "./reviewed-file-objects.js";

function fingerprint(paths) {
  const states = paths.map((file) => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      return [file, ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)];
    } catch (error) {
      return [file, error.code];
    }
  });
  return createHash("sha256").update(JSON.stringify(states)).digest("hex");
}

// This is only a cache invalidator, never evidence that an import is safe.
// Resolve Git paths when setup blocks, so admission polls need only scoped
// filesystem metadata reads, with no subprocess or content hashing in SQLite.
export async function captureReviewedDestination(cwd, transfer, options = {}) {
  const entries = [...transfer.files, ...transfer.read_inputs];
  if (entries.some((file) => !exactReviewedPath(file.path))) return null;
  const gitDir = String(await gitExecAsync(["rev-parse", "--absolute-git-dir"], cwd, options)).trim();
  const commonDir = path.resolve(cwd, String(await gitExecAsync(["rev-parse", "--git-common-dir"], cwd, options)).trim());
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  const ref = head.startsWith("ref: ") ? head.slice(5) : null;
  const paths = [...new Set([
    ...entries.map((file) => path.resolve(cwd, file.path)),
    ...["HEAD", "index", "MERGE_HEAD", "commondir"].map((name) => path.join(gitDir, name)),
    path.join(commonDir, "packed-refs"), path.join(commonDir, "reftable", "tables.list"),
    ...(ref && exactReviewedPath(ref) ? [path.join(commonDir, ref)] : []),
  ])];
  return { paths, fingerprint: fingerprint(paths) };
}

export function reviewedDestinationChanged(snapshot) {
  if (!snapshot?.fingerprint || !Array.isArray(snapshot.paths)
      || snapshot.paths.some((file) => typeof file !== "string" || !path.isAbsolute(file))) return false;
  return fingerprint(snapshot.paths) !== snapshot.fingerprint;
}
