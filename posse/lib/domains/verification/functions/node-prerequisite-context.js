import { resolvePackageManagerContext, splitPlannerTestInvocation } from "./planner-test-command.js";
import { NODE_PACKAGE_MANAGER_EXECUTABLES } from "../../../catalog/node-package-managers.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../catalog/process.js";
import { filterProcessEnv } from "../../../shared/platform/functions/process-env.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { detectNodePackageManager } from "../../../shared/tools/functions/node-package-manager.js";
import { missingNodeTestDependency } from "../../../shared/tools/functions/toolkit/node-test-failure.js";

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Only the invoked repository file can select a dependency root. Never scan
// arbitrary sibling packages or use a path supplied by stderr as authority.
export function nodePrerequisiteContext(projectDir, command, receipt = null) {
  const root = path.resolve(projectDir);
  const invocation = splitPlannerTestInvocation(command);
  if (invocation.invalid_directory) return { projectDir: root, reason: "test_command_contains_unsafe_working_directory" };
  let args = [];
  try { args = parseCommandArguments(invocation.command); }
  catch { return { projectDir: root, reason: "test_command_invalid_quoting" }; }
  const executable = path.basename(args[0] || "").toLowerCase();
  const executionRoot = path.resolve(root, invocation.cwd_relative || ".");
  let importer = path.join(executionRoot, "package.json");
  if (NODE_PACKAGE_MANAGER_EXECUTABLES.includes(executable)) {
    const validation = resolvePackageManagerContext(command, root);
    if (!validation.ok) return { projectDir: root, reason: validation.reason };
    const candidate = validation.importer;
    try {
      if (!within(root, candidate) || !within(fs.realpathSync(root), fs.realpathSync(candidate))) {
        return { projectDir: root, reason: "test_command_contains_unsafe_working_directory" };
      }
      importer = candidate;
    } catch {
      return { projectDir: root, reason: "test_manifest_missing" };
    }
  }
  if (["node", "node.exe"].includes(executable)) {
    const positional = args.slice(1).filter((arg) => !arg.startsWith("-"));
    if (positional.length === 1 && /\.[cm]?[jt]s$/i.test(positional[0])) {
      const candidate = path.resolve(executionRoot, positional[0]);
      try {
        if (within(root, candidate) && within(fs.realpathSync(root), fs.realpathSync(candidate))
          && fileExists(candidate)) importer = candidate;
      } catch { /* missing/escaped scripts cannot select another root */ }
    }
  }
  let installRoot = root;
  let cursor = path.dirname(importer);
  while (within(root, cursor)) {
    if (fileExists(path.join(cursor, "package.json")) && detectNodePackageManager(cursor).lock) {
      installRoot = cursor;
      break;
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  const output = `${receipt?.stdout || ""}\n${receipt?.stderr || ""}`;
  const missingPackage = missingNodeTestDependency(output);
  // Scoped checks and typecheck name the declared package whose directory
  // they found absent. Type-only packages never resolve at runtime, so that
  // directory is what readiness checks for them.
  const declaredPackage = missingPackage ? null : /\bdeclared package (\S+) is not installed\b/.exec(output)?.[1] || null;
  return {
    projectDir: installRoot,
    importer,
    missingPackage: missingPackage || declaredPackage,
    ...(declaredPackage ? { packageDirectoryOnly: true } : {}),
  };
}

export function nodePrerequisiteReady(context) {
  if (!context?.missingPackage) {
    try { return fs.statSync(path.join(context.projectDir, "node_modules")).isDirectory(); } catch { return false; }
  }
  if (context.packageDirectoryOnly) {
    return (createRequire(context.importer).resolve.paths(context.missingPackage) || [])
      .some((directory) => fileExists(path.join(directory, context.missingPackage, "package.json")));
  }
  try {
    createRequire(context.importer).resolve(context.missingPackage);
    return true;
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return false;
    // An import-only export can be installed correctly even when the CJS
    // resolver rejects it. Resolve under import conditions without executing
    // package code, in the same directory as the importing test.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      "import fs from 'node:fs'; import { fileURLToPath } from 'node:url'; if (!fs.statSync(fileURLToPath(import.meta.resolve(process.argv[1]))).isFile()) process.exit(1);",
      "--", context.missingPackage], {
      cwd: path.dirname(context.importer), timeout: 5_000, stdio: "ignore",
      env: filterProcessEnv(process.env, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS }),
      windowsHide: true,
    });
    return result.status === 0;
  }
}
