import { spawn } from "node:child_process";

import {
  PROVIDER_DISPATCH_MAX_EVENT_BYTES,
  PROVIDER_DISPATCH_EVENTS,
  PROVIDER_DISPATCH_MAX_START_BYTES,
  PROVIDER_DISPATCH_PROTOCOL,
  PROVIDER_DISPATCH_PROVIDERS,
} from "../../../catalog/binary.js";
import { buildRuntimeEnv } from "../../../domains/runtime/functions/paths.js";
import { scrubClaudeChildEnv } from "../../../domains/providers/functions/claude/child-env.js";
import {
  terminateSpawnedProcessTree,
  trackSpawnedProcess,
} from "../../platform/functions/spawned-process.js";
import { nativeBinaries } from "../../tools/classes/BinaryManager.js";
import {
  ProviderDispatchGateway,
  providerDispatchSurfaceDigest,
} from "../../tools/classes/ProviderDispatchGateway.js";
import { verifyProviderDispatchCapabilitiesSync } from "./engagement-client.js";

const MAX_STDERR_BYTES = 64 * 1024;
const CANCEL_GRACE_MS = 2_000;
const FORCE_KILL_GRACE_MS = 1_000;
const TERMINAL_EVENTS = new Set([
  "dispatch.completed",
  "dispatch.failed",
  "dispatch.cancelled",
]);
const EVENT_TYPES = new Set(PROVIDER_DISPATCH_EVENTS);

export class ProviderDispatchError extends Error {
  constructor(message, { code = "provider_dispatch_failed", classification = "native_protocol", details = null } = {}) {
    super(message);
    this.name = "ProviderDispatchError";
    this.code = code;
    this.classification = classification;
    this.details = details;
  }
}

function protocolError(message, details = null) {
  return new ProviderDispatchError(message, {
    code: "provider_dispatch_protocol",
    classification: "native_protocol",
    details,
  });
}

