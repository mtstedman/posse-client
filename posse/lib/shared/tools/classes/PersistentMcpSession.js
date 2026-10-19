import { spawn } from "node:child_process";
import {
  MCP_REQUEST_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  MCP_CONTROL_METHODS,
  MCP_TERMINAL_HANDOFF_TOOLS,
  MCP_TOOL_DEADLINE_MS,
  MCP_REQUEST_DEFERRED_NOTIFICATION,
  mcpToolDeadlineClass,
} from "../../../catalog/mcp.js";
import { stripPosseMcpGatewayPrefix } from "../../../domains/integrations/functions/mcp-gateway.js";
import {
  JSONL_STDOUT_BUFFER_MAX_BYTES,
  MCP_FRAME_TOO_LARGE_CODE,
  agentHandoffSchemaTelemetry,
  cloneJson,
  createSubAgentRoutingState,
  gatewayGateBindingKey,
  isPowershellClixmlProgressNoise,
  jsonlParseBuffer,
  mcpToolErrorPayload,
  ownerErrorSummary,
  toolsListCount,
  toolsListDigest,
  toolsListNames,
} from "../functions/mcp-owner-session-support.js";

const DEFAULT_REQUEST_TIMEOUT_MS = MCP_REQUEST_TIMEOUT_MS;
const MAX_OWNER_ATLAS_GATE_EVENTS = 64;
// A child that produces NO response across this many consecutive request
// timeouts is treated as wedged (event loop blocked, native deadlock) rather
// than merely slow, and is force-killed so the next request respawns it. Any
// response resets the counter, so a legitimately long single call does not
// trip it. The gateway is stateless per request, so respawn loses nothing.
const MAX_CONSECUTIVE_REQUEST_TIMEOUTS = 2;
// Minimum spacing between child (re)spawns. Without it, a server spec that
// crashes on startup turns every forwarded request into a fresh, heavy Node
// process spawn — a hot crash-loop. The shim already treats the resulting
// backoff error as a transient 5xx and retries.
const GATEWAY_RESTART_BACKOFF_MS = 2000;
const SESSION_TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000;
const TOKEN_CLOCK_SKEW_MS = 30 * 1000;
const SESSION_ORPHAN_TTL_MS = 8 * 60 * 60 * 1000;

export class PersistentMcpSession {
  /** @param {Record<string, any>} [options] */
  constructor({
    id,
    token,
    claims,
    bootConfig,
    serverSpec,
    agentOwned = false,
    spawnImpl = spawn,
  } = {}) {
    this.id = id;
    this.token = token;
    this.claims = claims || {};
    this.bootConfig = bootConfig || {};
    this.serverSpec = serverSpec || null;
    this.agentOwned = agentOwned === true;
    this._spawn = spawnImpl;
    this._proc = null;
    this._stdoutBuffer = Buffer.alloc(0);
    this._discardingOversizeFrame = false;
    this._pending = new Map();
    this._activeRequestId = null;
    this._controlSession = null;
    this._seq = 0;
    this._consecutiveTimeouts = 0;
    this._crashesSinceHealthy = 0;
    this.startedAt = null;
    this.lastExit = null;
    this.prewarmedAt = null;
    this.prewarmError = null;
    this._prewarmPromise = null;
    this.tokenVerified = !!claims?.__verified;
    this.tokenSource = claims?.__source || (this.tokenVerified ? "local" : "registered");
    const now = Date.now();
    this.registeredAt = now;
    this.updatedAt = now;
    this.lastSeenAt = now;
    this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : null;
    this.attachProof = this._newAttachProof();
    this._gatewayBindingEpoch = 1;
    this._atlasGateEventSeq = 0;
    this._atlasGateEvents = [];
    this._subAgentRouting = createSubAgentRoutingState();
    this._plannerTriage = null;
    this._atlasSymbolHandles = null;
    this._atlasPromotedTraversalRefs = new Set();
    this._activeToolRequests = new Map();
    this._toolRequestSequence = 0;
  }

