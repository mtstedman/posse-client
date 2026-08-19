import { nativeReadResultStats, recordToolInvocation } from "../../../../domains/observability/functions/observations.js";

function isSuccessfulToolResult(result) {
  return !/^(?:Error:|AUDIT ERROR:)/i.test(typeof result === "string" ? result : String(result ?? ""));
}

export function createObservationWrapper({ skipObservationLogging = false } = {}) {
  if (skipObservationLogging) return (_toolName, execFn) => execFn;
  return (toolName, execFn) => function wrappedDeterministicExecutor(args, cwd, scopePredicates, ...rest) {
    const result = execFn(args, cwd, scopePredicates, ...rest);
    const record = (resolved) => {
      if (isSuccessfulToolResult(resolved)) recordToolInvocation({ tool: toolName, input: args, cwd, extraDetail: nativeReadResultStats(toolName, resolved) });
      return resolved;
    };
    return result && typeof result.then === "function" ? result.then(record) : record(result);
  };
}
