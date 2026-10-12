import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASELINE_CHECKOUT_PREFIX, VERIFICATION_ENVIRONMENT_FILES } from "../../../catalog/verification.js";
import { gitExecAsync } from "../../git/functions/utils.js";

async function copyIgnoredEnvironmentFiles(cwd, checkout) {
  const ignored = new Set(String(await gitExecAsync([
    "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...VERIFICATION_ENVIRONMENT_FILES,
  ], cwd)).split("\0"));
  const tracked = new Set(String(await gitExecAsync([
    "ls-files", "-z", "--", ...VERIFICATION_ENVIRONMENT_FILES,
  ], checkout)).split("\0"));
  for (const name of VERIFICATION_ENVIRONMENT_FILES) {
    if (!ignored.has(name) || tracked.has(name)) continue;
    const source = path.join(cwd, name);
    const stat = await fs.promises.lstat(source);
    // Copy regular files, never link tests back to mutable sibling state.
    if (stat.isFile()) await fs.promises.copyFile(source, path.join(checkout, name));
  }
}

// A baseline is the identified pre-development commit, even while siblings
// are writing in the shared worktree. Never hide, remove, or restore their
// files to manufacture a clean source tree.
export async function withBaselineCheckout({ cwd, commit, run }) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), BASELINE_CHECKOUT_PREFIX));
  const checkout = path.join(root, "candidate");
  let added = false;
  try {
    await gitExecAsync(["worktree", "add", "--detach", checkout, commit], cwd);
    added = true;
    // Receipts compare ignored environment files as well as tracked source.
    // A detached checkout must see the same environment without importing dirt.
    await copyIgnoredEnvironmentFiles(cwd, checkout);
    return await run(checkout, async () => {
      await gitExecAsync(["reset", "--hard", commit], checkout);
      await gitExecAsync(["clean", "-fd"], checkout);
    });
  } finally {
    try {
      if (added) await gitExecAsync(["worktree", "remove", "--force", checkout], cwd);
    } finally {
      // Do not remove an attached worktree if unregistering it failed.
      if (!fs.existsSync(path.join(checkout, ".git"))) await fs.promises.rm(root, { recursive: true, force: true });
    }
  }
}
