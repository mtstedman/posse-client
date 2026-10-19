import { adminGitExecAsync } from "../../git/functions/admin-git.js";
import { GIT_OPERATION_TIMEOUT_MS, gitExecAsync, isGitCommandFailure } from "../../git/functions/utils.js";
import { ensureRestrictivePushRefspecsAsync, remotePushConfigsAreClearlyRestrictive } from "../../git/functions/push-guard.js";
import {
  ensurePosseRuntimeIgnoresAsync,
  stagePosseRuntimeGitignoreForInitialCommit,
} from "../../runtime/functions/ignore.js";
import { C } from "../../../shared/format/functions/colors.js";

function firstProbeErrorLine(error) {
  return String(error?.stderr || error?.message || error || "unknown")
    .split(/\r?\n/)
    .find((line) => line.trim()) || "unknown";
}

export function assertGitIdentityChecks(nameCheck, emailCheck) {
  for (const [label, check] of [["user.name", nameCheck], ["user.email", emailCheck]]) {
    if (check?.ok) continue;
    const error = new Error(`git ${label} probe failed: ${firstProbeErrorLine(check?.error)}`);
    error.code = "POSSE_GIT_IDENTITY_PROBE_FAILED";
    throw error;
  }

  if (!String(nameCheck?.stdout || "").trim() || !String(emailCheck?.stdout || "").trim()) {
    const error = new Error('git user identity not configured. Posse needs this to commit changes in worktrees. Run: git config user.name "Your Name" && git config user.email "you@example.com"');
    error.code = "POSSE_GIT_IDENTITY_NOT_CONFIGURED";
    throw error;
  }
}

export const BOOT_GIT_PROBE_TIMEOUT_MS = GIT_OPERATION_TIMEOUT_MS;
const BOOT_PUSH_GUARD_TIMEOUT_MS = 2_500;

function firstGitErrorLine(err) {
  return String(err?.stderr || err?.message || err || "unknown")
    .split(/\r?\n/)
    .find((line) => line.trim()) || "unknown";
}