  beginToolRequest(toolName) {
    const token = ++this._toolRequestSequence;
    const name = String(toolName || "unknown").slice(0, 160);
    const terminal = MCP_TERMINAL_HANDOFF_TOOLS.includes(name.replace(/^tools\./, ""));
    const entry = { name, terminal, conflicts: new Set() };
    for (const active of this._activeToolRequests.values()) {
      if (terminal && !active.terminal) entry.conflicts.add(active.name);
      if (!terminal && active.terminal) active.conflicts.add(name);
    }
    this._activeToolRequests.set(token, entry);
    return token;
  }

  toolRequestConflicts(token) {
    return [...(this._activeToolRequests.get(token)?.conflicts || [])];
  }

  endToolRequest(token) {
    return this._activeToolRequests.delete(token);
  }

  _newAttachProof() {
    return {
      initializeSeenAt: null,
      toolsListSeenAt: null,
      toolsListCount: null,
      toolsListNames: [],
      toolsListSha256: null,
      agentHandoffToolSchemaName: null,
      agentHandoffToolSchemaSha256: null,
      agentHandoffToolSchemaChars: null,
      firstToolCallSeenAt: null,
      firstToolName: null,
      requestCount: 0,
      lastRequestAt: null,
      lastMethod: null,
      lastOwnerError: null,
    };
  }

  /** @param {Record<string, any>} [options] */
  update({ token, claims, bootConfig, serverSpec, agentOwned = undefined } = {}) {
    if (token) this.token = token;
    if (claims) {
      this.claims = claims;
      this.tokenVerified = !!claims.__verified;
      this.tokenSource = claims.__source || (this.tokenVerified ? "local" : "registered");
      this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : this.expiresAt;
    }
    if (bootConfig) {
      const previousBindingKey = gatewayGateBindingKey(this.bootConfig, this.id);
      const nextBindingKey = gatewayGateBindingKey(bootConfig, this.id);
      this.bootConfig = bootConfig;
      if (previousBindingKey !== nextBindingKey) {
        this._gatewayBindingEpoch += 1;
        this._atlasGateEventSeq = 0;
        this._atlasGateEvents = [];
        this._subAgentRouting = createSubAgentRoutingState();
        this._plannerTriage = null;
        this._atlasSymbolHandles = null;
      }
    }
    if (serverSpec) this.serverSpec = serverSpec;
    if (agentOwned !== undefined && (agentOwned === true) !== this.agentOwned) {
      throw new Error("MCP session ownership cannot change after registration");
    }
    this.updatedAt = Date.now();
    this.attachProof = this._newAttachProof();
    this.touch();
  }

  touch(now = Date.now()) {
    this.lastSeenAt = now;
  }

  snapshotAttachProof() {
    return {
      initializeSeenAt: this.attachProof.initializeSeenAt || null,
      toolsListSeenAt: this.attachProof.toolsListSeenAt || null,
      toolsListCount: this.attachProof.toolsListCount ?? null,
      toolsListNames: Array.isArray(this.attachProof.toolsListNames)
        ? [...this.attachProof.toolsListNames]
        : [],
      toolsListSha256: this.attachProof.toolsListSha256 || null,
      agentHandoffToolSchemaName: this.attachProof.agentHandoffToolSchemaName || null,
      agentHandoffToolSchemaSha256: this.attachProof.agentHandoffToolSchemaSha256 || null,
      agentHandoffToolSchemaChars: this.attachProof.agentHandoffToolSchemaChars ?? null,
      firstToolCallSeenAt: this.attachProof.firstToolCallSeenAt || null,
      firstToolName: this.attachProof.firstToolName || null,
      requestCount: this.attachProof.requestCount || 0,
      lastRequestAt: this.attachProof.lastRequestAt || null,
      lastMethod: this.attachProof.lastMethod || null,
      lastOwnerError: this.attachProof.lastOwnerError || null,
    };
  }

