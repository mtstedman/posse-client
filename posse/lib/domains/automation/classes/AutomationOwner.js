import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { AutomationStore } from "./AutomationStore.js";
import { AutomationService } from "./AutomationService.js";
import { AgentSessionRegistry } from "./AgentSessionRegistry.js";
import { AgentScheduleRegistry } from "./AgentScheduleRegistry.js";
import { AgentDefinitionStore } from "../../agents/classes/AgentDefinitionStore.js";
import { AgentRuntime } from "../../agents/classes/AgentRuntime.js";
import { SkillRegistry } from "./SkillRegistry.js";
import { ScriptToolRegistry } from "./ScriptToolRegistry.js";
import { SqlCapabilityRegistry } from "./SqlCapabilityRegistry.js";
import { PromptToolRegistry } from "./PromptToolRegistry.js";
import { RegisteredAgentBridge } from "./RegisteredAgentBridge.js";
import { AgentExposureRegistry } from "./AgentExposureRegistry.js";
import { verifyMcpOAuthToken, bootConfigFromMcpOAuthClaims } from "../../integrations/functions/deterministic-mcp/oauth-token.js";
import { automationDbPath, automationSocketPath, registeredAgentSocketPath, registeredAgentGatewayBackendPath, registeredAgentGatewayKeyPath, ensureAutomationOperatorToken, repositoryID } from "../functions/paths.js";
import { gatewayKey, verifyGatewayFrame } from "../functions/gateway-auth.js";
import { automationBuildIdentity, automationOwnerLaunch } from "../functions/owner-identity.js";
import { definitionDigest, demand } from "../functions/policy.js";
import { previewOccurrences } from "../functions/triggers.js";

import { AUTOMATION_MAX_REQUEST_BYTES, AUTOMATION_MAX_RESPONSE_BYTES } from "../../../catalog/custom-tools.js";

