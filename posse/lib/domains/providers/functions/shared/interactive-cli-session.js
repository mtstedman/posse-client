import { createRequire } from "module";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { InteractiveCliUnavailableError } from "../../classes/InteractiveCliSession.js";
import { trackSpawnedProcess } from "./windows-spawn.js";

export {
  InteractiveCliSession,
  InteractiveCliUnavailableError,
} from "../../classes/InteractiveCliSession.js";

const require = createRequire(import.meta.url);
const OPTIONAL_PTY_PACKAGES = [
  "node-pty",
  "@homebridge/node-pty-prebuilt-multiarch",
];
const SLOW_PTY_SPAWN_MS = 1000;

function resolveOptionalPtyModule() {
  for (const packageName of OPTIONAL_PTY_PACKAGES) {
    try {
      const mod = require(packageName);
      if (mod?.spawn) return mod;
    } catch {
      // Optional dependency; try the next known package.
    }
  }
  return null;
}

export function createNodePtyBackend({ ptyModule = null } = {}) {
  const pty = ptyModule || resolveOptionalPtyModule();
  if (!pty?.spawn) {
    throw new InteractiveCliUnavailableError(
      `Install one of ${OPTIONAL_PTY_PACKAGES.join(", ")} to enable interactive CLI sessions.`
    );
  }

  return {
    name: "node-pty",
    spawn(command, args = [], opts = {}) {
      const startedAt = Date.now();
      let proc;
      try {
        proc = pty.spawn(command, args, {
          name: opts.termName || "xterm-256color",
          cols: opts.cols || 120,
          rows: opts.rows || 40,
          cwd: opts.cwd || process.cwd(),
          env: opts.env || process.env,
        });
      } catch (err) {
        log.warn("provider", "Interactive CLI pty spawn failed", {
          backend: "node-pty",
          command,
          durationMs: Date.now() - startedAt,
          error: err?.message || String(err),
        });
        throw err;
      } finally {
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_PTY_SPAWN_MS) {
          log.warn("provider", "Interactive CLI pty spawn was slow", {
            backend: "node-pty",
            command,
            durationMs,
          });
        }
      }
      let resolveExit;
      const exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });
      const forgetTrackedProcess = trackSpawnedProcess(proc, command, {
        label: `interactive-cli:${command}`,
        cwd: opts.cwd || process.cwd(),
      });
      proc.onExit?.((event) => {
        forgetTrackedProcess();
        resolveExit({
          exitCode: event?.exitCode ?? null,
          signal: event?.signal ?? null,
        });
      });

      return {
        pid: Number.isFinite(proc.pid) ? proc.pid : null,
        onData(callback) {
          const disposable = proc.onData((data) => callback(String(data || "")));
          return () => disposable?.dispose?.();
        },
        write(data) {
          proc.write(String(data || ""));
        },
        resize(cols, rows) {
          try { proc.resize(cols, rows); } catch {}
        },
        kill() {
          try { proc.kill(); } catch {}
        },
        exitPromise,
      };
    },
  };
}

let defaultBackend = undefined;

export function getDefaultInteractiveCliBackend() {
  if (defaultBackend !== undefined) return defaultBackend;
  try {
    defaultBackend = createNodePtyBackend();
  } catch {
    defaultBackend = null;
  }
  return defaultBackend;
}

export function stripTerminalControls(text) {
  let value = String(text || "");
  value = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  value = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  value = value.replace(/\x1b[()][A-Za-z0-9]/g, "");
  value = value.replace(/\x1b[=>]/g, "");
  value = value.replace(/\r/g, "");
  while (/[^\n]\x08/.test(value)) {
    value = value.replace(/[^\n]\x08/g, "");
  }
  return value;
}
