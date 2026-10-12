import { PAIRING_RUNTIME_COMMANDS } from "../../../catalog/pairing-environment.js";

// Preserve structured transport failures while adding an operator remedy.
// Never echo command arguments: remote URLs can carry credentials.
export function pairingCommandError(command, error, { timeoutMs = null, operation = null } = {}) {
  if (String(error?.code || "").startsWith("pairing_")) return error;
  const timeout = error?.code === "ETIMEDOUT" || error?.errno === "ETIMEDOUT"
    || /\bETIMEDOUT\b/u.test(String(error?.message || ""))
    || (error?.killed === true && error?.signal === "SIGTERM");
  const missing = error?.code === "ENOENT" || /\bENOENT\b/u.test(String(error?.message || ""));
  if (!timeout && !missing) return error;
  const spec = PAIRING_RUNTIME_COMMANDS.find((entry) => entry.command === command);
  const label = spec?.label || command;
  const stage = operation ? ` during ${operation}` : "";
  const budget = timeoutMs ? ` after ${Math.ceil(timeoutMs / 1000)}s` : "";
  const message = timeout
    ? `${label} timed out${budget}${stage}. Check that \`${command}${command === "git" || command === "gh" ? " --version" : " -V"}\` completes in this terminal. For remote operations, check network access and authentication, then retry \`posse pair\`.`
    : `${label} is not available in this terminal. ${spec?.remedy || "Install it and reopen your terminal."}`;
  return Object.assign(new Error(message, { cause: error }), {
    code: timeout ? "pairing_environment_command_timeout" : "pairing_environment_command_missing",
    command, operation, timeoutMs, originalCode: error?.code ?? null,
  });
}