export class AutomationOwner {
  constructor({ store = null, service = null, socketPath = automationSocketPath(), operatorToken = null, tickMs = 1000, build = null, launch = automationOwnerLaunch(), scriptsDir = undefined } = {}) {
    this.store = store || new AutomationStore(automationDbPath());
    this.service = service || new AutomationService(this.store);
    this.registry = new SkillRegistry(this.service);
    this.scripts = new ScriptToolRegistry(this.service, scriptsDir ? { dir: scriptsDir } : {});
    this.sqlCapabilities = new SqlCapabilityRegistry(this.service);
    this.promptTools = new PromptToolRegistry(this.store);
    this.agents = new AgentSessionRegistry(this.service, this.registry, this.scripts, this.sqlCapabilities, this.promptTools);
    this.agentDefinitions = new AgentDefinitionStore({ store: this.store });
    this.agentRuntime = new AgentRuntime({ definitions: this.agentDefinitions, client: { request: async (operation, args) => this.dispatchOperator(operation, args) } });
    this.agentSchedules = new AgentScheduleRegistry(this.store, this.agentRuntime, this.agentDefinitions);
    this.registered = new RegisteredAgentBridge(this);
    this.exposures = new AgentExposureRegistry(this);
    this.socketPath = socketPath; this.operatorToken = operatorToken || ensureAutomationOperatorToken(); this.tickMs = tickMs;
    this.build = build; this.launch = launch;
    this.server = null; this.registeredServer = null; this.gatewayServer = null; this.registeredConnections = new Set(); this.timer = null; this.ownsStore = !store; this.socketFile = null; this.registeredSocketFile = null; this.gatewaySocketFile = null; this.gatewayNonces = new Set(); this.gatewayKey = null;
  }
  async start() {
    if (this.server) return this.socketPath;
    this.build ||= await automationBuildIdentity();
    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      const info = fs.lstatSync(this.socketPath);
      demand(info.isSocket() && !info.isSymbolicLink(), "Automation socket path is occupied by a non-socket");
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, () => { this.server.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") { fs.chmodSync(this.socketPath, 0o600); this.socketFile = fileIdentity(this.socketPath); }
    const registeredPath = registeredAgentSocketPath();
    demand(registeredPath !== this.socketPath, "Registered endpoint must be separate from operator endpoint");
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(registeredPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(registeredPath)) {
        const info = fs.lstatSync(registeredPath);
        demand(info.isSocket() && !info.isSymbolicLink(), "Registered socket path is occupied by a non-socket");
        fs.unlinkSync(registeredPath);
      }
    }
    this.service.recover();
    this.agentSchedules.recover();
    this.registered.recover();
    this.registeredServer = net.createServer(socket => {
      if (this.registeredConnections.size >= 64) { socket.destroy(); return; }
      this.registeredConnections.add(socket);
      socket.once("close", () => this.registeredConnections.delete(socket));
      this.accept(socket, true);
    });
    await new Promise((resolve, reject) => { this.registeredServer.once("error", reject); this.registeredServer.listen(registeredPath, () => { this.registeredServer.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") {
      fs.chmodSync(registeredPath, process.env.POSSE_REGISTERED_AGENT_SOCKET_MODE === "0660" ? 0o660 : 0o600);
      this.registeredSocketFile = fileIdentity(registeredPath);
    }
    const gatewayPath = registeredAgentGatewayBackendPath();
    if (gatewayPath) {
      demand(process.platform === "linux" && gatewayPath !== registeredPath && gatewayPath !== this.socketPath,
        "Gateway backend needs a distinct Linux socket", "invalid_request");
      const parent = path.dirname(gatewayPath);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      fs.chmodSync(parent, 0o700);
      if (fs.existsSync(gatewayPath)) {
        const info = fs.lstatSync(gatewayPath);
        demand(info.isSocket() && !info.isSymbolicLink(), "Gateway backend path is occupied", "forbidden");
        fs.unlinkSync(gatewayPath);
      }
      this.gatewayKey = gatewayKey(registeredAgentGatewayKeyPath());
      this.gatewayServer = net.createServer(socket => this.accept(socket, false, true));
      await new Promise((resolve, reject) => { this.gatewayServer.once("error", reject); this.gatewayServer.listen(gatewayPath, () => { this.gatewayServer.off("error", reject); resolve(); }); });
      fs.chmodSync(gatewayPath, 0o600);
      this.gatewaySocketFile = fileIdentity(gatewayPath);
    }
    this.timer = setInterval(() => { try { this.service.tick(); this.agentSchedules.tick(); this.registered.maintain(); } catch (error) { if (error.code === "owner_fenced") void this.close(); } }, this.tickMs);
    return this.socketPath;
  }
  accept(socket, registered = false, gateway = false) {
    let buffer = Buffer.alloc(0), done = false, framed = false;
    socket.setTimeout(5000, () => socket.destroy());
    const fail = error => {
      if (done) return; done = true;
      const message = safeError(error);
      try { socket.end(JSON.stringify({ ok: false, error: message.message, code: message.code }) + "\n"); } catch { socket.destroy(); }
    };
    socket.on("data", chunk => {
      if (done || framed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > (gateway ? AUTOMATION_MAX_REQUEST_BYTES * 2 + 4096 : AUTOMATION_MAX_REQUEST_BYTES)) return fail(Object.assign(new Error("Automation request is too large"), { code: "request_too_large" }));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      framed = true;
      socket.setTimeout(0);
      // Registered callers that ask for progress get bounded progress lines before the final frame.
      const progress = event => {
        if (done || socket.destroyed) return;
        const line = JSON.stringify({ progress: event }) + "\n";
        if (Buffer.byteLength(line) <= AUTOMATION_MAX_RESPONSE_BYTES) socket.write(line);
      };
      try {
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        Promise.resolve(gateway ? this.dispatchGateway(request, progress) : registered ? this.dispatchRegistered(request, progress) : this.dispatch(request)).then(result => {
          const response = JSON.stringify({ ok: true, result }) + "\n";
          demand(Buffer.byteLength(response) <= AUTOMATION_MAX_RESPONSE_BYTES,
            "Automation result exceeds the response limit; narrow the tool output or inspect the run locally", "response_too_large");
          done = true; socket.end(response);
        }).catch(fail);
      } catch (error) { fail(error); }
    });
    socket.on("error", () => {});
  }
  dispatch(request) {
    demand(request && typeof request === "object" && !Array.isArray(request), "Invalid automation request");
    if (request.kind === "health") return this.health();
    if (request.kind === "agent") return this.dispatchAgent(request);
    demand(request.kind === "operator" && timingSafeEqual(request.token, this.operatorToken), "Operator authentication failed", "unauthorized");
    return this.dispatchOperator(request.operation, request.args || {});
  }
  dispatchRegistered(request, onProgress = null) {
    demand(request && typeof request === "object" && !Array.isArray(request), "Invalid registered request", "invalid_request");
    if (request.kind === "health" && Object.keys(request).length === 1) return { protocol: "posse.registered_agent_request.v1", ready: !this.service.stopping && this.service.ownsLease() };
    return this.registered.execute(request, null, { onProgress });
  }
  dispatchGateway(envelope, onProgress = null) {
    demand(this.gatewayKey, "Gateway is unavailable", "unauthorized");
    const { request, identity } = verifyGatewayFrame(envelope, this.gatewayKey, this.gatewayNonces);
    if (request.kind === "health" && Object.keys(request).length === 1) return this.dispatchRegistered(request);
    if (request.kind === "probe" && typeof request.agent === "string" && Object.keys(request).length === 2)
      return this.exposures.probe(request.agent, identity);
    return this.registered.execute(request, { identity, transport: "local_gateway" }, { onProgress });
  }
  health() { return { ...this.service.health(), build: this.build, launch: this.launch }; }
  dispatchAgent(request) {
    const claims = verifyMcpOAuthToken(request.token);
    const config = bootConfigFromMcpOAuthClaims(claims);
    demand(config.role && config.cwd && config.jobId, "Agent automation credential lacks a bound repository job", "unauthorized");
    demand(config.customTools === true
      && config.toolAllowlist?.tools?.includes("custom_tools"),
    "Agent automation credential was not issued Custom Tools", "unauthorized");
    const principal = { scope: "repository", repo_id: repositoryID(config.projectRoot || config.cwd), repo_path: fs.realpathSync(config.projectRoot || config.cwd), role: config.role, job_id: String(config.jobId) };
    if (config.workItemId != null) principal.work_item_id = String(config.workItemId);
    return this.service.tool(principal, request.args || {});
  }
  dispatchOperator(operation, args) {
    switch (operation) {
      case "health": return this.health();
      case "tools.available": return { available: this.service.health().ready === true && this.service.discover(args.principal).length > 0 };
      case "entry.list": return this.store.list("entries").map(entry => ({ id: entry.id, source: entry.source, kind: entry.kind, digest: entry.digest, description: entry.description, enabled: entry.enabled }));
      case "draft.save": return this.registry.saveDraft(args.definition);
      case "draft.load": return this.registry.newest(args.name, args.repo_id || "", args.repo_path || "");
      case "draft.reset": return this.registry.reset(args.name, args.binding);
      case "draft.delete": return this.registry.deleteDraft(args.name, args.binding);
      case "skill.list": return this.registry.list(args.query || {});
      case "skill.test": return this.registry.test(args.definition);
      case "skill.publish": return this.registry.publish(args.definition, args.actor || "local-operator");
      case "skill.import": return this.registry.importPublished(args.definition, args.definition_digest);
      case "skill.run": return this.runSkill(args);
      case "skill.deprecate": return this.registry.deprecate(args.identity, args.repo_id || "", args.repo_path || "");
      case "resource.save": return this.service.registerResource(args.resource);
      case "resource.list": return this.store.list("resources");
      case "resource.disable": return this.service.disableResource(args.id);
      case "grant.save": return this.service.grant(args.grant);
      case "grant.list": return this.store.list("grants");
      case "grant.revoke": return this.service.revoke(args.id);
      case "schedule.save": return this.service.saveSchedule(args.schedule);
      case "schedule.list": return this.store.list("schedules");
      case "schedule.preview": return previewOccurrences(args.trigger, args.count || 5, args.after ? Date.parse(args.after) : Date.now());
      case "schedule.pause": return this.service.setScheduleEnabled(args.id, false);
      case "schedule.resume": return this.service.setScheduleEnabled(args.id, true);
      case "schedule.remove": return this.service.removeSchedule(args.id);
      case "schedule.run_now": return this.service.runScheduleNow(args.id, args.idempotency_key);
      case "agent_schedule.save": return this.agentSchedules.save(args.schedule);
      case "agent_schedule.list": return this.agentSchedules.list();
      case "agent_schedule.pause": return this.agentSchedules.setEnabled(args.id, false);
      case "agent_schedule.resume": return this.agentSchedules.setEnabled(args.id, true);
      case "agent_schedule.remove": return this.agentSchedules.remove(args.id);
      case "agent_schedule.run_now": return this.agentSchedules.runNow(args.id);
      case "agent.definition.list": return this.agentDefinitions.list();
      case "agent.definition.get": return this.agentDefinitions.load(args.name);
      case "agent.definition.create": return this.agentDefinitions.create(args.name);
      case "agent.definition.save": return this.agentDefinitions.save(args.definition, { create: args.create === true });
      case "agent.definition.remove": return this.agentDefinitions.remove(args.name);
      case "agent.client.create": return this.registered.create(args);
      case "agent.client.rotate": return this.registered.rotate(args.id);
      case "agent.client.extend_exposure": return this.registered.extendForExposure(args.id, args.agent, args.operations, args.context_names);
      case "agent.client.revoke": return this.registered.revoke(args.id);
      case "agent.client.list": return this.store.list("registered_clients").map(item => this.registered.publicRegistration(item));
      case "agent.exposure.stage": return this.exposures.stage(args);
      case "agent.exposure.activate": return this.exposures.activate(args.id, args.revision);
      case "agent.exposure.revoke": return this.exposures.revoke(args.id);
      case "agent.exposure.restore": return this.exposures.restore(args.id);
      case "agent.exposure.list": return this.exposures.list();
      case "agent.exposure.retire_user": return this.exposures.retireUser(args.uid);
      case "agent.trust.approve": return this.registered.approve(args);
      case "agent.trust.list": return this.store.list("registered_trust");
      case "agent.repository.save": {
        const root = fs.realpathSync(args.root);
        demand(repositoryID(root) === args.id, "Repository ID/root mismatch", "invalid_request");
        return this.store.put("repositories", args.id, { id: args.id, root });
      }
      case "script.list": return this.scripts.list();
      case "script.show": return this.scripts.show(args.name, { repoPath: args.repo_path });
      case "script.create": return this.scripts.create(args.spec);
      case "script.code.get": return this.scripts.code(args.name);
      case "script.code.save": return this.scripts.saveCode(args.name, args.code, args.expected_digest);
      case "script.test": return this.scripts.test(args.name, args.input || {}, args.inputs || {});
      case "script.grant": return this.scripts.grant(args.name, { repoPath: args.repo_path, standalone: args.standalone === true, roles: args.roles, unattended: args.unattended === true });
      case "script.secret.set": return this.scripts.setSecret(args.tool, args.name, args.value);
      case "script.secret.unset": return this.scripts.unsetSecret(args.tool, args.name);
      case "sql_capability.list": return this.sqlCapabilities.list();
      case "sql_capability.show": return this.sqlCapabilities.status(args.name);
      case "sql_capability.save": return this.sqlCapabilities.save(args.definition);
      case "sql_capability.test": return this.sqlCapabilities.test(args.name, args.input || {});
      case "sql_capability.grant": return this.sqlCapabilities.grant(args.name, { roles: args.roles });
      case "prompt_tool.list": return this.promptTools.list();
      case "prompt_tool.show": return this.promptTools.status(args.name);
      case "prompt_tool.save": return this.promptTools.save(args.definition);
      case "prompt_tool.remove": return this.promptTools.remove(args.name);
      case "script.secret.status": return this.scripts.secretStatus(this.scripts.load(args.tool).manifest);
      case "agent.turn.begin": return this.agents.begin(args);
      case "agent.turn.invoke": return this.agents.invoke(args);
      case "agent.turn.pause": return this.agents.pause(args);
      case "agent.turn.resume": return this.agents.resume(args);
      case "agent.turn.complete": return this.agents.complete(args);
      case "agent.turn.abort": return this.agents.abort(args);
      case "agent.session.get": return this.agents.get(args.id);
      case "agent.session.list": return this.agents.list(args.agent || "");
      case "run.list": return this.store.runs(args.limit || 100);
      case "run.cancel": this.service.cancel(args.id); return this.store.run(args.id);
      default: demand(false, "Unknown operator automation operation");
    }
  }
  async runSkill(args) {
    const repoID = String(args.repo_id || "");
    const repoPath = String(args.repo_path || "");
    const definition = this.registry.resolve(args.definition?.name + "@" + args.definition?.version, repoID, repoPath);
    demand(definitionDigest(definition) === definitionDigest(args.definition),
      "Run definition does not match the immutable published skill", "schema_mismatch");
    const principal = repoID
      ? { scope: "repository", repo_id: repoID, ...(repoPath ? { repo_path: fs.realpathSync(repoPath) } : {}), role: "dev" }
      : { scope: "standalone", role: "dev" };
    const run = this.service.invoke(principal, {
      operation: "invoke", tool: this.registry.entryID(definition), grant_id: args.grant_id,
      input: args.input, idempotency_key: args.idempotency_key,
    });
    if (args.wait !== false) await this.service.active.get(run.id)?.promise;
    return this.store.run(run.id);
  }
  async close() {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const server = this.server; this.server = null;
    const registeredServer = this.registeredServer; this.registeredServer = null;
    const gatewayServer = this.gatewayServer; this.gatewayServer = null;
    if (registeredServer) registeredServer.close();
    if (gatewayServer) gatewayServer.close();
    for (const socket of this.registeredConnections) socket.destroy();
    if (server) server.close();
    await this.registered.shutdown(); await this.agentSchedules.shutdown(); await this.service.shutdown(); if (this.ownsStore) this.store.close();
    // A successor may already listen on this path; remove only our own socket.
    if (process.platform !== "win32") {
      try { if (!this.socketFile || sameFile(fileIdentity(this.socketPath), this.socketFile)) fs.unlinkSync(this.socketPath); } catch {}
      const registeredPath = registeredAgentSocketPath();
      try { if (!this.registeredSocketFile || sameFile(fileIdentity(registeredPath), this.registeredSocketFile)) fs.unlinkSync(registeredPath); } catch {}
      const gatewayPath = registeredAgentGatewayBackendPath();
      if (gatewayPath) try { if (!this.gatewaySocketFile || sameFile(fileIdentity(gatewayPath), this.gatewaySocketFile)) fs.unlinkSync(gatewayPath); } catch {}
    }
  }
}


// Inode numbers are reused at once after an unlink, so the change time
// (nanoseconds) is part of the socket file's identity.
function fileIdentity(filename) {
  try { const info = fs.lstatSync(filename, { bigint: true }); return { dev: info.dev, ino: info.ino, ctime: info.ctimeNs }; } catch { return null; }
}
function sameFile(left, right) { return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.ctime === right.ctime); }
function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || "")), b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeError(error) {
  const allowed = new Set(["request_too_large", "response_too_large", "invalid_request", "invalid_trigger", "forbidden", "unauthorized", "ambiguous_grant", "schema_mismatch", "grant_changed", "idempotency_conflict", "agent_request_busy", "agent_session_expired", "receipt_expired", "agent_budget_exceeded", "usage_unknown", "external_outcome_unknown", "draft_not_found", "skill_unavailable", "capability_unavailable", "owner_fenced", "owner_unavailable", "output_conflict", "schedule_attention", "resource_changed", "script_invalid", "script_not_found", "script_changed", "script_timeout", "script_secret_missing", "script_unavailable", "sql_capability_invalid", "sql_capability_not_found", "sql_capability_unavailable", "prompt_tool_invalid", "prompt_tool_not_found", "prompt_tool_result_missing", "prompt_tool_result_unknown", "agent_invalid", "agent_not_found", "agent_scope_mismatch", "agent_session_invalid", "agent_session_not_found", "agent_session_mismatch", "agent_session_busy", "agent_turn_changed", "agent_confirmation_required", "agent_confirmation_missing", "agent_tool_failed"]);
  return { code: allowed.has(error?.code) ? error.code : "automation_error", message: allowed.has(error?.code) ? error.message : "Automation request failed; inspect local diagnostics" };
}
