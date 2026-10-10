import fs from "node:fs";
import path from "node:path";
import { REPOSITORY_TEST_SCRIPT_RUNTIMES } from "../../../../catalog/process.js";
import { readRepositoryVerificationConfig } from "../../../../domains/verification/functions/verification-plan.js";
import { canonicalEvidenceSourcePath } from "../source-evidence.js";

export function pythonExecutable() {
  const managed = String(process.env.POSSE_PROJECT_PYTHON || "").trim();
  if (managed && path.isAbsolute(managed) && fs.existsSync(managed)) return managed;
  return "python3";
}

// Repository declarations supply coverage; never infer it from a script name
// or the fact that a different suite passed. Execute a fixed script argv with
// the same environment and timeout boundary as built-in test adapters.
export function repositoryTestRunner(root, testPath) {
  const config = readRepositoryVerificationConfig(root);
  if (!config) return null;
  if (config.error) return { reason: config.error };
  const runners = config.unit_test_runners;
  if (runners == null) return null;
  if (!Array.isArray(runners)) return { reason: "repository_test_runners_invalid" };
  const matches = [];
  for (const runner of runners) {
    const { files, runtime, script, args = [] } = runner || {};
    if (!Array.isArray(files) || files.length === 0
      || files.some((file) => typeof file !== "string" || !canonicalEvidenceSourcePath(file))
      || !Object.hasOwn(REPOSITORY_TEST_SCRIPT_RUNTIMES, runtime)
      || typeof script !== "string" || !canonicalEvidenceSourcePath(script)
      || script.startsWith("-") || !new RegExp(`\\${REPOSITORY_TEST_SCRIPT_RUNTIMES[runtime]}$`).test(script)
      || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      return { reason: "repository_test_runners_invalid" };
    }
    if (!files.some((file) => path.matchesGlob(testPath, file))) continue;
    let realScript;
    try { realScript = fs.realpathSync(path.resolve(root, script)); } catch {
      return { reason: "repository_test_script_missing" };
    }
    if (!canonicalEvidenceSourcePath(path.relative(fs.realpathSync(root), realScript))) {
      return { reason: "repository_test_script_outside_root" };
    }
    matches.push({ runner: "repository_script", executable: runtime === "node" ? process.execPath
      : runtime === "python" ? pythonExecutable() : runtime,
      args: [script, ...args] });
  }
  if (matches.length > 1) return { reason: "repository_test_runner_ambiguous" };
  return matches[0] || null;
}
