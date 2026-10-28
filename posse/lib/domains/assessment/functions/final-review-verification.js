import { finalReviewIdentityEvidence } from "./final-review-authority.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gitExecAsync } from "../../git/functions/utils.js";
import { porcelain, porcelainChangedPaths, environmentFilesFingerprint } from "../../verification/functions/receipt-fingerprint.js";
import { describeToolchain, toolchainFingerprint } from "../../settings/functions/verification-policy.js";
import { effectiveVerificationPolicy } from "../../worker/functions/helpers/frozen-test-execution.js";

// Hash the effective source tree rather than HEAD or porcelain status: staging
// and committing identical bytes do not invalidate verification. Dirty sibling
// files are included, so changing test inputs cannot borrow the earlier run.
export async function finalReviewVerificationIdentity(cwd, { payload = null, commit = null } = {}) {
  try {
    if (payload) {
      const evidence = await finalReviewIdentityEvidence(cwd, payload, { commit });
      return createHash("sha256").update(JSON.stringify({
        scope: evidence.identity,
        environment: environmentFilesFingerprint(cwd),
        toolchain: toolchainFingerprint(describeToolchain({ projectDir: cwd })),
        policy: effectiveVerificationPolicy({ cwd }).fingerprint,
      })).digest("hex");
    }
    const index = String(await gitExecAsync(["ls-files", "--stage", "-z"], cwd, { trim: false }));
    const entries = new Map();
    for (const row of index.split("\0").filter(Boolean)) {
      const match = row.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
      if (!match || match[3] !== "0") return null;
      entries.set(match[4], [match[1], match[2]]);
    }
    const status = await porcelain(cwd);
    const algorithm = String(await gitExecAsync(["rev-parse", "--show-object-format"], cwd)).trim();
    for (const file of porcelainChangedPaths(status)) {
      const absolute = path.resolve(cwd, file);
      if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) return null;
      let stat;
      try { stat = await fs.lstat(absolute); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        entries.delete(file); continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) return null;
      const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(absolute)) : await fs.readFile(absolute);
      const object = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      entries.set(file, [stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644", object]);
    }
    const evidence = { files: [...entries].sort(([a], [b]) => a.localeCompare(b)),
      environment: environmentFilesFingerprint(cwd),
      toolchain: toolchainFingerprint(describeToolchain({ projectDir: cwd })),
      policy: effectiveVerificationPolicy({ cwd }).fingerprint };
    return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  } catch { return null; }
}
