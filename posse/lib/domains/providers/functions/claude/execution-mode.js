import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../queue/functions/index.js";

export const CLAUDE_EXECUTION_MODE_PRINT = "print";
export const CLAUDE_EXECUTION_MODE_INTERACTIVE = "interactive";

function normalizeClaudeExecutionMode(value, fallback = CLAUDE_EXECUTION_MODE_PRINT) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["interactive", "interactive-client", "pty", "terminal", "virtual-shell", "virtual_shell", "wrapper", "client"].includes(normalized)) {
    return CLAUDE_EXECUTION_MODE_INTERACTIVE;
  }
  if (["print", "stream", "stream-json", "stream_json", "-p", "default"].includes(normalized)) {
    return CLAUDE_EXECUTION_MODE_PRINT;
  }
  return fallback;
}

export function resolveClaudeExecutionMode({ requested = null, interactiveBackend = null } = {}) {
  if (requested != null && String(requested).trim() !== "") {
    return normalizeClaudeExecutionMode(requested);
  }
  if (interactiveBackend) return CLAUDE_EXECUTION_MODE_INTERACTIVE;
  const envValue = process.env.POSSE_CLAUDE_EXECUTION_MODE || process.env.CLAUDE_EXECUTION_MODE;
  if (envValue != null && String(envValue).trim() !== "") {
    return normalizeClaudeExecutionMode(envValue);
  }
  try {
    const stored = getSetting(SETTING_KEYS.CLAUDE_EXECUTION_MODE);
    if (stored != null && String(stored).trim() !== "") {
      return normalizeClaudeExecutionMode(stored);
    }
  } catch {
    // Settings DB may be unavailable in tests or early bootstrap.
  }
  return CLAUDE_EXECUTION_MODE_PRINT;
}
