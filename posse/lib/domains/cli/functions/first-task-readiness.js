import { spawnSync } from "node:child_process";
import { FIRST_TASK_READINESS as S, FIRST_TASK_ROLES, FIRST_TASK_WORKFLOW } from "../../../catalog/first-task-readiness.js";
import { getAvailableProviders, isProviderReady } from "../../providers/functions/provider.js";
import { discoverCheckCommands } from "../../verification/functions/check-command-discovery.js";

function inspectGit(projectDir) {
  const read = args => {
    const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 5000, windowsHide: true });
    return result.status === 0 ? String(result.stdout || "").trim() : null;
  };
  if (read(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return { state: S.BLOCKED, detail: "Choose the Git project you want Posse to work on.", next: "Open a terminal in that project." };
  }
  if (!read(["rev-parse", "--verify", "HEAD"])) {
    return { state: S.BLOCKED, detail: "The repository has no initial commit.", next: "Create the initial commit before worktree-based tasks." };
  }
  if (!read(["var", "GIT_AUTHOR_IDENT"]) || !read(["var", "GIT_COMMITTER_IDENT"])) {
    return { state: S.BLOCKED, detail: "Git author or committer identity is unavailable.", next: "Configure Git user.name and user.email for this project." };
  }
  return { state: S.READY, detail: "Git repository, initial commit, and commit identity are available." };
}

/** Local inspection only: no provider generation or repository test commands. */
export function collectFirstTaskReadiness({ projectDir, initialized, doctorResult, inspectRepository = inspectGit,
  availableProviders = getAvailableProviders, providerReady = isProviderReady, discoverChecks = discoverCheckCommands } = {}) {
  const repository = inspectRepository(projectDir);
  const runtime = !initialized || doctorResult?.status === "skipped" || doctorResult?.dry_run
    ? { state: S.NEEDS_ATTENTION, detail: "Runtime requirements have not been verified for this project.", next: "Initialize with posse add, then run posse doctor --first-task." }
    : !doctorResult?.ok || doctorResult?.credentials?.posse_key === "missing" || doctorResult?.doctor?.failed?.length || doctorResult?.doctor?.pending?.length
      ? { state: S.BLOCKED, detail: "Runtime requirements or the Posse access key need attention.", next: "Resolve the doctor report above and run posse doctor --first-task again." }
      : { state: S.READY, detail: "Doctor verified the project's dependency/runtime requirements." };
  const readiness = new Map();
  const providers = FIRST_TASK_ROLES.map(role => {
    try {
      const candidates = availableProviders(role);
      const ready = candidates.filter(provider => {
        if (!readiness.has(provider)) readiness.set(provider, providerReady(provider));
        return readiness.get(provider)?.ready;
      });
      return { role, state: ready.length ? S.READY : S.BLOCKED, providers: candidates,
        detail: ready.length ? `${role}: locally ready via ${ready.join(", ")}.` : `${role}: no configured provider is locally ready.`,
        ...(ready.length ? {} : { next: "Open posse admin to configure this role's provider and credentials." }) };
    } catch {
      return { role, state: S.NEEDS_ATTENTION, providers: [], detail: `${role}: provider readiness could not be inspected.`, next: "Open posse admin to inspect provider configuration." };
    }
  });
  let commands = [];
  try { commands = discoverChecks(projectDir); } catch { /* no readiness claim from failed discovery */ }
  const verification = commands.length
    ? { state: S.READY, detail: "Verification commands are declared; they have not been executed by this report.", commands }
    : { state: S.NEEDS_ATTENTION, detail: "No supported verification commands were found at this project root.", commands,
      next: "Identify the task's test command or manual acceptance steps in its plan; nested packages may declare their own commands." };
  const checks = [repository, runtime, ...providers, verification];
  const state = checks.some(check => check.state === S.BLOCKED) ? S.BLOCKED
    : checks.some(check => check.state === S.NEEDS_ATTENTION) ? S.NEEDS_ATTENTION : S.READY;
  return { state, repository, runtime, providers, verification,
    next_steps: [...new Set(checks.filter(check => check.state !== S.READY).map(check => check.next))],
    workflow: FIRST_TASK_WORKFLOW };
}

export { firstTaskReadinessLines } from "./first-task-report.js";
