import { missingPhpRuntimeCapabilities } from "./php-runtime-capability.js";
import { NODE_PACKAGE_MANAGER_EXECUTABLES } from "../../../catalog/node-package-managers.js";
import { missingNodeTestDependency } from "../../../shared/tools/functions/toolkit/node-test-failure.js";
import fs from "fs";
import path from "path";
import { commandExecutable } from "./planner-test-command.js";

function composerDependencyInstallMissing(projectRoot) {
  const root = path.resolve(String(projectRoot || ""));
  if (!root || !fs.existsSync(path.join(root, "composer.json"))) return false;
  return !fs.existsSync(path.join(root, "vendor", "autoload.php"))
    || !fs.existsSync(path.join(root, "vendor", "composer", "installed.json"));
}

function composerLockedDependencyClassFileMissing(projectRoot, output) {
  const root = path.resolve(String(projectRoot || ""));
  const lockPath = path.join(root, "composer.lock");
  if (!root || !fs.existsSync(lockPath)) return false;
  const missingClasses = [...String(output || "").matchAll(
    /(?:Class|Interface|Trait)\s+["']([^"']+)["']\s+not found/gi,
  )]
    .map((match) => String(match[1] || "").replace(/^\\+/, ""))
    .filter(Boolean);
  if (missingClasses.length === 0) return false;

  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, "utf8")); }
  catch { return false; }
  const packages = [
    ...(Array.isArray(lock?.packages) ? lock.packages : []),
    ...(Array.isArray(lock?.["packages-dev"]) ? lock["packages-dev"] : []),
  ];
  for (const dependency of packages) {
    const packageName = String(dependency?.name || "").trim();
    const psr4 = dependency?.autoload?.["psr-4"];
    if (!packageName || !psr4 || typeof psr4 !== "object" || Array.isArray(psr4)) continue;
    for (const [rawPrefix, rawDirs] of Object.entries(psr4)) {
      const prefix = String(rawPrefix || "").replace(/^\\+/, "");
      if (!prefix) continue;
      for (const className of missingClasses) {
        if (!className.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const relativeClass = className.slice(prefix.length).replace(/\\/g, path.sep);
        const autoloadDirs = Array.isArray(rawDirs) ? rawDirs : [rawDirs];
        const candidates = autoloadDirs
          .map((dir) => String(dir || "").trim())
          .filter(Boolean)
          .map((dir) => path.join(root, "vendor", packageName, dir, `${relativeClass}.php`));
        if (candidates.length > 0 && candidates.every((candidate) => !fs.existsSync(candidate))) {
          return true;
        }
      }
    }
  }
  return false;
}

export function classifyNestedRunnerInfrastructureFailure(command, result, { projectRoot = null } = {}) {
  if (result?.status === "infrastructure_error"
    && String(result?.code || "").toUpperCase() === "ENOENT") {
    return {
      ...result,
      ok: null,
      reason: "test_task_dependency_unavailable",
      missing_executable: commandExecutable(command) || null,
    };
  }
  if (result?.status !== "failed") return result;
  const executable = commandExecutable(command);
  const output = [result.stdout, result.stderr]
    .map((value) => String(value || ""))
    .filter(Boolean)
    .join("\n");
  const missingCapabilities = missingPhpRuntimeCapabilities(command, result, { projectRoot });
  if (missingCapabilities) return {
    ...result, status: "infrastructure_error", ok: null,
    reason: "test_task_dependency_unavailable", missing_runtime_capabilities: missingCapabilities,
  };
  const packageManager = NODE_PACKAGE_MANAGER_EXECUTABLES
    .includes(executable);
  const nestedExecutableMissing = packageManager && (
    /\bspawn\s+ENOENT\b/i.test(output)
    || /\bnode_modules missing\b/i.test(output)
    || /(?:^|\n)(?:\/bin\/)?(?:ba)?sh:\s*\d*:\s*[^\n]+:\s*(?:not found|command not found)\b/i.test(output)
    || /is not recognized as an internal or external command/i.test(output)
  );
  // `composer test` in a worktree without vendor/ ends with
  // `sh: 1: vendor/bin/phpunit: not found` and exit 127. Composer and PHP
  // pass a script's 127 through; it means a runner is missing, not a failure.
  const composerRunnerMissing = ["composer", "composer.bat", "php", "php.exe"].includes(executable) && (
    Number(result.code) === 127
    || /(?:^|\n)(?:\/bin\/)?(?:ba)?sh:\s*\d*:\s*[^\n]*vendor[\\/][^\n]*:\s*(?:not found|command not found)\b/i.test(output)
    || /could not open input file:\s*[^\n]*vendor[\\/]/i.test(output)
    || /["']?vendor(?:[\\/][^\s"']*)?["']?\s+is not recognized as an internal or external command/i.test(output)
  );
  const composerSymbolMissing = /(?:Class|Interface|Trait)\s+["'][^"']+["']\s+not found/i.test(output);
  const composerAutoloadMissing = /Failed opening required [^\n]*vendor[\\/]autoload\.php/i.test(output)
    || /failed to open stream[^\n]*vendor[\\/]autoload\.php/i.test(output);
  const composerClassMissing = ["php", "php.exe"].includes(executable)
    && (
      (composerDependencyInstallMissing(projectRoot) && (composerSymbolMissing || composerAutoloadMissing))
      || (composerSymbolMissing && composerLockedDependencyClassFileMissing(projectRoot, output))
    );
  const nodeDependencyMissing = (["node", "node.exe", "npx", "npx.cmd"].includes(executable) || packageManager)
    && missingNodeTestDependency(output);
  if (!nestedExecutableMissing && !composerRunnerMissing && !composerClassMissing && !nodeDependencyMissing) return result;
  return {
    ...result,
    status: "infrastructure_error",
    ok: null,
    reason: "test_task_dependency_unavailable",
  };
}

export function classifyPackageManagerTestPlanFailure(command, result) {
  if (result?.status !== "failed") return result;
  const executable = commandExecutable(command);
  if (!NODE_PACKAGE_MANAGER_EXECUTABLES.includes(executable)) {
    return result;
  }
  const output = [result.stdout, result.stderr]
    .map((value) => String(value || ""))
    .filter(Boolean)
    .join("\n");
  const manifestMissing = (
    /could not read package\.json/i.test(output)
    || /could not find (?:a )?package\.json/i.test(output)
    || /enoent[^\n]*package\.json/i.test(output)
    || /no package\.json (?:was )?found/i.test(output)
  );
  const scriptMissing = (
    /missing script:\s*["']?[^\s"']+/i.test(output)
    || /err_pnpm_no_script/i.test(output)
    || /command ["'][^"']+["'] not found/i.test(output)
    || /script (?:not found|not found in package\.json)/i.test(output)
  );
  if (!manifestMissing && !scriptMissing) return result;
  return {
    ...result,
    status: "invalid_test_plan",
    ok: null,
    reason: manifestMissing ? "test_manifest_missing" : "test_script_missing",
  };
}
