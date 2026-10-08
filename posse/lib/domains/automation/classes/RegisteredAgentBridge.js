import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AGENT_NAME_PATTERN, AGENT_SESSION_PATTERN, AGENT_TURN_PROTOCOL } from "../../../catalog/agent.js";
import { REGISTERED_AGENT_MAX_CONTEXT_BYTES, REGISTERED_AGENT_MAX_REPLY_BYTES, REGISTERED_AGENT_OPERATIONS, REGISTERED_AGENT_PROTOCOL } from "../../../catalog/registered-agent.js";
import { automationDataDir } from "../functions/paths.js";
import { approveEntry, assertRegisteredCapability } from "../functions/registered-trust.js";
import { demand, digest, object, schemaCheck } from "../functions/policy.js";

const REGISTRATIONS = "registered_clients";
const ID = /^[a-z][a-z0-9._-]{0,63}$/;
const KEY = /^[a-zA-Z0-9._:-]{1,120}$/;
const TERMINAL = new Set(["done", "failed", "needs_confirmation"]);
const RECEIPT_CONTENT_MS = 30 * 24 * 60 * 60 * 1000;
const CHAT_CONTENT_MS = 90 * 24 * 60 * 60 * 1000;
const TRANSIENT_BUSY_CODES = new Set(["agent_session_busy", "agent_request_busy"]);

function cachedTransientBusy(receipt) {
  return receipt.status === "failed" && receipt.response?.status === "failed"
    && TRANSIENT_BUSY_CODES.has(receipt.response?.error?.code);
}