  noteRequest(message = {}, now = Date.now()) {
    const method = String(message?.method || "").trim();
    this.attachProof.requestCount += 1;
    this.attachProof.lastRequestAt = now;
    this.attachProof.lastMethod = method || null;
    if (method === "initialize" && !this.attachProof.initializeSeenAt) {
      this.attachProof.initializeSeenAt = now;
      return "initialize";
    }
    if (method === "tools/call" && !this.attachProof.firstToolCallSeenAt) {
      this.attachProof.firstToolCallSeenAt = now;
      this.attachProof.firstToolName = String(message?.params?.name || "").trim() || null;
      return "tools/call";
    }
    return null;
  }

  noteToolsList(response = null, now = Date.now()) {
    const count = toolsListCount(response);
    const names = toolsListNames(response);
    const handoffSchema = agentHandoffSchemaTelemetry(response);
    this.attachProof.toolsListSeenAt = this.attachProof.toolsListSeenAt || now;
    this.attachProof.toolsListCount = count;
    this.attachProof.toolsListNames = names;
    this.attachProof.toolsListSha256 = toolsListDigest(names);
    this.attachProof.agentHandoffToolSchemaName = handoffSchema?.name || null;
    this.attachProof.agentHandoffToolSchemaSha256 = handoffSchema?.sha256 || null;
    this.attachProof.agentHandoffToolSchemaChars = handoffSchema?.chars ?? null;
    return count;
  }

  noteOwnerError(err, method = null, now = Date.now()) {
    this.attachProof.lastOwnerError = {
      at: now,
      method: method || this.attachProof.lastMethod || null,
      error: ownerErrorSummary(err),
    };
  }

  noteAtlasGateEvent({ action = "", args = {}, ok = false, empty = false } = {}) {
    const normalizedAction = String(action || "").trim();
    if (!normalizedAction) return;
    this._atlasGateEvents.push({
      seq: ++this._atlasGateEventSeq,
      action: normalizedAction,
      args: cloneJson(args && typeof args === "object" ? args : {}),
      ok: ok === true,
      empty: empty === true,
    });
    if (this._atlasGateEvents.length > MAX_OWNER_ATLAS_GATE_EVENTS) {
      this._atlasGateEvents.splice(0, this._atlasGateEvents.length - MAX_OWNER_ATLAS_GATE_EVENTS);
    }
  }

  atlasGateEventsSnapshot() {
    return cloneJson(this._atlasGateEvents) || [];
  }

  isExpired(now = Date.now()) {
    // Agent-owned registration follows the authoritative in-process Agent
    // lifecycle. Its bearer has a separate hard expiry at the RPC boundary
    // and is rotated before reuse, so pruning registration by token age here
    // would strand an otherwise reusable Agent before it can rotate.
    if (this.agentOwned) return false;
    const idleMs = now - (this.lastSeenAt || this.registeredAt || now);
    if (this.expiresAt && now > this.expiresAt + SESSION_TOKEN_EXPIRY_GRACE_MS) {
      return idleMs > SESSION_TOKEN_EXPIRY_GRACE_MS;
    }
    return idleMs > SESSION_ORPHAN_TTL_MS;
  }

  isTokenExpired(now = Date.now()) {
    return !!this.expiresAt && now > this.expiresAt + TOKEN_CLOCK_SKEW_MS;
  }