export function createGitReadiness({ projectDir, command, nonInteractive, ask }) {
  async function ensureGitRepositoryInitialized({ verbose = false } = {}) {
    // Repository bootstrap runs for intake/admin commands that do not own native
    // Git readiness, so it uses the direct system-Git adapter: a fresh or
    // unauthenticated checkout must still be able to create its repository.
    try {
      await adminGitExecAsync(["rev-parse", "--git-dir"], projectDir, {
        timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 128,
      });
      return { initialized: false };
    } catch (err) {
      // Only git itself saying "not a repository" may trigger init. A probe
      // that could not run (git missing, timeout) must not re-initialize an
      // existing repo; the admin adapter marks those as command failures too.
      if (!isGitCommandFailure(err) || err?.killed === true || typeof err?.syscall === "string") {
        throw new Error(`git availability probe failed (not a missing repo): ${firstGitErrorLine(err)}`);
      }
      // First run in a fresh directory: create the local repository before
      // writing Posse runtime files so ignore rules can be staged for HEAD.
    }

    if (verbose) {
      console.log(`\n  ${C.yellow}${projectDir} is not a git repository — initializing one.${C.reset}`);
    }
    try {
      await adminGitExecAsync(["init"], projectDir, {
        timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      throw new Error(`failed to git init: ${firstGitErrorLine(err)}`);
    }
    if (verbose) {
      console.log(`  ${C.green}Initialized git repo.${C.reset}`);
    }
    return { initialized: true };
  }

  async function assertGitRepositoryExists() {
    try {
      await adminGitExecAsync(["rev-parse", "--git-dir"], projectDir, {
        timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 128,
      });
    } catch (err) {
      throw new Error(`Git repository required for ${projectDir}; only posse add or posse go initializes one: ${firstGitErrorLine(err)}`);
    }
  }

  async function ensureSnapshotPushRefsGuarded({ verbose = false, timeoutMs = BOOT_PUSH_GUARD_TIMEOUT_MS } = {}) {
    if (await remotePushConfigsAreClearlyRestrictive(projectDir, {
      timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
      gitExecAsyncFn: adminGitExecAsync,
    })) {
      return;
    }
    try {
      const changed = await ensureRestrictivePushRefspecsAsync(projectDir, {
        timeoutMs,
        bypassNativeBridge: true,
      });
      if (verbose && changed.length > 0) {
        console.log(`  ${C.dim}Restricted git push refspecs to protect Posse recovery snapshots.${C.reset}`);
      }
    } catch (err) {
      if (verbose) {
        console.log(`  ${C.yellow}Could not verify git push refspec safety: ${err?.message || String(err)}${C.reset}`);
      }
    }
  }

  /**
   * Ensure the project directory is a git repo with at least one commit.
   * Worktrees require a valid HEAD to branch from. Throws with a clear message
   * if the repo is unusable, or auto-creates an initial commit if the repo
   * exists but is empty (no commits yet).
   *
   * Initializes a missing repo before probing HEAD and user identity. The HEAD
   * and identity checks still run in parallel so the boot spinner is not blocked
   * by serial git calls once repository presence is settled.
   */
  async function ensureGitReady() {
    const tryGit = async (args) => {
      try {
        const stdout = await gitExecAsync(args, projectDir, {
          timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        return { ok: true, stdout: String(stdout || "").trim() };
      } catch (err) {
        return { ok: false, error: err };
      }
    };

    const repoCheck = await tryGit(["rev-parse", "--git-dir"]);
    if (!repoCheck.ok) {
      if (command !== "go") {
        throw new Error(`Git repository required for ${projectDir}; only posse add or posse go initializes one: ${firstGitErrorLine(repoCheck.error)}`);
      }
      if (!isGitCommandFailure(repoCheck.error)) {
        throw new Error(`git availability probe failed (not a missing repo): ${firstGitErrorLine(repoCheck.error)}`);
      }
      const initCheck = await tryGit(["init"]);
      if (!initCheck.ok) {
        throw new Error(`could not initialize git repository: ${firstGitErrorLine(initCheck.error)}`);
      }
      await ensurePosseRuntimeIgnoresAsync(projectDir);
    }

    // rev-parse HEAD confirms HEAD exists. Run this in parallel with the
    // user.name / user.email probes.
    const [headCheck, nameCheck, emailCheck] = await Promise.all([
      tryGit(["rev-parse", "HEAD"]),
      tryGit(["config", "user.name"]),
      tryGit(["config", "user.email"]),
    ]);
    assertGitIdentityChecks(nameCheck, emailCheck);
    if (!headCheck.ok) {
      // Repo exists but has no commits — create an initial empty commit so HEAD is valid
      console.log(`\n  ${C.yellow}Git repo has no commits. Creating initial commit so worktrees can branch from HEAD...${C.reset}`);
      const git = async (args) => {
        const result = await tryGit(args);
        if (!result.ok) throw result.error;
        return result.stdout;
      };
      await stagePosseRuntimeGitignoreForInitialCommit(projectDir, { git, includeAppendedBlock: true });
      const commitResult = await tryGit([
        "commit",
        "--allow-empty",
        "-m",
        "chore: initial commit (posse bootstrap)",
      ]);
      if (!commitResult.ok) {
        throw new Error(`could not create initial commit: ${String(commitResult.error?.message || commitResult.error || "unknown").split("\n")[0]}`);
      }
      console.log(`  ${C.green}Initial commit created.${C.reset}\n`);
    }
    await ensureSnapshotPushRefsGuarded();
  }

  /**
   * First-run setup check. Auto-initializes a missing git repo and creates the
   * initial commit when HEAD is missing — no confirmation prompt, so `posse go`
   * works the first time in a fresh directory. Only missing user identity still
   * prompts (interactive) or aborts (non-interactive), since it can't be derived.
   * Returns true if the repo is ready to proceed, false to abort cmdRun.
   */
  async function ensureRepoSetupConfirmed() {
    // Async so the boot event loop isn't blocked on git between the interactive
    // prompts (the broader boot orchestration requires every task be off-loop).
    const runGit = async (args) => await adminGitExecAsync(args, projectDir, {
      timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    try {
      if (command === "go") await ensureGitRepositoryInitialized({ verbose: true });
      else await assertGitRepositoryExists();
      await ensurePosseRuntimeIgnoresAsync(projectDir);
      await stagePosseRuntimeGitignoreForInitialCommit(projectDir, { git: runGit });
    } catch (err) {
      console.error(`  ${C.red}${firstGitErrorLine(err)}${C.reset}\n`);
      return false;
    }

    const configValue = async (args) => {
      try { return (await runGit(args)).trim(); } catch { return ""; }
    };
    const readIdentity = async () => {
      const [name, email, globalName, globalEmail] = await Promise.all([
        configValue(["config", "user.name"]),
        configValue(["config", "user.email"]),
        configValue(["config", "--global", "user.name"]),
        configValue(["config", "--global", "user.email"]),
      ]);
      return { name, email, globalName, globalEmail };
    };
    let identity = await readIdentity();
    if (!identity.name || !identity.email) {
      const canPromptForIdentity = !nonInteractive && !!process.stdin?.isTTY && !!process.stdout?.isTTY;
      if (!canPromptForIdentity) {
        console.error(`\n  ${C.red}Git user identity not configured for ${projectDir}.${C.reset}`);
        console.error(`  Posse needs both user.name and user.email before it can create the initial commit.`);
        console.error(`  Run: git config --global user.name "Your Name" && git config --global user.email "you@example.com"\n`);
        return false;
      }
      console.log(`\n  ${C.yellow}Git user identity not configured for ${projectDir}.${C.reset}`);
      console.log(`  Posse commits changes in worktrees and needs a name + email.`);
      const nameDefault = identity.name || identity.globalName || "";
      const emailDefault = identity.email || identity.globalEmail || "";
      const nameIn = (await ask(`  Name${nameDefault ? ` [${nameDefault}]` : ""}: `)).trim() || nameDefault;
      if (!nameIn) { console.log(`  ${C.red}Aborted - name is required.${C.reset}\n`); return false; }
      const emailIn = (await ask(`  Email${emailDefault ? ` [${emailDefault}]` : ""}: `)).trim() || emailDefault;
      if (!emailIn) { console.log(`  ${C.red}Aborted - email is required.${C.reset}\n`); return false; }
      const scopeAns = (await ask(`  Save globally (so all repos use this)? [Y/n]: `)).trim().toLowerCase();
      const scopeArgs = (scopeAns === "n" || scopeAns === "no") ? [] : ["--global"];
      try {
        await runGit(["config", ...scopeArgs, "user.name", nameIn]);
        await runGit(["config", ...scopeArgs, "user.email", emailIn]);
        identity = await readIdentity();
        if (!identity.name || !identity.email) {
          throw new Error("git config did not return both user.name and user.email after saving");
        }
        console.log(`  ${C.green}Git identity saved and verified (${scopeArgs.length > 0 ? "global" : "local"}).${C.reset}`);
      } catch (err) {
        console.error(`  ${C.red}Failed to save git identity: ${err.message.split("\n")[0]}${C.reset}\n`);
        return false;
      }
    }

    let hasHead = true;
    try { await runGit(["rev-parse", "HEAD"]); } catch { hasHead = false; }
    if (!hasHead) {
      // Worktrees need a valid HEAD to branch from. ensureGitReady creates this
      // commit unconditionally later in boot, so make it automatic here too
      // instead of prompting.
      console.log(`\n  ${C.yellow}Repo has no commits yet — creating an initial commit so worktrees can branch from HEAD.${C.reset}`);
      try {
        await stagePosseRuntimeGitignoreForInitialCommit(projectDir, { git: runGit, includeAppendedBlock: true });
        await runGit(["commit", "--allow-empty", "-m", "chore: initial commit (posse bootstrap)"]);
        console.log(`  ${C.green}Initial commit created.${C.reset}\n`);
      } catch (err) {
        console.error(`  ${C.red}Failed to create initial commit: ${err.message.split("\n")[0]}${C.reset}\n`);
        return false;
      }
    }

    await ensureSnapshotPushRefsGuarded({ verbose: true });
    return true;
  }

  return {
    ensureGitRepositoryInitialized,
    assertGitRepositoryExists,
    ensureGitReady,
    ensureRepoSetupConfirmed,
  };
}
