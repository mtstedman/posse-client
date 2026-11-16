import fs from "node:fs";
import path from "node:path";
import { REPOSITORY_TEST_SCRIPT_RUNTIMES } from "../../../../catalog/process.js";
import { readRepositoryVerificationConfig } from "../../../../domains/verification/functions/verification-plan.js";
import { canonicalEvidenceSourcePath } from "../source-evidence.js";
import { parseCommandArguments } from "../../../scope/functions/test-command.js";

export function pythonExecutable() {
  const managed = String(process.env.POSSE_PROJECT_PYTHON || "").trim();
  if (managed && path.isAbsolute(managed) && fs.existsSync(managed)) return managed;
  return "python3";
}

function validRunnerDeclaration(runner) {
  const { files, runtime, script, args = [] } = runner || {};
  return !(!Array.isArray(files) || files.length === 0
      || files.some((file) => typeof file !== "string" || !canonicalEvidenceSourcePath(file))
      || !Object.hasOwn(REPOSITORY_TEST_SCRIPT_RUNTIMES, runtime)
      || typeof script !== "string" || !canonicalEvidenceSourcePath(script)
      || script.startsWith("-") || !new RegExp(`\\${REPOSITORY_TEST_SCRIPT_RUNTIMES[runtime]}$`).test(script)
      || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0")));
}

// Repository declarations supply coverage; never infer it from a script name
// or the fact that a different suite passed. Execute a fixed script argv with
// the same environment and timeout boundary as built-in test adapters.
export function repositoryTestRunner(root, testPath, config = readRepositoryVerificationConfig(root)) {
  if (!config) return null;
  if (config.error) return { reason: config.error };
  const runners = config.unit_test_runners;
  if (runners == null) return null;
  if (!Array.isArray(runners)) return { reason: "repository_test_runners_invalid" };
  const matches = [];
  for (const runner of runners) {
    if (!validRunnerDeclaration(runner)) return { reason: "repository_test_runners_invalid" };
    const { files } = runner;
    if (!files.some((file) => path.matchesGlob(testPath, file))) continue;
    const invocation = resolveRepositoryRunner(root, runner);
    if (!invocation.runner) return invocation;
    matches.push(invocation);
  }
  if (matches.length > 1) return { reason: "repository_test_runner_ambiguous" };
  return matches[0] || null;
}

function resolveRepositoryRunner(root, { runtime, script, args = [] }) {
  let realScript;
  try { realScript = fs.realpathSync(path.resolve(root, script)); } catch {
    return { reason: "repository_test_script_missing" };
  }
  if (!canonicalEvidenceSourcePath(path.relative(fs.realpathSync(root), realScript))) {
    return { reason: "repository_test_script_outside_root" };
  }
  return { runner: "repository_script", executable: runtime === "node" ? process.execPath
    : runtime === "python" ? pythonExecutable() : runtime, args: [script, ...args] };
}

function frozenRepositoryInvocation(validation, invocation) {
  // Direct-spawn argv encoding, never a shell command.
  const quote = (arg) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return { ...validation, execution_command: [invocation.executable, ...invocation.args].map(quote).join(" "),
    cwd_relative: null, repository_validated: true, repository_runner: true };
}

// An explicit single-file invocation must use the same repository bootstrap
// as path-only changed-test verification. Freeze the resolved argv before
// development; never reinterpret a stored command after the repository edits.
export function declaredNodeTestCommand(root, validation) {
  if (!validation?.ok) return validation;
  if (!root) return validation.repository_runner_required
    ? { ok: false, reason: "repository_test_runner_not_declared" } : validation;
  let words;
  try { words = parseCommandArguments(validation.execution_command); } catch { return validation; }
  if (!["node", "node.exe"].includes(path.basename(words[0]).toLowerCase())) return validation;
  const args = words.slice(1);
  if (args[0] === "--test") args.shift();
  if (validation.repository_runner_required) {
    const config = readRepositoryVerificationConfig(root);
    if (!config || config.error) return { ok: false, reason: config?.error || "repository_test_runner_not_declared" };
    const script = path.relative(root, path.resolve(root, validation.cwd_relative || ".", args[0])).replace(/\\/g, "/");
    const declarations = config.unit_test_runners;
    if (!Array.isArray(declarations)) return { ok: false, reason: "repository_test_runner_not_declared" };
    const matching = declarations.filter((entry) => entry?.runtime === "node" && entry.script === script
      && Array.isArray(entry.args) && JSON.stringify(entry.args) === JSON.stringify(args.slice(1)));
    if (!matching.length) return { ok: false, reason: "repository_test_runner_not_declared" };
    if (!declarations.every(validRunnerDeclaration)) return { ok: false, reason: "repository_test_runners_invalid" };
    const invocation = resolveRepositoryRunner(root, matching[0]);
    if (!invocation.runner) return { ok: false, reason: invocation.reason };
    return frozenRepositoryInvocation(validation, invocation);
  }
  if (args.length !== 1 || args[0].startsWith("-") || !/\.[cm]?js$/i.test(args[0])) return validation;
  const relative = path.relative(root, path.resolve(root, validation.cwd_relative || ".", args[0])).replace(/\\/g, "/");
  if (!canonicalEvidenceSourcePath(relative)) return validation;
  const config = readRepositoryVerificationConfig(root);
  // Invalid/uncommitted registries retain their separate obligation diagnostic;
  // they must not suppress an independently runnable planner command.
  if (!config || config.error) return validation;
  const invocation = repositoryTestRunner(root, relative, config);
  if (!invocation) return validation;
  if (!invocation.runner) return { ok: false, reason: invocation.reason };
  return frozenRepositoryInvocation(validation, invocation);
}