function secret() { return crypto.randomBytes(32).toString("base64url"); }
function verifier(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function same(left, right) {
  const a = Buffer.from(String(left || "")), b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function failure(code, message = "Registered agent request failed") {
  return { protocol: AGENT_TURN_PROTOCOL, agent: "", agent_digest: "", conversation_id: "", turn_id: "",
    status: "failed", reply: "", tool_calls: [], pending: [], usage: null, error: { code, message } };
}
function safeResult(result, receipt) {
  const allowedErrors = new Set(["agent_session_busy", "agent_request_busy", "idempotency_conflict", "agent_confirmation_required", "agent_budget_exceeded", "forbidden", "grant_changed", "capability_unavailable", "owner_unavailable", "external_outcome_unknown", "usage_unknown"]);
  const status = TERMINAL.has(result?.status) ? result.status : "failed";
  const projected = {
    protocol: AGENT_TURN_PROTOCOL, agent: receipt.agent, agent_digest: receipt.agent_digest,
    conversation_id: receipt.session_id,
    turn_id: typeof result?.turn_id === "string" ? result.turn_id : "", status,
    reply: status === "done" && typeof result?.reply === "string" ? result.reply : "",
    tool_calls: Array.isArray(result?.tool_calls) ? result.tool_calls.slice(0, 256).map(call => ({
      tool: String(call.tool || "").slice(0, 120), status: String(call.status || "").slice(0, 32),
      effect: String(call.effect || "").slice(0, 32), duration_ms: Number(call.duration_ms) || 0,
    })) : [],
    pending: status === "needs_confirmation" ? [{ summary: "Operator confirmation is required" }] : [],
    usage: result?.usage && typeof result.usage === "object" ? Object.fromEntries(
      ["turns", "calls", "cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
        "uncached_input_tokens", "billable_input_tokens", "billable_output_tokens", "billable_tokens"]
        .map(key => [key, Number.isFinite(result.usage[key]) ? result.usage[key] : null])) : null,
    error: status === "failed" ? { code: allowedErrors.has(result?.error?.code) ? result.error.code : "agent_error",
      message: allowedErrors.has(result?.error?.code) ? String(result.error.message || "Agent request failed").slice(0, 240) : "Agent request failed" } : null,
  };
  if (Array.isArray(result?.tool_summary)) {
    projected.tool_summary = result.tool_summary.slice(0, 64).map(item => ({
      tool: String(item.tool || "").slice(0, 120), status: String(item.status || "").slice(0, 32),
      effect: String(item.effect || "").slice(0, 32), duration_ms: Number(item.duration_ms) || 0,
      result: item.result ?? null, result_truncated: item.result_truncated === true,
      ...(item.error_code ? { error_code: String(item.error_code).slice(0, 64) } : {}),
    }));
    projected.tool_summary_omitted = result.tool_summary.length - projected.tool_summary.length;
    while (projected.tool_summary.length && Buffer.byteLength(JSON.stringify(projected)) > REGISTERED_AGENT_MAX_REPLY_BYTES) {
      projected.tool_summary.pop();
      projected.tool_summary_omitted++;
    }
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > REGISTERED_AGENT_MAX_REPLY_BYTES) return failure("response_too_large", "Agent response exceeded the public limit");
  return projected;
}

export class RegisteredAgentBridge {
  constructor(owner) { this.owner = owner; this.store = owner.store; this.active = new Map(); this.stopping = false; this.failedAuth = []; this.lastMaintenance = 0; }

  create({ id, agents, operations = ["chat"], context_names = [], max_concurrency = 4, max_spend_usd = 100 }) {
    demand(ID.test(String(id || "")), "Invalid registration ID", "invalid_request");
    demand(Array.isArray(agents) && agents.length && agents.every(name => AGENT_NAME_PATTERN.test(name)), "Invalid agent allowlist", "invalid_request");
    demand(Array.isArray(operations) && operations.length && operations.every(op => REGISTERED_AGENT_OPERATIONS.includes(op)), "Invalid operations", "invalid_request");
    demand(Array.isArray(context_names) && context_names.every(name => typeof name === "string" && ID.test(name)), "Invalid context allowlist", "invalid_request");
    demand(Number.isInteger(max_concurrency) && max_concurrency >= 1 && max_concurrency <= 32, "Invalid concurrency limit", "invalid_request");
    demand(Number.isFinite(max_spend_usd) && max_spend_usd > 0 && max_spend_usd <= 10000, "Invalid spend limit", "invalid_request");
    const skillPins = {};
    for (const agent of agents) {
      const loaded = this.validateAgent(agent);
      skillPins[agent] = loaded.definition.skills.map(reference => {
        const skill = this.owner.agents.resolveSkill(loaded.definition, reference);
        const identity = this.owner.registry.identity(skill);
        const entry = this.store.get("entries", this.owner.registry.entryID(skill));
        return { reference: identity, digest: entry.digest };
      });
    }
    const credential = secret();
    const registration = this.store.transaction(() => {
      demand(!this.store.get(REGISTRATIONS, id), "Registration ID already exists", "idempotency_conflict");
      const value = { id, identity: crypto.randomUUID(), revision: 1, enabled: true, credential_hash: verifier(credential),
        agents: [...new Set(agents)], skill_pins: skillPins, operations: [...new Set(operations)], context_names: [...new Set(context_names)],
        max_concurrency, max_spend_usd, created_at: new Date().toISOString(), revoked_at: null };
      this.store.put(REGISTRATIONS, id, value); return value;
    });
    return { registration: this.publicRegistration(registration), credential };
  }

  rotate(id) {
    const credential = secret();
    const registration = this.store.transaction(() => {
      const value = this.store.get(REGISTRATIONS, id);
      demand(value?.enabled, "Registration unavailable", "forbidden");
      value.credential_hash = verifier(credential); value.revision++;
      this.store.put(REGISTRATIONS, id, value); return value;
    });
    return { registration: this.publicRegistration(registration), credential };
  }

  extendForExposure(id, agent, operations, contextNames) {
    const registration = this.store.get(REGISTRATIONS, id);
    demand(registration?.enabled && !registration.local_only && registration.agents.length === 1
      && registration.agents[0] === agent && this.owner.exposures.list().some(item => item.id === `${agent}:${id}`),
    "Named client can only be extended after its single-agent exposure is staged", "forbidden");
    demand(Array.isArray(operations) && operations.every(op => REGISTERED_AGENT_OPERATIONS.includes(op))
      && Array.isArray(contextNames) && contextNames.every(name => ID.test(name)),
    "Invalid client extension", "invalid_request");
    registration.operations = [...new Set([...registration.operations, ...operations])];
    registration.context_names = [...new Set([...registration.context_names, ...contextNames])];
    registration.revision++;
    this.store.put(REGISTRATIONS, id, registration);
    this.cancel(registration.identity);
    return this.publicRegistration(registration);
  }

  revoke(id) {
    const registration = this.store.get(REGISTRATIONS, id);
    demand(registration, "Registration unavailable", "forbidden");
    registration.enabled = false; registration.revoked_at = new Date().toISOString(); registration.revision++;
    this.store.put(REGISTRATIONS, id, registration);
    this.cancel(registration.identity);
    return this.publicRegistration(registration);
  }

  cancel(clientID = null) {
    for (const active of this.active.values()) if (!clientID || active.clientID === clientID) active.controller.abort();
  }

  async shutdown() {
    this.stopping = true; this.cancel();
    await Promise.allSettled([...this.active.values()].map(active => active.promise));
  }

  maintain(now = Date.now()) {
    if (now - this.lastMaintenance < 60 * 60 * 1000) return;
    this.lastMaintenance = now;
    for (const receipt of this.store.registeredReceipts()) {
      if (receipt.response && Date.parse(receipt.completed_at || receipt.created_at) < now - RECEIPT_CONTENT_MS) {
        delete receipt.response;
        this.store.putRegisteredReceipt(receipt.key, receipt);
      }
    }
    for (const session of this.store.list("agent_sessions")) {
      if (session.ownership?.kind !== "registered_chat" || session.status !== "idle"
        || Date.parse(session.updated_at) >= now - CHAT_CONTENT_MS) continue;
      this.store.transaction(() => {
        this.store.put("registered_session_tombstones", session.id, { client_id: session.ownership.client_id,
          agent: session.agent, expired_at: new Date(now).toISOString() });
        this.store.remove("agent_sessions", session.id);
      });
    }
    for (const access of this.store.list("registered_access_audit"))
      if (Date.parse(access.last_at) < now - CHAT_CONTENT_MS) this.store.remove("registered_access_audit", access.id);
  }

  publicRegistration(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "credential_hash")); }

  approve(args) { const result = approveEntry(this.store, args); this.cancel(); return result; }

  authenticate(request) {
    const now = Date.now();
    this.failedAuth = this.failedAuth.filter(time => time > now - 60_000);
    demand(this.failedAuth.length < 100, "Registration authentication is throttled", "unauthorized");
    const registration = this.store.get(REGISTRATIONS, request.client_id);
    if (!registration?.enabled || registration.local_only || !same(registration.credential_hash, verifier(String(request.credential || "")))) {
      this.failedAuth.push(now);
      demand(false, "Registration authentication failed", "unauthorized");
    }
    demand(registration.agents.includes(request.agent) && registration.operations.includes(request.operation),
      "Agent or operation is unavailable to this registration", "forbidden");
    return registration;
  }

  validateAgent(name, skillPins = null) {
    const loaded = this.owner.agentDefinitions.load(name);
    const definition = skillPins ? {
      ...loaded.definition,
      skills: skillPins.map(pin => {
        const skill = this.owner.agents.resolveSkill(loaded.definition, pin.reference);
        const entry = this.store.get("entries", this.owner.registry.entryID(skill));
        demand(entry?.digest === pin.digest, `Pinned skill ${pin.reference} changed`, "skill_unavailable");
        return pin.reference;
      }),
    } : loaded.definition;
    demand(["sandbox", "folder", "repository"].includes(definition.scope.kind), "Global agents cannot be exposed", "forbidden");
    // Capability validation is repeated for each request; this catches missing approvals at exposure time.
    const promptNames = definition.tools.filter(tool => this.store.get("prompt_tools", tool));
    const supplied = promptNames.map(name => ({ name, result: {} }));
    const execution = { definition, check() {} };
    const resolved = this.owner.agents.resolveCapabilities(definition, supplied, execution);
    this.owner.agents.privateInputSchema(definition);
    demand(definition.autonomy.write_tools !== "confirm" || !resolved.capabilities.some(cap => cap.effect === "write"),
      "Write tools under confirmation cannot be exposed", "forbidden");
    return { ...loaded, definition };
  }

  cwd(definition, registration, sessionID) {
    if (definition.scope.kind === "folder") return fs.realpathSync(definition.scope.folder_path);
    if (definition.scope.kind === "repository") {
      const mapping = this.store.get("repositories", definition.scope.repo_id);
      demand(mapping?.root, "Repository root mapping is required", "agent_scope_mismatch");
      return fs.realpathSync(mapping.root);
    }
    const root = path.join(automationDataDir(), "registered-agent-workspaces", registration.identity, sessionID);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return fs.realpathSync(root);
  }

  validateRequest(request, local = false) {
    object(request, ["protocol", "client_id", "credential", "request_id", "operation", "agent", "session", "idempotency_key", "request"],
      local ? ["protocol", "operation", "agent", "idempotency_key", "request"]
        : ["protocol", "client_id", "credential", "operation", "agent", "idempotency_key", "request"]);
    demand(request.protocol === REGISTERED_AGENT_PROTOCOL && REGISTERED_AGENT_OPERATIONS.includes(request.operation), "Unsupported registered agent protocol", "invalid_request");
    demand(request.request_id === undefined || typeof request.request_id === "string" && request.request_id.length <= 120, "Invalid request ID", "invalid_request");
    demand((local && request.client_id === undefined && request.credential === undefined
      || local && typeof request.client_id === "string" && ID.test(request.client_id)
        && (request.credential === undefined || typeof request.credential === "string")
      || !local && typeof request.client_id === "string" && ID.test(request.client_id) && typeof request.credential === "string")
      && typeof request.agent === "string" && AGENT_NAME_PATTERN.test(request.agent), "Invalid registration or agent", "invalid_request");
    demand(typeof request.idempotency_key === "string" && KEY.test(request.idempotency_key), "Idempotency key is required", "invalid_request");
    demand(request.operation === "chat" || !Object.hasOwn(request, "session"), "One-shot runs cannot resume a session", "invalid_request");
    demand(!Object.hasOwn(request, "session") || typeof request.session === "string" && AGENT_SESSION_PATTERN.test(request.session),
      "Invalid session selector", "agent_session_invalid");
    object(request.request, ["message", "bootstrap_message", "pre_run_context", "inputs", "include_tool_summary"], ["message"]);
    demand(typeof request.request.message === "string" && request.request.message.trim() && request.request.message.length <= 200000,
      "Message is required", "invalid_request");
    demand(request.request.bootstrap_message === undefined || typeof request.request.bootstrap_message === "string"
      && request.request.bootstrap_message.length <= 200000, "Invalid bootstrap message", "invalid_request");
    demand(request.request.include_tool_summary === undefined || typeof request.request.include_tool_summary === "boolean",
      "Invalid tool summary selector", "invalid_request");
    const context = request.request.pre_run_context || [];
    demand(Array.isArray(context) && Buffer.byteLength(JSON.stringify(context)) <= REGISTERED_AGENT_MAX_CONTEXT_BYTES,
      "Invalid context size", "invalid_request");
    const names = new Set();
    for (const item of context) {
      object(item, ["name", "result"], ["name", "result"]);
      demand(ID.test(String(item.name || "")) && !names.has(item.name), "Invalid or duplicate context name", "invalid_request");
      names.add(item.name);
    }
    const inputs = request.request.inputs === undefined ? {} : request.request.inputs;
    demand(inputs && typeof inputs === "object" && !Array.isArray(inputs)
      && Object.keys(inputs).length <= 32 && Object.keys(inputs).every(name => /^[a-z][a-z0-9_]{0,63}$/.test(name))
      && Buffer.byteLength(JSON.stringify(inputs)) <= 32 * 1024, "Invalid private inputs", "invalid_request");
    return context;
  }

  async execute(request, transport = null) {
    demand(!this.stopping, "Registered owner is stopping", "owner_unavailable");
    this.owner.service.assertOwner();
    const local = transport?.transport === "local_gateway";
    const context = this.validateRequest(request, local);
    const authority = local ? this.owner.exposures.authorize(request, transport.identity) : null;
    const registration = authority?.registration || this.authenticate(request);
    if (!local) this.owner.exposures.legacyAllowed(registration.id, request.agent);
    const loaded = this.validateAgent(request.agent, registration.skill_pins?.[request.agent] || null);
    demand(context.every(item => registration.context_names.includes(item.name)), "Context name is not registered", "forbidden");
    try { schemaCheck(this.owner.agents.privateInputSchema(loaded.definition), request.request.inputs || {}); }
    catch (error) {
      if (error.code !== "schema_mismatch") throw error;
      demand(false, "Private inputs do not match the agent call contract", "invalid_request");
    }
    const selector = request.session || "";
    const fingerprint = digest([request.operation, request.agent, selector, request.request]);
    const receiptKey = digest([registration.identity, request.agent, request.operation, request.idempotency_key]);
    if (selector) {
      const tombstone = this.store.get("registered_session_tombstones", selector);
      if (tombstone) demand(tombstone.client_id === registration.identity && tombstone.agent === request.agent,
        "Conversation is outside this registration", "forbidden");
      demand(!tombstone, tombstone?.kind === "run" ? "One-shot execution is sealed" : "Conversation content expired", "agent_session_expired");
      const selected = this.store.get("agent_sessions", selector);
      if (selected) demand(selected.ownership?.client_id === registration.identity && selected.ownership.kind === "registered_chat"
        && selected.agent === request.agent, "Conversation is outside this registration", "forbidden");
    }
    let fresh = false;
    let receipt = this.store.transaction(() => {
      const previous = this.store.registeredReceipt(receiptKey);
      if (previous) {
        demand(previous.fingerprint === fingerprint, "Idempotency key changed its request", "idempotency_conflict");
        if (cachedTransientBusy(previous)) this.store.removeRegisteredReceipt(receiptKey);
        else return previous;
      }
      const sessionID = selector || `conv_${crypto.randomUUID()}`;
      const holding = this.store.activeRegisteredSession(sessionID);
      demand(!holding || holding.client_id === registration.identity, "Conversation is outside this registration", "forbidden");
      demand(!holding, "Conversation has an active request", "agent_session_busy");
      const active = this.store.registeredReceipts().filter(item => item.client_id === registration.identity && item.status === "active").length;
      demand(active < registration.max_concurrency, "Registration concurrency limit reached", "agent_request_busy");
      const history = this.store.registeredReceipts();
      demand(history.filter(item => item.client_id === registration.identity && item.response).length < 10000,
        "Registration storage limit reached", "forbidden");
      const minuteAgo = Date.now() - 60_000;
      demand(history.filter(item => Date.parse(item.created_at) >= minuteAgo).length < 600
        && history.filter(item => item.client_id === registration.identity && Date.parse(item.created_at) >= minuteAgo).length < 60,
      "Registration rate limit reached", "agent_request_busy");
      const spent = history.filter(item => item.client_id === registration.identity)
        .reduce((sum, item) => sum + (Number.isFinite(item.spend_usd) ? item.spend_usd : Number(item.spend_reserved_usd) || 0), 0);
      demand(spent + loaded.definition.limits.spend_usd <= registration.max_spend_usd, "Registration spend limit reached", "forbidden");
      if (authority) {
        demand(history.filter(item => item.exposure_id === authority.exposure.id
          && Date.parse(item.created_at) >= minuteAgo).length < 60,
        "Exposure rate limit reached", "agent_request_busy");
        const exposureSpent = history.filter(item => item.exposure_id === authority.exposure.id)
          .reduce((sum, item) => sum + (Number.isFinite(item.spend_usd) ? item.spend_usd : Number(item.spend_reserved_usd) || 0), 0);
        const budgets = [authority.exposure.policy.max_spend_usd,
          ...(authority.exposure.pending_policy ? [authority.exposure.pending_policy.max_spend_usd] : [])];
        demand(exposureSpent + loaded.definition.limits.spend_usd <= Math.min(...budgets),
          "Exposure spend limit reached", "forbidden");
      }
      const created = { key: receiptKey, fingerprint, client_id: registration.identity, agent: request.agent,
        agent_digest: loaded.digest, operation: request.operation, session_id: sessionID, status: "active",
        ...(authority ? { exposure_id: authority.exposure.id, caller_uid: authority.caller.uid,
          caller_user: authority.caller.user } : {}),
        request_id: String(request.request_id || crypto.randomUUID()).slice(0, 120), spend_reserved_usd: loaded.definition.limits.spend_usd,
        created_at: new Date().toISOString() };
      fresh = true;
      return this.store.putRegisteredReceipt(receiptKey, created);
    });
    if (authority) {
      const auditKey = digest([receiptKey, authority.caller.uid]);
      const previous = this.store.get("registered_access_audit", auditKey);
      this.store.put("registered_access_audit", auditKey, { id: auditKey, client_id: registration.id,
        client_identity: registration.identity, exposure_id: authority.exposure.id,
        caller_uid: authority.caller.uid, caller_user: authority.caller.user,
        receipt_key: receiptKey, first_at: previous?.first_at || new Date().toISOString(),
        last_at: new Date().toISOString(), count: (previous?.count || 0) + 1 });
    }
    if (receipt.status !== "active") {
      if (!receipt.response) return failure("receipt_expired", "Idempotency receipt content expired; the key remains reserved");
      demand(receipt.agent_digest === loaded.digest, "Agent definition changed since this receipt", "capability_unavailable");
      if (receipt.operation === "chat" && this.store.get("agent_sessions", receipt.session_id)) {
        const pinned = this.owner.agents.registeredSession(receipt.session_id, { kind: "registered_chat", clientID: registration.identity, agent: request.agent });
        for (const capability of pinned.capabilities || []) assertRegisteredCapability(this.owner.service,
          capability.entry_id, capability.digest, this.owner.agents.principalFor(pinned.definition), capability.grant_id);
      }
      return receipt.response;
    }
    if (!fresh) return failure("agent_request_busy", "Request is still in progress");
    let cwd;
    try { cwd = this.cwd(loaded.definition, registration, receipt.session_id); }
    catch {
      const response = failure("agent_scope_mismatch", "Configured agent workspace is unavailable");
      this.owner.service.assertOwner();
      receipt.status = "failed"; receipt.response = response; receipt.completed_at = new Date().toISOString();
      this.store.putRegisteredReceipt(receiptKey, receipt);
      return response;
    }
    const controller = new AbortController();
    const executionState = { uncertain: false };
    const execution = Object.freeze({
      kind: request.operation === "chat" ? "registered_chat" : "registered_run",
      clientID: registration.identity, registrationRevision: registration.revision, agent: request.agent, definition: loaded.definition,
      inputs: Object.freeze(structuredClone(request.request.inputs || {})),
      inputsDigest: digest(request.request.inputs || {}),
      requestID: receipt.request_id, cwd, signal: controller.signal,
      state: executionState,
      check: () => {
        demand(!controller.signal.aborted, "Registered execution timed out", "agent_budget_exceeded");
        if (local) this.owner.exposures.authorize(request, transport.identity);
        const live = this.store.get(REGISTRATIONS, registration.id);
        demand(live?.enabled && live.identity === registration.identity && live.agents.includes(request.agent)
          && live.operations.includes(request.operation), "Registration authority changed", "forbidden");
        this.owner.service.assertOwner();
        const pinned = this.store.get("agent_sessions", receipt.session_id);
        if (pinned) for (const capability of pinned.capabilities || [])
          assertRegisteredCapability(this.owner.service, capability.entry_id, capability.digest,
            this.owner.agents.principalFor(pinned.definition), capability.grant_id);
      },
      checkCapability: (id, pin, principal) => {
        const nested = assertRegisteredCapability(this.owner.service, id, pin, principal, null);
        if (["external_write", "artifact_write"].includes(nested.entry.effect))
          demand(nested.grant.unattended, "Nested write needs an unattended grant", "forbidden");
      },
    });
    const client = { request: async (operation, args) => {
      if (operation === "agent.turn.abort") this.owner.service.assertOwner();
      else execution.check();
      switch (operation) {
        case "agent.session.get": return structuredClone(this.owner.agents.registeredSession(args.id, execution));
        case "agent.turn.begin": return this.owner.agents.begin(args, execution);
        case "agent.turn.invoke": return this.owner.agents.invoke(args, execution);
        case "agent.turn.complete": return this.owner.agents.complete(args, execution);
        case "agent.turn.abort": return this.owner.agents.abort(args, execution);
        default: demand(false, "Operation is outside the registered protocol", "forbidden");
      }
    } };
    let result;
    const timeout = setTimeout(() => controller.abort(), loaded.definition.limits.wall_seconds * 1000);
    const active = { clientID: registration.identity, controller, promise: null, resolve: null };
    active.promise = new Promise(resolve => { active.resolve = resolve; });
    this.active.set(receiptKey, active);
    try {
      const existing = this.store.get("agent_sessions", receipt.session_id);
      if (existing) {
        this.owner.agents.assertOwnership(existing, execution);
        demand((existing.private_inputs_digest || digest({})) === execution.inputsDigest,
          "Private inputs cannot change within a conversation", "idempotency_conflict");
        demand(existing.agent_digest === loaded.digest, "Agent definition changed; start a new conversation", "capability_unavailable");
        demand(request.request.bootstrap_message === undefined && context.length === 0, "Pinned context cannot change", "idempotency_conflict");
        for (const capability of existing.capabilities || []) {
          const principal = this.owner.agents.principalFor(existing.definition);
          assertRegisteredCapability(this.owner.service, capability.entry_id, capability.digest, principal, capability.grant_id);
        }
      }
      result = await this.owner.agentRuntime.run({ agent: request.agent, message: request.request.message,
        bootstrapMessage: request.request.bootstrap_message || "", preRunContext: context, session: receipt.session_id,
        idempotencyKey: request.idempotency_key, client, execution,
        includeToolSummary: request.request.include_tool_summary === true });
    } catch (error) {
      result = failure(["forbidden", "idempotency_conflict", "agent_session_busy", "capability_unavailable"].includes(error.code) ? error.code : "agent_error");
    } finally { clearTimeout(timeout); }
    const response = executionState.uncertain
      ? safeResult(failure("external_outcome_unknown", "External write outcome needs operator reconciliation"), receipt)
      : safeResult(result, receipt);
    try {
      this.owner.service.assertOwner();
      receipt = this.store.transaction(() => {
        const current = this.store.registeredReceipt(receiptKey);
        if (current.status !== "active") return current;
        if (response.status === "failed" && TRANSIENT_BUSY_CODES.has(response.error?.code)) {
          this.store.removeRegisteredReceipt(receiptKey);
          return { ...current, response };
        }
        current.response = response; current.status = response.status;
        current.spend_usd = response.status === "done" && Number.isFinite(response.usage?.cost_usd)
          ? response.usage.cost_usd : current.spend_reserved_usd;
        current.completed_at = new Date().toISOString();
        this.store.putRegisteredReceipt(receiptKey, current);
        if (request.operation === "run") {
          this.store.put("registered_session_tombstones", receipt.session_id, { kind: "run", client_id: registration.identity,
            agent: request.agent, expired_at: new Date().toISOString() });
          this.store.remove("agent_sessions", receipt.session_id);
        }
        return current;
      });
    } finally { this.active.delete(receiptKey); active.resolve(); }
    return receipt.response;
  }

  recover() {
    const recoveredAt = new Date().toISOString();
    this.store.transaction(() => {
      for (const receipt of this.store.registeredReceipts()) {
        if (cachedTransientBusy(receipt)) { this.store.removeRegisteredReceipt(receipt.key); continue; }
        if (receipt.status !== "active") continue;
        receipt.status = "failed"; receipt.completed_at = recoveredAt;
        receipt.response = failure("external_outcome_unknown", "Prior execution outcome needs operator reconciliation");
        this.store.putRegisteredReceipt(receipt.key, receipt);
        if (receipt.operation === "run") {
          this.store.put("registered_session_tombstones", receipt.session_id, { kind: "run", client_id: receipt.client_id,
            agent: receipt.agent, expired_at: recoveredAt });
          this.store.remove("agent_sessions", receipt.session_id);
        }
      }
      for (const session of this.store.list("agent_sessions")) {
        if (session.ownership?.kind === "registered_run") {
          this.store.put("registered_session_tombstones", session.id, { kind: "run", client_id: session.ownership.client_id,
            agent: session.agent, expired_at: recoveredAt });
          this.store.remove("agent_sessions", session.id);
        } else if (session.ownership?.kind === "registered_chat" && session.status === "active") {
          session.status = "idle"; session.active = null; session.pending = null;
          session.last_error = "Prior execution outcome needs operator reconciliation"; session.updated_at = recoveredAt;
          this.store.put("agent_sessions", session.id, session);
        }
      }
    });
  }
}
