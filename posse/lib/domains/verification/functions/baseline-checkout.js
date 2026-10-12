import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASELINE_CHECKOUT_PREFIX } from "../../../catalog/verification.js";
import { gitExecAsync } from "../../git/functions/utils.js";

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
