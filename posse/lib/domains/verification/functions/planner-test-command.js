import { testCommandScriptPaths } from "./test-command-script-paths.js";
import { NODE_PACKAGE_MANAGER_EXECUTABLES } from "../../../catalog/node-package-managers.js";
import { MUTATING_TEST_FLAGS, INTERACTIVE_TEST_FLAGS } from "../../../catalog/test-command-policy.js";
import { declaredNodeTestCommand } from "../../../shared/tools/functions/toolkit/repository-test-runner.js";
import fs from "fs";
import path from "path";
import { hasUnquotedShellOperators, isSafeDirectNodeTestScriptArgs, parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { resolveLocalVitestCommand, vitestCommandArgs } from "./vitest-command.js";
import { TEST_SCRIPT_NO_VERIFICATION_REASON } from "../../../catalog/verification.js";
import { sha256 } from "../../../shared/format/functions/sha256.js";

export function commandExecutable(command) {
  const match = String(command || "").trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = match?.[1] || match?.[2] || match?.[3] || "";
  return raw.replace(/\\/g, "/").split("/").pop().toLowerCase();
}

export function safeRelativeTestDirectory(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split("/").filter((segment) => segment !== ".");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "..")) return null;
  if (segments.some((segment) => !/^[A-Za-z0-9._@+-]+$/.test(segment))) return null;
  return segments.join("/");
}

function directRepositoryShellTestScript(value) {
  const relative = safeRelativeTestDirectory(value);
  if (!relative || !relative.includes("/") || !/\.sh$/i.test(relative)) return null;
  const segments = relative.split("/");
  const root = segments[0].toLowerCase();
  const basename = segments.at(-1).toLowerCase();
  if (root === "test" || root === "tests") return relative;
  if (root !== "scripts") return null;
  return /^(?:run[-_.])?(?:tests?|checks?|verify|lint|typecheck|spec)(?:[-_.][^/]*)?\.sh$/.test(basename)
    ? relative
    : null;
}

function splitPlannerTestInvocation(command) {
  const value = String(command || "").trim();
  const match = value.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*&&\s*(.+)$/i);
  if (!match) {
    return { command: value, cwd_relative: null, invalid_directory: false };
  }
  const cwdRelative = safeRelativeTestDirectory(match[1] || match[2] || match[3]);
  return {
    command: String(match[4] || "").trim(),
    cwd_relative: cwdRelative,
    invalid_directory: !cwdRelative,
  };
}

function packageManagerTaskArgs(args = [], manager = "") {
  const remaining = [...args];
  // args arrive lowercased (the whole command is normalized before splitting),
  // so "-f" here matches pnpm's -F/--filter and "-c" matches -C/--dir. Both
  // take a value that must be skipped along with the flag. npm's --prefix and
  // yarn's --cwd are the same shape (observed live 2026-08-30: the planner's
  // "npm --prefix htdocs run typecheck" baseline was rejected as an
  // unrecognized runner, silently dropping the frozen baseline).
  const optionsWithValues = new Set([
    "--filter", "-f", "--dir", "-c", "--config-dir", "--store-dir",
    "--virtual-store-dir", "--workspace-dir", "--prefix", "--cwd",
    "--workspace", "-w",
  ]);
  while (remaining.length > 0 && remaining[0].startsWith("-")) {
    const option = remaining.shift();
    if (!option.includes("=") && optionsWithValues.has(option)) remaining.shift();
  }
  // Yarn classic expresses workspace selection as a subcommand rather than
  // an option (`yarn workspace <name> test`). The package selector is not the
  // script name and must not turn an ordinary test into an operational gate.
  if (manager === "yarn" && remaining[0] === "workspace" && remaining[1]) {
    remaining.splice(0, 2);
  }
  return remaining;
}