function cancellationError(frame = null) {
  const error = new ProviderDispatchError("Provider dispatch was cancelled", {
    code: "provider_dispatch_cancelled",
    classification: "cancelled",
    details: frame,
  });
  error.name = "AbortError";
  return error;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateStart(request, allowTestAdapter) {
  if (!isObject(request)) throw protocolError("Provider dispatch request must be an object");
  if (typeof request.id !== "string" || !request.id) throw protocolError("Provider dispatch requires an id");
  if (!PROVIDER_DISPATCH_PROVIDERS.includes(request.provider)
    && !(allowTestAdapter && request.provider === "fake")) {
    throw protocolError(`Unsupported provider dispatch adapter: ${String(request.provider || "<missing>")}`);
  }
}

function resultFromTerminal(frame) {
  if (frame.type === "dispatch.completed") {
    if (typeof frame.output !== "string" || !isObject(frame.stats)) {
      throw protocolError("Provider dispatch completion is malformed", frame);
    }
    return {
      output: frame.output,
      stats: frame.stats,
      sessionHandle: frame.sessionHandle ?? null,
    };
  }
  if (frame.type === "dispatch.cancelled") throw cancellationError(frame);
  const nativeError = isObject(frame.error) ? frame.error : {};
  throw new ProviderDispatchError(
    typeof nativeError.message === "string" && nativeError.message
      ? nativeError.message
      : "Provider dispatch failed",
    {
      code: typeof nativeError.code === "string" ? nativeError.code : "provider_dispatch_failed",
      classification: typeof nativeError.class === "string" ? nativeError.class : "provider_failure",
      details: {
        partialOutput: frame.partialOutput ?? null,
        stats: frame.stats ?? null,
      },
    },
  );
}

/**
 * Run one provider turn through posse-remote's universal streaming boundary.
 * Provider-specific argv, parsing, retry, and session logic do not belong here.
 */
export async function dispatchProvider(request, {
  manager = nativeBinaries,
  spawnImpl = spawn,
  signal = null,
  onEvent = null,
  projectDir = null,
  verifyCapabilities = true,
  cancelGraceMs = CANCEL_GRACE_MS,
  forceKillGraceMs = FORCE_KILL_GRACE_MS,
  allowTestAdapter = false,
  mcpGate = null,
  baseEnv = process.env,
} = {}) {
  validateStart(request, allowTestAdapter);
  if (signal?.aborted) throw cancellationError();
  if (!manager.shouldUse("remote")) {
    throw new ProviderDispatchError("posse-remote is unavailable", {
      code: "provider_dispatch_unavailable",
      classification: "provider_unavailable",
    });
  }
  const dispatchCapabilities = verifyCapabilities
    ? verifyProviderDispatchCapabilitiesSync(request.provider, { manager })
    : null;
  const expectedAdapterVersion = dispatchCapabilities?.adapterVersions?.[request.provider] || null;

  const binary = manager.binary("remote");
  const binaryPath = binary.resolvePath();
  if (!binaryPath) {
    throw new ProviderDispatchError("posse-remote has no resolved executable", {
      code: "provider_dispatch_unavailable",
      classification: "provider_unavailable",
    });
  }
  if (request.gateway != null) {
    throw protocolError("Provider dispatch gateway capabilities must be minted by the native client");
  }
  const issuedToolIds = request.execution?.issuedToolIds;
  if (!Array.isArray(issuedToolIds)) throw protocolError("Provider dispatch requires issued tool ids");
  let toolGateway = null;
  let gateway = null;
  let observedSurfaceDigest = providerDispatchSurfaceDigest([]);
  if (issuedToolIds.length > 0) {
    try {
      toolGateway = new ProviderDispatchGateway({
        dispatchId: request.id,
        issuedToolIds,
        surfaceDigest: request.execution?.issuedToolSurfaceDigest || null,
        mcpGate,
        leaseTtlMs: Number(request.limits?.wallTimeoutMs || 0) + cancelGraceMs + forceKillGraceMs + 5_000,
      });
      ({ digest: observedSurfaceDigest } = await toolGateway.prepareSurface());
      gateway = await toolGateway.start();
    } catch (error) {
      throw new ProviderDispatchError(`Could not start provider tool gateway: ${error?.message || error}`, {
        code: "provider_tool_gateway_unavailable",
        classification: "gateway_tool_failure",
      });
    }
  } else {
    const declaredDigest = String(request.execution?.issuedToolSurfaceDigest || "")
      .replace(/^sha256:/, "")
      .toLowerCase();
    if (declaredDigest && declaredDigest !== observedSurfaceDigest) {
      throw protocolError("Provider dispatch empty tool surface does not match its digest");
    }
  }
  request = {
    ...request,
    execution: {
      ...request.execution,
      issuedToolSurfaceDigest: observedSurfaceDigest,
    },
  };
  const start = { ...request, gateway, protocol: PROVIDER_DISPATCH_PROTOCOL, type: "start" };
  const encodedStart = Buffer.from(`${JSON.stringify(start)}\n`, "utf8");
  if (encodedStart.length > PROVIDER_DISPATCH_MAX_START_BYTES) {
    await toolGateway?.close();
    throw protocolError("Provider dispatch request exceeds its size limit");
  }

  const processGroup = process.platform !== "win32";
  const childEnv = buildRuntimeEnv(projectDir || request.scope?.cwd, request.scope?.cwd, baseEnv);
  if (request.provider === "claude") scrubClaudeChildEnv(childEnv);
  let proc;
  try {
    proc = spawnImpl(binaryPath, ["engagement", "dispatch", "--stdio"], {
      cwd: request.scope?.cwd,
      env: childEnv,
      detached: processGroup,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await toolGateway?.close();
    throw new ProviderDispatchError(`Could not start provider dispatch: ${error?.message || error}`, {
      code: "provider_dispatch_spawn_failed",
      classification: "provider_unavailable",
    });
  }
  if (!proc?.stdin || !proc?.stdout || !proc?.stderr) {
    terminateSpawnedProcessTree(proc, { force: true, processGroup });
    await toolGateway?.close();
    throw protocolError("Provider dispatch process has no stdio streams");
  }
  const forget = trackSpawnedProcess(proc, binaryPath, {
    kind: "provider-dispatch",
    dispatchId: request.id,
    provider: request.provider,
    processGroup,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let expectedSequence = 1;
    let sawStarted = false;
    let terminal = null;
    let pending = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let cancelSent = false;
    let cancelTimer = null;
    let forceTimer = null;

    const clearTimers = () => {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const cleanup = () => {
      clearTimers();
      signal?.removeEventListener?.("abort", abort);
      forget();
      void toolGateway?.close();
    };
    const finishReject = (error, kill = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill) {
        terminateSpawnedProcessTree(proc, { force: false, processGroup });
        const timer = setTimeout(
          () => terminateSpawnedProcessTree(proc, { force: true, processGroup }),
          forceKillGraceMs,
        );
        timer.unref?.();
      }
      reject(error);
    };
    const abort = () => {
      if (settled || cancelSent) return;
      cancelSent = true;
      try {
        proc.stdin.write(`${JSON.stringify({
          protocol: PROVIDER_DISPATCH_PROTOCOL,
          type: "cancel",
          id: request.id,
          reason: "user_abort",
        })}\n`);
      } catch (error) {
        finishReject(cancellationError(), true);
        return;
      }
      cancelTimer = setTimeout(() => {
        terminateSpawnedProcessTree(proc, { force: false, processGroup });
        forceTimer = setTimeout(
          () => terminateSpawnedProcessTree(proc, { force: true, processGroup }),
          forceKillGraceMs,
        );
        forceTimer.unref?.();
      }, cancelGraceMs);
      cancelTimer.unref?.();
    };
    const consumeFrame = (line) => {
      if (terminal) throw protocolError("Provider dispatch emitted an event after its terminal event");
      let frame;
      try {
        frame = JSON.parse(line.toString("utf8"));
      } catch {
        throw protocolError("Provider dispatch emitted invalid JSON");
      }
      if (!isObject(frame)
        || frame.protocol !== PROVIDER_DISPATCH_PROTOCOL
        || frame.id !== request.id
        || frame.sequence !== expectedSequence
        || !EVENT_TYPES.has(frame.type)) {
        throw protocolError("Provider dispatch emitted an invalid or out-of-order event", frame);
      }
      if (!sawStarted && frame.type !== "dispatch.started") {
        throw protocolError("Provider dispatch emitted an event before dispatch.started", frame);
      }
      if (sawStarted && frame.type === "dispatch.started") {
        throw protocolError("Provider dispatch emitted dispatch.started more than once", frame);
      }
      if (frame.type === "dispatch.started"
        && (frame.provider !== request.provider
          || typeof frame.adapterVersion !== "string"
          || !frame.adapterVersion
          || (expectedAdapterVersion && frame.adapterVersion !== expectedAdapterVersion))) {
        throw protocolError("Provider dispatch started with the wrong adapter identity", frame);
      }
      if (frame.type === "surface.attested"
        && (frame.expectedDigest !== request.execution?.issuedToolSurfaceDigest
          || frame.observedDigest !== frame.expectedDigest)) {
        throw protocolError("Provider dispatch reported a tool-surface mismatch", frame);
      }
      expectedSequence += 1;
      sawStarted = true;
      onEvent?.(frame);
      if (TERMINAL_EVENTS.has(frame.type)) {
        terminal = frame;
        proc.stdin.end();
      }
    };

    proc.stdout.on("data", (chunk) => {
      if (settled) return;
      try {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        let newline;
        while ((newline = pending.indexOf(0x0a)) !== -1) {
          let line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
          if (line.length === 0) continue;
          if (line.length > PROVIDER_DISPATCH_MAX_EVENT_BYTES) throw protocolError("Provider dispatch event exceeds its size limit");
          consumeFrame(line);
        }
        if (pending.length > PROVIDER_DISPATCH_MAX_EVENT_BYTES) throw protocolError("Provider dispatch event exceeds its size limit");
      } catch (error) {
        finishReject(error instanceof Error ? error : protocolError(String(error)), true);
      }
    });
    proc.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderr.length;
      stderr = Buffer.concat([stderr, Buffer.from(chunk).subarray(0, remaining)]);
    });
    proc.once("error", (error) => {
      finishReject(new ProviderDispatchError(`Could not start provider dispatch: ${error.message}`, {
        code: "provider_dispatch_spawn_failed",
        classification: "provider_unavailable",
      }));
    });
    proc.once("close", (code, closeSignal) => {
      if (settled) return;
      if (pending.length > 0) {
        finishReject(protocolError("Provider dispatch exited with an incomplete event"));
        return;
      }
      if (!terminal) {
        const diagnostic = stderr.toString("utf8").trim();
        finishReject(protocolError(
          `Provider dispatch exited without a terminal event${diagnostic ? `: ${diagnostic}` : ""}`,
          { code, signal: closeSignal },
        ));
        return;
      }
      if (code !== 0) {
        finishReject(protocolError("Provider dispatch exited unsuccessfully after its terminal event", { code, signal: closeSignal }));
        return;
      }
      settled = true;
      cleanup();
      try {
        resolve(resultFromTerminal(terminal));
      } catch (error) {
        reject(error);
      }
    });
    signal?.addEventListener?.("abort", abort, { once: true });
    proc.stdin.on("error", (error) => {
      if (!settled && !terminal) finishReject(protocolError(`Provider dispatch stdin failed: ${error.message}`), true);
    });
    proc.stdin.write(encodedStart, (error) => {
      if (error) finishReject(protocolError(`Provider dispatch start write failed: ${error.message}`), true);
    });
  });
}
