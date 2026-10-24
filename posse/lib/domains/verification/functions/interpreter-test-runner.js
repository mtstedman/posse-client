import path from "node:path";
import { INTERPRETER_TEST_RUNNERS } from "../../../catalog/test-command-policy.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { resolvePhpUnitInvocation } from "../../environments/functions/phpunit-runtime.js";

const basename = (value) => String(value || "").replaceAll("\\", "/").split("/").pop().toLowerCase();
export function interpreterTestRunner(command) {
  const words = parseCommandArguments(command);
  const executable = basename(words[0]).replace(/\.(?:exe|bat|cmd)$/, "");
  const interpreter = /^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(executable) ? "python" : executable;
  const names = INTERPRETER_TEST_RUNNERS[interpreter];
  const index = interpreter === "ruby" && words[1] === "-S" ? 2 : 1;
  const runner = names?.[basename(words[index])];
  if (runner) return { runner, executable: words[0], script: words[index], args: words.slice(index + 1) };
  const direct = INTERPRETER_TEST_RUNNERS.php[executable];
  return direct ? { runner: direct, executable: "php", script: words[0], args: words.slice(1) } : null;
}

export function resolveInterpreterTestCommand(cwd, validation, { posseRoot } = {}) {
  if (!validation?.ok || !cwd) return validation;
  const invocation = interpreterTestRunner(validation.execution_command);
  if (!invocation || invocation.runner !== "phpunit") return validation;
  const resolved = resolvePhpUnitInvocation({ cwd: path.resolve(cwd, validation.cwd_relative || "."),
    script: invocation.script, args: invocation.args, posseRoot });
  if (!resolved) return { ok: false, reason: "phpunit_unavailable" };
  const quote = (word) => JSON.stringify(word);
  return { ...validation, execution_command: [invocation.executable, ...resolved.args].map(quote).join(" "),
    runner: resolved.runner, repository_validated: true, repository_runner: true };
}