export function validatePlannerTestCommand(command) {
  const value = String(command || "").trim();
  if (!value) return { ok: false, reason: "test_command_is_empty" };
  if (/[\r\n]/.test(value)) return { ok: false, reason: "test_command_contains_newline" };
  const invocation = splitPlannerTestInvocation(value);
  if (invocation.invalid_directory) {
    return { ok: false, reason: "test_command_contains_unsafe_working_directory" };
  }
  const executableCommand = invocation.command;
  if (hasUnquotedShellOperators(executableCommand) || /`|\$\(/.test(executableCommand)) {
    return { ok: false, reason: "test_command_contains_shell_composition" };
  }
  if (/%/.test(executableCommand)) {
    return { ok: false, reason: "test_command_contains_shell_expansion" };
  }

  const executable = commandExecutable(executableCommand);
  let vitestArgs;
  try { vitestArgs = vitestCommandArgs(executableCommand); } catch {
    return { ok: false, reason: "test_command_invalid_quoting" };
  }
  let directShellScript = null;
  let directShellInterpreter = false;
  try {
    const parsedWords = parseCommandArguments(executableCommand);
    directShellInterpreter = ["bash", "sh", "bash.exe", "sh.exe"].includes(executable);
    directShellScript = directRepositoryShellTestScript(
      directShellInterpreter ? parsedWords[1] : parsedWords[0],
    );
  } catch {
    directShellScript = null;
    directShellInterpreter = false;
  }
  const args = parseCommandArguments(executableCommand).slice(1).map((word) => word.toLowerCase());
  const flagName = (arg) => String(arg || "").toLowerCase().split("=", 1)[0];
  if (args.some((arg) => MUTATING_TEST_FLAGS.has(flagName(arg))
    || (vitestArgs && MUTATING_TEST_FLAGS.has(flagName(arg).split(".", 1)[0])))) {
    return { ok: false, reason: "test_command_contains_mutating_output_flag" };
  }
  if (args.some((arg) => INTERACTIVE_TEST_FLAGS.has(flagName(arg)))) {
    return { ok: false, reason: "test_command_contains_interactive_flag" };
  }
  const runnerSpecificMutatingFlags = executable === "go" || executable === "go.exe"
    ? new Set(["-o", "-coverprofile", "-cpuprofile", "-memprofile", "-mutexprofile", "-blockprofile", "-trace", "-outputdir"])
    : executable === "dotnet" || executable === "dotnet.exe"
      ? new Set(["-o"])
      : new Set();
  if (args.some((arg) => runnerSpecificMutatingFlags.has(flagName(arg)))) {
    return { ok: false, reason: "test_command_contains_mutating_output_flag" };
  }
  for (const arg of args) {
    const values = arg.includes("=") ? [arg, arg.slice(arg.indexOf("=") + 1)] : [arg];
    if (values.some((value) => path.isAbsolute(value)
      || /^[A-Za-z]:[\\/]/.test(value)
      || String(value).replace(/\\/g, "/").split("/").includes(".."))) {
      return { ok: false, reason: "test_command_contains_unsafe_path" };
    }
  }
  const hasArg = (expected) => args.includes(expected);
  const safeTaskPattern = /^(?:test|tests|check|typecheck|lint|verify|spec)(?::|$)/;

  let ok = false;
  if (vitestArgs) {
    if (args.some((arg) => arg === "-w")) {
      return { ok: false, reason: "test_command_contains_interactive_flag" };
    }
    ok = vitestArgs[0] === "run";
  } else if (NODE_PACKAGE_MANAGER_EXECUTABLES.includes(executable)) {
    const manager = executable.replace(/\.(?:cmd|exe)$/i, "");
    const taskArgs = packageManagerTaskArgs(args, manager);
    ok = safeTaskPattern.test(taskArgs[0] || "")
      || (taskArgs[0] === "run" && safeTaskPattern.test(taskArgs[1] || ""));
  } else if (["node", "node.exe"].includes(executable)) {
    ok = hasArg("--test")
      || args.some((arg) => arg.startsWith("--test="))
      || isSafeDirectNodeTestScriptArgs(args);
  } else if (/^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/.test(executable)) {
    const moduleIndex = args.indexOf("-m");
    ok = moduleIndex >= 0 && ["pytest", "unittest"].includes(args[moduleIndex + 1]);
  } else if (/^eslint(?:\.cmd)?$/.test(executable)) {
    ok = !args.some((arg) => ["--output-file", "-o", "--cache"].includes(flagName(arg)));
  } else if (/^(?:tsc|vue-tsc)(?:\.cmd)?$/.test(executable)) {
    const noEmit = args.indexOf("--noemit");
    ok = noEmit >= 0 && args[noEmit + 1] !== "false"
      && !args.some((arg) => ["--build", "-b", "--incremental", "--composite"].includes(flagName(arg)));
  } else if (/^pytest(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/.test(executable)) {
    ok = true;
  } else if (["cargo", "cargo.exe"].includes(executable)) {
    ok = args[0] === "test";
  } else if (["go", "go.exe", "dotnet", "dotnet.exe"].includes(executable)) {
    ok = args[0] === "test";
  } else if (/^(?:mvn|mvnw|mvnw\.cmd|gradle|gradlew|gradlew\.bat)$/.test(executable)) {
    ok = args.some((arg) => /^(?:test|check|verify)$/.test(arg) || /:test$/.test(arg));
  } else if (/^(?:phpunit|phpunit\.bat)$/.test(executable)) {
    ok = true;
  } else if (["php", "php.exe"].includes(executable)) {
    // Accept a test-named script anywhere, or any .php script under a
    // tests/ directory. Real projects keep smoke/regression scripts like
    // tests/api-smoke.php or tests/chess-rules.php; the directory conveys
    // the same intent as a "test" filename, and rejecting them starves the
    // assessor of the executable evidence the confidence policy assumes.
    ok = args.some((arg) => (
      /(?:^|[/\\])(?:phpunit|[^/\\]*tests?[^/\\]*)\.php$/.test(arg)
      || /(?:^|[/\\])(?:run[-_.])?(?:checks?|verify|lint|typecheck|spec)(?:[-_.][^/\\]*)?\.php$/.test(arg)
      || (/(?:^|[/\\])tests?[/\\][^\s]*\.php$/.test(arg)
        && !/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(arg))
    )) || (
      /\.php$/.test(args[0] || "")
      && args.length === 2
      && args[1] === "--validate"
    );
  } else if (["composer", "composer.bat"].includes(executable)) {
    ok = args[0] === "test" || (args[0] === "run" && /^(?:test|check)(?::|$)/.test(args[1] || ""));
  } else if (["bundle", "bundle.bat"].includes(executable)) {
    ok = args[0] === "exec" && ["rspec", "rake"].includes(args[1]);
  } else if (/^(?:rspec|rake|make|ctest)(?:\.exe)?$/.test(executable)) {
    ok = executable.startsWith("rspec")
      || executable.startsWith("ctest")
      || args.some((arg) => /^(?:test|tests|check|spec)$/.test(arg));
  } else if (directShellScript) {
    // Repository-owned executable test wrappers are equivalent to accepted
    // package/manifest scripts. The repository-aware validation pass below
    // proves the exact path is a regular executable file before it is frozen.
    ok = true;
  }
  return ok
    ? {
        ok: true,
        reason: null,
        execution_command: executableCommand,
        cwd_relative: invocation.cwd_relative,
        ...(directShellScript ? {
          direct_script_relative: directShellScript,
          direct_script_interpreter: directShellInterpreter,
        } : {}),
      }
    : { ok: false, reason: `unrecognized_test_runner:${executable || "missing"}` };
}

function packageManagerScriptInvocation(command) {
  const invocation = splitPlannerTestInvocation(command);
  if (invocation.invalid_directory) return null;
  let words;
  try {
    words = parseCommandArguments(invocation.command);
  } catch {
    return null;
  }
  const executable = commandExecutable(words[0]);
  if (!NODE_PACKAGE_MANAGER_EXECUTABLES.includes(executable)) {
    return null;
  }
  const manager = executable.replace(/\.(?:cmd|exe)$/i, "");
  const args = words.slice(1);
  let cwdRelative = invocation.cwd_relative;
  let workspaceScoped = false;
  let workspaceSelector = null;
  let allWorkspaces = false;
  const cwdFlags = manager === "npm"
    ? new Set(["--prefix"])
    : manager === "yarn"
      ? new Set(["--cwd"])
      : manager === "pnpm"
        ? new Set(["--dir", "-c"])
        : new Set(["--cwd"]);
  const taskArgs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const lower = String(arg).toLowerCase();
    const equalFlag = [...cwdFlags].find((flag) => lower.startsWith(`${flag}=`));
    if (equalFlag) {
      cwdRelative = safeRelativeTestDirectory(arg.slice(equalFlag.length + 1));
      if (!cwdRelative) return { invalid: "test_command_contains_unsafe_working_directory" };
      continue;
    }
    if (cwdFlags.has(lower)) {
      cwdRelative = safeRelativeTestDirectory(args[index + 1]);
      if (!cwdRelative) return { invalid: "test_command_contains_unsafe_working_directory" };
      index++;
      continue;
    }
    // Workspace/filter/config flags do not change the manifest root. Skip
    // their values so they cannot be mistaken for a script name.
    if (["--filter", "-f", "--workspace", "-w", "--config-dir", "--store-dir", "--virtual-store-dir", "--workspace-dir"].includes(lower)) {
      if (["--filter", "-f", "--workspace", "-w"].includes(lower)) {
        workspaceScoped = true;
        workspaceSelector = String(args[index + 1] || "").trim() || null;
      }
      if (!arg.includes("=")) index++;
      continue;
    }
    if (lower.startsWith("--filter=") || lower.startsWith("-f=") || lower.startsWith("--workspace=") || lower.startsWith("-w=")) {
      workspaceScoped = true;
      workspaceSelector = String(arg.slice(arg.indexOf("=") + 1) || "").trim() || null;
      continue;
    }
    if (
      (manager === "npm" && ["--workspaces", "--ws"].includes(lower))
      || (manager === "pnpm" && ["--recursive", "-r"].includes(lower))
    ) {
      workspaceScoped = true;
      allWorkspaces = true;
      continue;
    }
    if (lower.startsWith("-")) continue;
    taskArgs.push(arg);
  }
  if (manager === "yarn" && String(taskArgs[0] || "").toLowerCase() === "workspace" && taskArgs[1]) {
    workspaceScoped = true;
    workspaceSelector = String(taskArgs[1]).trim() || null;
    taskArgs.splice(0, 2);
  }
  const first = String(taskArgs[0] || "");
  const script = first.toLowerCase() === "run"
    ? String(taskArgs[1] || "")
    : String(first || "");
  return {
    manager,
    cwd_relative: cwdRelative || null,
    script: script || null,
    workspace_scoped: workspaceScoped,
    workspace_selector: workspaceSelector,
    all_workspaces: allWorkspaces,
    if_present: args.some((arg) => String(arg).toLowerCase() === "--if-present"),
    built_in: manager === "bun" && script === "test",
  };
}

function workspacePatterns(projectRoot, rootManifest = {}) {
  const declared = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : Array.isArray(rootManifest.workspaces?.packages)
      ? rootManifest.workspaces.packages
      : [];
  const patterns = declared.map((value) => String(value || "").trim()).filter(Boolean);
  const pnpmWorkspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const source = fs.readFileSync(pnpmWorkspacePath, "utf8");
      for (const match of source.matchAll(/^\s*-\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/gm)) {
        const value = String(match[1] || "").trim();
        if (value) patterns.push(value);
      }
    } catch {
      // The root package manifest remains usable if optional pnpm metadata is unreadable.
    }
  }
  return [...new Set(patterns)];
}

function declaredWorkspaceManifests(projectRoot, rootManifest = {}, { limit = 100 } = {}) {
  const root = path.resolve(projectRoot);
  const manifestPaths = [];
  const addManifest = (candidate) => {
    if (manifestPaths.length >= limit) return;
    const resolved = path.resolve(root, candidate);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return;
    const manifestPath = path.join(resolved, "package.json");
    try {
      const stat = fs.lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
    } catch {
      return;
    }
    manifestPaths.push(manifestPath);
  };

  for (const rawPattern of workspacePatterns(root, rootManifest)) {
    if (manifestPaths.length >= limit) break;
    const pattern = String(rawPattern || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!pattern || pattern.startsWith("/") || pattern.split("/").includes("..")) continue;
    if (!pattern.includes("*")) {
      addManifest(pattern);
      continue;
    }
    // Resolve the common, deterministic `base/*` workspace form. Complex
    // glob semantics stay with the package manager and are not guessed here.
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) continue;
    const base = path.resolve(root, pattern.slice(0, -2));
    if (base === root || !base.startsWith(`${root}${path.sep}`)) continue;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      addManifest(path.join(pattern.slice(0, -2), entry.name));
    }
  }

  return [...new Set(manifestPaths)].map((manifestPath) => {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return {
        manifest,
        manifest_path: manifestPath,
        relative_dir: path.relative(root, path.dirname(manifestPath)).replace(/\\/g, "/"),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function workspaceScriptValidation(projectRoot, rootManifest, invocation) {
  const workspaces = declaredWorkspaceManifests(projectRoot, rootManifest);
  if (workspaces.length === 0) return { ok: false, reason: "test_workspace_missing" };
  const selector = String(invocation.workspace_selector || "").trim().replace(/^\.\//, "").replace(/\/$/, "");
  const selectorIsExact = selector && !/[*!?[\]{}]/.test(selector) && !selector.includes("...");
  const selected = selectorIsExact
    ? workspaces.filter((entry) => entry.manifest?.name === selector || entry.relative_dir === selector)
    : workspaces;
  if (selected.length === 0) return { ok: false, reason: `test_workspace_missing:${selector || "unknown"}` };
  const withScript = selected.filter((entry) => typeof entry.manifest?.scripts?.[invocation.script] === "string");
  if (withScript.length === 0) return { ok: false, reason: `test_script_missing:${invocation.script || "unknown"}` };
  if (
    invocation.manager === "npm"
    && invocation.all_workspaces
    && !invocation.if_present
    && withScript.length !== selected.length
  ) {
    const missing = selected.find((entry) => typeof entry.manifest?.scripts?.[invocation.script] !== "string");
    return { ok: false, reason: `test_script_missing_in_workspace:${missing?.relative_dir || "unknown"}` };
  }
  return {
    ok: true,
    workspace_manifest_relative: path.relative(projectRoot, withScript[0].manifest_path).replace(/\\/g, "/"),
    script_definitions: withScript.map((entry) => ({
      script: invocation.script,
      scripts: entry.manifest.scripts,
    })),
  };
}

function referencedPackageScripts(command, scripts = {}) {
  let words;
  try { words = parseCommandArguments(command); } catch { return []; }
  const references = [];
  const separators = new Set(["&&", "||", ";", "|", "&"]);
  for (let index = 0; index < words.length; index++) {
    const executable = commandExecutable(words[index]);
    if (!NODE_PACKAGE_MANAGER_EXECUTABLES.includes(executable)) {
      continue;
    }
    const manager = executable.replace(/\.(?:cmd|exe)$/i, "");
    const args = [];
    for (let cursor = index + 1; cursor < words.length; cursor++) {
      if (separators.has(words[cursor])) break;
      args.push(String(words[cursor]).toLowerCase());
    }
    const taskArgs = packageManagerTaskArgs(args, manager);
    const first = String(taskArgs[0] || "");
    const script = (["run", "run-script"].includes(first)
      ? String(taskArgs[1] || "")
      : first).replace(/[;&|]+$/u, "");
    if (script && typeof scripts?.[script] === "string") references.push(script);
  }
  return [...new Set(references)];
}

function declaredScriptValidation(definitions = []) {
  let hasPotentialVerification = false;
  const validateCommand = (command) => {
    let words;
    try { words = parseCommandArguments(command); } catch { words = String(command || "").split(/\s+/); }
    const flags = words
      .map((word) => String(word || "").toLowerCase().split("=", 1)[0].replace(/[;&|]+$/u, ""))
      .filter((word) => word.startsWith("-"));
    if (flags.some((flag) => MUTATING_TEST_FLAGS.has(flag))) {
      return { ok: false, reason: "test_script_contains_mutating_output_flag" };
    }
    if (flags.some((flag) => INTERACTIVE_TEST_FLAGS.has(flag))) {
      return { ok: false, reason: "test_script_contains_interactive_flag" };
    }
    // Reject literal placeholder scripts, while leaving unknown runners and
    // shell compositions to execution. A lifecycle hook can supply the check.
    const literal = !/[\n\r$`;&|<>]/.test(command);
    const executable = String(words[0] || "");
    const knownNoop = literal && (
      words.length === 0
      || executable === "echo" || executable === "printf"
      || (words.length === 1 && ["true", ":"].includes(executable))
      || (executable === "exit" && words.length === 2 && words[1] === "0")
    );
    if (!knownNoop) hasPotentialVerification = true;
    return { ok: true };
  };

  for (const definition of definitions) {
    const scripts = definition?.scripts && typeof definition.scripts === "object"
      ? definition.scripts
      : {};
    const pending = [String(definition?.script || "")];
    const visited = new Set();
    while (pending.length > 0) {
      const script = pending.shift();
      if (!script || visited.has(script)) continue;
      visited.add(script);
      for (const candidate of [`pre${script}`, script, `post${script}`]) {
        const command = scripts[candidate];
        if (typeof command !== "string") continue;
        const validation = validateCommand(command);
        if (!validation.ok) return validation;
        for (const nested of referencedPackageScripts(command, scripts)) {
          if (!visited.has(nested)) pending.push(nested);
        }
      }
    }
  }
  return hasPotentialVerification
    ? { ok: true }
    : { ok: false, reason: TEST_SCRIPT_NO_VERIFICATION_REASON };
}

export function validatePlannerTestCommandForRepository(command, cwd, { filesToCreate = [] } = {}) {
  const shape = validatePlannerTestCommand(command);
  if (!shape.ok) return shape;
  if (vitestCommandArgs(shape.execution_command)) return resolveLocalVitestCommand(cwd, shape);
  // Admission proves test intent, not that an interpreter's script exists.
  // Keep the original argv casing and resolve against the command's cwd.
  const interpreterScripts = testCommandScriptPaths(shape.execution_command, commandExecutable(shape.execution_command));
  const scripts = interpreterScripts.length ? interpreterScripts
    : shape.direct_script_relative ? [shape.direct_script_relative] : [];
  if (interpreterScripts.length) shape.direct_script_interpreter = true;
  if (scripts.length) {
    const projectRoot = path.resolve(cwd);
    const root = shape.cwd_relative
      ? path.resolve(projectRoot, shape.cwd_relative)
      : projectRoot;
    if (root !== projectRoot && !root.startsWith(`${projectRoot}${path.sep}`)) {
      return { ok: false, reason: "test_command_contains_unsafe_working_directory" };
    }
    for (const script of scripts) {
      const scriptPath = path.resolve(root, script);
      if (scriptPath !== projectRoot && !scriptPath.startsWith(`${projectRoot}${path.sep}`)) {
        return { ok: false, reason: "test_command_contains_unsafe_path" };
      }
      let stat;
      try {
        stat = fs.lstatSync(scriptPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          // Only an exact declared creation can justify a not-yet-existing
          // runner. Modify scopes and unrelated new files are not evidence.
          if (filesToCreate.some((file) => typeof file === "string"
            && path.resolve(projectRoot, file) === scriptPath)) continue;
          return { ok: false, reason: "test_script_missing", missing_script: path.relative(projectRoot, scriptPath).replace(/\\/g, "/") };
        }
        return { ok: false, reason: "test_script_unreadable" };
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, reason: "test_script_not_regular" };
      }
      if (!shape.direct_script_interpreter && process.platform !== "win32" && (stat.mode & 0o111) === 0) {
        return { ok: false, reason: "test_script_not_executable" };
      }
    }
    return declaredNodeTestCommand(cwd, {
      ...shape,
      repository_validated: true,
      script_relative: path.relative(projectRoot, path.resolve(root, scripts[0])).replace(/\\/g, "/"),
    });
  }
  const packageInvocation = packageManagerScriptInvocation(command);
  if (!packageInvocation) return declaredNodeTestCommand(cwd, shape);
  if (packageInvocation.invalid) return { ok: false, reason: packageInvocation.invalid };
  if (packageInvocation.built_in) return { ...shape, repository_validated: true, built_in: true };
  const root = packageInvocation.cwd_relative
    ? path.resolve(cwd, packageInvocation.cwd_relative)
    : path.resolve(cwd);
  const projectRoot = path.resolve(cwd);
  if (root !== projectRoot && !root.startsWith(`${projectRoot}${path.sep}`)) {
    return { ok: false, reason: "test_command_contains_unsafe_working_directory" };
  }
  const manifestPath = path.join(root, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: "test_manifest_missing" };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, reason: "test_manifest_invalid" };
  }
  const script = packageInvocation.script;
  const workspaceValidation = packageInvocation.workspace_scoped
    ? workspaceScriptValidation(projectRoot, manifest, packageInvocation)
    : null;
  if (workspaceValidation && !workspaceValidation.ok) return workspaceValidation;
  if (!workspaceValidation && (!script || typeof manifest?.scripts?.[script] !== "string")) {
    return { ok: false, reason: `test_script_missing:${script || "unknown"}` };
  }
  const scriptValidation = declaredScriptValidation(
    workspaceValidation?.script_definitions || [{ script, scripts: manifest.scripts }],
  );
  if (!scriptValidation.ok) return scriptValidation;
  return {
    ...shape,
    repository_validated: true,
    manifest_relative: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    script,
    ...(workspaceValidation?.workspace_manifest_relative ? {
      workspace_manifest_relative: workspaceValidation.workspace_manifest_relative,
    } : {}),
  };
}

/**
 * Return the frozen authorization contract for a planner-authored command that
 * is safe to direct-spawn but is not a test runner. Shell composition,
 * expansion, unsafe working directories, and malformed quoting are never
 * eligible for approval.
 */
export function operationalCommandApprovalRequest(command) {
  const value = String(command || "").trim();
  const validation = validatePlannerTestCommand(value);
  if (validation.ok || !String(validation.reason || "").startsWith("unrecognized_test_runner:")) {
    return null;
  }
  const invocation = splitPlannerTestInvocation(value);
  try {
    parseCommandArguments(invocation.command);
  } catch {
    return null;
  }
  return {
    schema_version: 1,
    command: value,
    command_sha256: sha256(value),
    execution_command: invocation.command,
    cwd_relative: invocation.cwd_relative || null,
    validation_reason: validation.reason,
    execution_phase: "post_change_only",
    verification_eligible: false,
  };
}