  _rejectPending(error) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
    this._activeRequestId = null;
  }

  ensureStarted() {
    if (this._proc && this._proc.exitCode == null) return;
    if (!this.serverSpec?.command) {
      throw new Error("MCP session has no registered server spec");
    }
    // Respawn backoff: a spec that crashes on startup would otherwise hot-loop
    // one heavy Node spawn per forwarded request. Allow the first respawn after
    // a crash immediately (a single restart is normal and several tests depend
    // on it), but once the child has died repeatedly without ever answering,
    // throttle spawns to one per backoff window. The crash counter resets on any
    // healthy response, so this only engages for a genuinely broken child.
    if (this._crashesSinceHealthy >= 2
      && this.lastExit?.at
      && Date.now() - this.lastExit.at < GATEWAY_RESTART_BACKOFF_MS) {
      const err = /** @type {Error & { code: string }} */ (
        new Error("MCP session restarting; backing off after repeated exits")
      );
      err.code = "GATEWAY_RESTART_BACKOFF";
      throw err;
    }
    const spec = this.serverSpec;
    const proc = this._spawn(spec.command, spec.args || [], {
      cwd: spec.cwd || process.cwd(),
      env: spec.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._proc = proc;
    this.startedAt = Date.now();
    this.lastExit = null;
    this._consecutiveTimeouts = 0;
    this._stdoutBuffer = Buffer.alloc(0);
    this._discardingOversizeFrame = false;
    let finished = false;
    const finish = ({ code = null, signal = null, error = null } = {}) => {
      if (finished || this._proc !== proc) return;
      finished = true;
      this.lastExit = {
        at: Date.now(),
        code,
        signal,
        ...(error ? { error: ownerErrorSummary(error) } : {}),
      };
      if (this._proc === proc) this._proc = null;
      this._crashesSinceHealthy += 1;
      this._prewarmPromise = null;
      this.prewarmedAt = null;
      const failure = error || new Error(`MCP session exited (${code ?? signal ?? "unknown"})`);
      this._rejectPending(failure);
    };
    const failStream = (error) => {
      finish({ error });
      try { proc.kill?.("SIGTERM"); } catch { /* best effort */ }
    };
    proc.stdin?.on?.("error", failStream);
    proc.stdout?.on("data", (chunk) => {
      if (this._proc !== proc) return;
      this._handleStdout(chunk);
    });
    proc.stdout?.on?.("error", failStream);
    proc.stderr?.on("data", (chunk) => {
      try {
        if (isPowershellClixmlProgressNoise(chunk)) return;
        process.stderr.write(`[posse-mcp-owner:${this.id}] ${chunk}`);
      } catch {
        // diagnostics only
      }
    });
    proc.stderr?.on?.("error", failStream);
    proc.once("error", (error) => finish({ error }));
    proc.once("exit", (code, signal) => finish({ code, signal }));
    for (const frame of Array.isArray(spec.startupFrames) ? spec.startupFrames : []) {
      this._write(frame);
    }
  }

  request(message = {}, { signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("MCP request aborted"));
    this.ensureStarted();
    const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    const outbound = cloneJson(message);
    if (id == null) {
      this._write(outbound);
      return Promise.resolve(null);
    }
    const internalId = `owner-${this.id}-${++this._seq}`;
    outbound.id = internalId;
    let onAbort;
    return new Promise((resolve, reject) => {
      this._pending.set(internalId, {
        originalId: id,
        resolve,
        reject,
        timer: null,
        outbound,
      });
      onAbort = () => {
        // A disconnected queued caller must never execute later. An already
        // running call retains its promise, watchdog and serial slot so the
        // owner processes its actual result instead of refunding active work
        // as a transport failure merely because the HTTP client disconnected.
        if (this._activeRequestId === internalId) return;
        clearTimeout(this._pending.get(internalId)?.timer);
        this._pending.delete(internalId);
        reject(signal.reason || new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this._startNextRequest();
    }).finally(() => signal?.removeEventListener("abort", onAbort));
  }

  requestControl(message, options = {}) {
    if (!MCP_CONTROL_METHODS.includes(message?.method)) throw new Error("MCP control child only accepts handshake methods");
    this._controlSession ||= new PersistentMcpSession({
      id: `${this.id}-control`, token: this.token, claims: this.claims,
      bootConfig: this.bootConfig, serverSpec: this.serverSpec, spawnImpl: this._spawn,
    });
    this._controlSession.update({ serverSpec: this.serverSpec });
    return this._controlSession.request(message, options);
  }

  _startNextRequest() {
    if (this._activeRequestId) return;
    const next = [...this._pending.entries()].find(([, queued]) => !queued.deferred);
    if (!next) return;
    const [id, entry] = next;
    this._activeRequestId = id;
    const tool = stripPosseMcpGatewayPrefix(entry.outbound?.params?.name);
    // A tool's registered deadline may extend the default watchdog, never
    // shorten it.
    const timeoutMs = Math.max(
      DEFAULT_REQUEST_TIMEOUT_MS,
      MCP_TOOL_DEADLINE_MS[mcpToolDeadlineClass(tool)] || 0,
    );
    const onTimeout = () => {
      if (entry.deferred) {
        // The child answered by parking this call, so it is not wedged; the
        // caller's deadline simply passed.
        this._pending.delete(id);
        entry.reject(new Error(`MCP session request timed out after ${timeoutMs}ms`));
        return;
      }
      // Retain the active entry after rejecting its caller: a late response
      // releases the serial child and resets the watchdog. Queued requests
      // cannot create additional strikes against that same slow operation.
      this._consecutiveTimeouts += 1;
      entry.reject(new Error(`MCP session request timed out after ${timeoutMs}ms`));
      if (this._consecutiveTimeouts >= MAX_CONSECUTIVE_REQUEST_TIMEOUTS) {
        this.stop({ force: true });
        return;
      }
      entry.timer = setTimeout(onTimeout, timeoutMs);
      entry.timer.unref?.();
    };
    entry.timer = setTimeout(onTimeout, timeoutMs);
    entry.timer.unref?.();
    try {
      this._write(entry.outbound);
    } catch (err) {
      clearTimeout(entry.timer);
      this._pending.delete(id);
      this._activeRequestId = null;
      entry.reject(err);
      this._startNextRequest();
    }
  }

  notify(message = {}) {
    if (!this._proc || this._proc.exitCode != null || this._proc.killed) return false;
    const outbound = cloneJson(message);
    if (outbound && typeof outbound === "object") delete outbound.id;
    try {
      this._write(outbound);
      return true;
    } catch {
      return false;
    }
  }

  prewarm() {
    if (this._prewarmPromise) return this._prewarmPromise;
    this._prewarmPromise = (async () => {
      this.ensureStarted();
      await this.request({
        jsonrpc: "2.0",
        id: "owner-prewarm-init",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "posse-mcp-owner", version: "1.0.0" },
        },
      });
      await this.request({
        jsonrpc: "2.0",
        id: "owner-prewarm-tools",
        method: "tools/list",
        params: {},
      });
      this.prewarmedAt = Date.now();
      this.prewarmError = null;
      return true;
    })().catch((err) => {
      this.prewarmError = String(err?.message || err);
      this._prewarmPromise = null;
      throw err;
    });
    return this._prewarmPromise;
  }

  _write(message) {
    if (!this._proc?.stdin || this._proc.stdin.destroyed) {
      throw new Error("MCP session stdin is closed");
    }
    this._proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  _handleStdout(chunk) {
    let incoming = Buffer.from(chunk);
    if (this._discardingOversizeFrame) {
      // The rest of a frame already answered as too large.
      const newlineIdx = incoming.indexOf(0x0a);
      if (newlineIdx < 0) return;
      incoming = incoming.subarray(newlineIdx + 1);
      this._discardingOversizeFrame = false;
    }
    this._stdoutBuffer = Buffer.concat([this._stdoutBuffer, incoming]);
    this._stdoutBuffer = jsonlParseBuffer(
      this._stdoutBuffer,
      (message) => this._handleMessage(message),
      {
        onParseError: (err) => {
          try {
            process.stderr.write(`[posse-mcp-owner:${this.id}] failed to parse session stdout: ${err?.message || err}\n`);
          } catch {
            // diagnostics only
          }
          if (err?.code !== MCP_FRAME_TOO_LARGE_CODE) return;
          if (err.partialFrame) this._discardingOversizeFrame = true;
          this._answerActiveRequestWithOversizeReply();
        },
      },
    );
  }

  // The serial child has one request in flight, so an oversized frame is its
  // reply. Answer it now; waiting for the watchdog would strike the child and
  // eventually kill it for a request it already finished.
  _answerActiveRequestWithOversizeReply() {
    const id = this._activeRequestId;
    const entry = id ? this._pending.get(id) : null;
    if (!entry) return;
    const text = `The tool result exceeded the ${JSONL_STDOUT_BUFFER_MAX_BYTES} byte transport limit and was discarded. Request a narrower range or a smaller file.`;
    this._handleMessage(entry.outbound?.method === "tools/call"
      ? { jsonrpc: "2.0", id, result: mcpToolErrorPayload(text, { code: "result_too_large", message: text }) }
      : { jsonrpc: "2.0", id, error: { code: -32603, message: text } });
  }

  _handleMessage(message) {
    if (message?.method === MCP_REQUEST_DEFERRED_NOTIFICATION) {
      this._deferActiveRequest(message.params?.id);
      return;
    }
    const id = String(message?.id ?? "");
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id);
    if (this._activeRequestId === id) this._activeRequestId = null;
    clearTimeout(entry.timer);
    // The child answered — it is alive and responsive, so clear any accumulated
    // timeout strikes and crash-loop history.
    this._consecutiveTimeouts = 0;
    this._crashesSinceHealthy = 0;
    const restored = { ...message, id: entry.originalId };
    entry.resolve(restored);
    this._startNextRequest();
  }

  // The child parked the active call on a human answer and keeps serving other
  // sessions meanwhile. Free the serial slot; the parked call keeps its own
  // deadline and resolves when its response arrives.
  _deferActiveRequest(requestId) {
    const id = String(requestId ?? "");
    const entry = id && this._activeRequestId === id ? this._pending.get(id) : null;
    if (!entry) return;
    entry.deferred = true;
    this._activeRequestId = null;
    this._consecutiveTimeouts = 0;
    this._startNextRequest();
  }

  stop({ force = false } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null || proc.killed) return false;
    if (process.platform === "win32") {
      try {
        const args = ["/pid", String(proc.pid), "/T"];
        if (force) args.push("/F");
        const killer = this._spawn("taskkill", args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref?.();
        return true;
      } catch {
        // Fall through to the direct child kill.
      }
    }
    try {
      proc.kill(force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  close({ force = false, timeoutMs = 10000 } = {}) {
    return Promise.all([
      this._closeProcess({ force, timeoutMs }),
      this._controlSession?.close({ force, timeoutMs }),
    ]).then(([closed]) => closed);
  }

  _closeProcess({ force = false, timeoutMs = 10000 } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let procExited = false;
      let treeKillFinished = process.platform !== "win32";
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const maybeDone = () => {
        if (procExited && treeKillFinished) done(true);
      };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
        done(false);
      }, Math.max(100, Number(timeoutMs) || 10000));
      timer.unref?.();
      proc.once("exit", () => {
        procExited = true;
        maybeDone();
      });
      try {
        if (process.platform === "win32") {
          const args = ["/pid", String(proc.pid), "/T"];
          if (force) args.push("/F");
          const killer = this._spawn("taskkill", args, {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("close", (code) => {
            treeKillFinished = true;
            if (code !== 0 && !procExited) {
              try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { done(false); }
            }
            maybeDone();
          });
          killer.once("error", () => {
            treeKillFinished = true;
            try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { done(false); }
            maybeDone();
          });
        } else {
          proc.kill(force ? "SIGKILL" : "SIGTERM");
        }
      } catch {
        done(false);
      }
    });
  }
}
