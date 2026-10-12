import { stashTargetBranchChangesAsync } from "../../git/functions/worktree-status.js";
import { firstGitLine } from "../../git/functions/workflow-git-utils.js";
import { ask } from "./input-prompts.js";

// Keep terminal input in the CLI: the guard also runs inside a Git worker.
export async function resolveStartupDirtyTreeBlock(result, {
  projectDir,
  guardStartupDirtyTree,
  nonInteractive = false,
  interactive = !!process.stdin.isTTY && !!process.stdout.isTTY,
  askFn = ask,
  stash = stashTargetBranchChangesAsync,
  write = console.log,
} = {}) {
  if (!result?.blocked || result.blockReason !== "uncommitted_changes"
    || nonInteractive || !interactive) return result;

  write(`\n  ${projectDir} has ${result.dirtyCount} uncommitted change(s).`);
  for (const line of (result.dirtyLines || []).slice(0, 10)) write(`    ${line}`);
  if (result.dirtyCount > 10) write(`    ... and ${result.dirtyCount - 10} more`);
  write("  Commit saves all current work; stash saves tracked and untracked work for later.");

  let choice;
  while (true) {
    choice = String(await askFn("  [c]ommit / [s]tash / [e]xit [exit]: ") || "").trim().toLowerCase();
    if (["", "e", "exit"].includes(choice)) {
      return { ...result, userExited: true, message: "Exited without changing your work." };
    }
    if (["c", "commit", "s", "stash"].includes(choice)) break;
    write("  Choose commit, stash, or exit.");
  }

  try {
    // Recheck after input: never stash a newly conflicted tree or bypass a
    // reserved-runtime-path block. Force block policy for the verification.
    const current = await guardStartupDirtyTree({ reason: "run start", policy: "block" });
    if (current.ok || current.blockReason !== "uncommitted_changes") return current;
    if (choice === "c" || choice === "commit") {
      return await guardStartupDirtyTree({ reason: "run start", policy: "commit" });
    }
    const saved = await stash({ projectDir, message: "posse: preserve startup work" });
    if (!saved.ok) return { ...current, message: saved.message };
    write(`  ${saved.message}`);
    return await guardStartupDirtyTree({ reason: "run start", policy: "block" });
  } catch (error) {
    return { ...result, message: `Could not save startup work: ${firstGitLine(error)}` };
  }
}
