import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { AutomationStore } from "./AutomationStore.js";
import { AutomationService } from "./AutomationService.js";
import { SkillRegistry } from "./SkillRegistry.js";
import { verifyMcpOAuthToken, bootConfigFromMcpOAuthClaims } from "../../integrations/functions/deterministic-mcp/oauth-token.js";
import { automationDbPath, automationSocketPath, ensureAutomationOperatorToken, repositoryID } from "../functions/paths.js";
import { definitionDigest, demand } from "../functions/policy.js";
import { previewOccurrences } from "../functions/triggers.js";

const MAX_FRAME_BYTES = 1024 * 1024;

export class AutomationOwner {
  constructor({ store = null, service = null, socketPath = automationSocketPath(), operatorToken = null, tickMs = 1000 } = {}) {
    this.store = store || new AutomationStore(automationDbPath());
    this.service = service || new AutomationService(this.store);
    this.registry = new SkillRegistry(this.service);
    this.socketPath = socketPath; this.operatorToken = operatorToken || ensureAutomationOperatorToken(); this.tickMs = tickMs;
    this.server = null; this.timer = null; this.ownsStore = !store;
  }
  async start() {
    if (this.server) return this.socketPath;
    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      const info = fs.lstatSync(this.socketPath);
      demand(info.isSocket() && !info.isSymbolicLink(), "Automation socket path is occupied by a non-socket");
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, () => { this.server.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") fs.chmodSync(this.socketPath, 0o600);
    this.service.recover();
    this.timer = setInterval(() => { try { this.service.tick(); } catch (error) { if (error.code === "owner_fenced") void this.close(); } }, this.tickMs);
    return this.socketPath;
  }
  accept(socket) {
    let buffer = Buffer.alloc(0), done = false, framed = false;
    const fail = error => {
      if (done) return; done = true;
      const message = safeError(error);
      try { socket.end(JSON.stringify({ ok: false, error: message.message, code: message.code }) + "\n"); } catch { socket.destroy(); }
    };
    socket.on("data", chunk => {
      if (done || framed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) return fail(Object.assign(new Error("Automation request is too large"), { code: "request_too_large" }));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      framed = true;
      try {
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        Promise.resolve(this.dispatch(request)).then(result => { done = true; socket.end(JSON.stringify({ ok: true, result }) + "\n"); }, fail);
      } catch (error) { fail(error); }
    });
    socket.on("error", () => {});
  }
  dispatch(request) {
    demand(request && typeof request === "object" && !Array.isArray(request), "Invalid automation request");
    if (request.kind === "health") return this.service.health();
    if (request.kind === "agent") return this.dispatchAgent(request);
    demand(request.kind === "operator" && timingSafeEqual(request.token, this.operatorToken), "Operator authentication failed", "unauthorized");
    return this.dispatchOperator(request.operation, request.args || {});
  }
  dispatchAgent(request) {
    const claims = verifyMcpOAuthToken(request.token);
    const config = bootConfigFromMcpOAuthClaims(claims);
    demand(config.role && config.cwd && config.jobId, "Agent automation credential lacks a bound repository job", "unauthorized");
    demand(config.customTools === true
      && config.toolAllowlist?.tools?.includes("custom_tools"),
    "Agent automation credential was not issued Custom Tools", "unauthorized");
    const principal = { scope: "repository", repo_id: repositoryID(config.projectRoot || config.cwd), role: config.role, job_id: String(config.jobId) };
    if (config.workItemId != null) principal.work_item_id = String(config.workItemId);
    return this.service.tool(principal, request.args || {});
  }
  dispatchOperator(operation, args) {
    switch (operation) {
      case "health": return this.service.health();
      case "tools.available": return { available: this.service.health().ready === true && this.service.discover(args.principal).length > 0 };
      case "entry.list": return this.store.list("entries").map(entry => ({ id: entry.id, source: entry.source, kind: entry.kind, digest: entry.digest, description: entry.description, enabled: entry.enabled }));
      case "draft.save": return this.registry.saveDraft(args.definition);
      case "draft.load": return this.registry.newest(args.name, args.repo_id || "");
      case "draft.reset": return this.registry.reset(args.name, args.binding);
      case "skill.list": return this.registry.list(args.query || {});
      case "skill.test": return this.registry.test(args.definition);
      case "skill.publish": return this.registry.publish(args.definition, args.actor || "local-operator");
      case "skill.import": return this.registry.importPublished(args.definition, args.definition_digest);
      case "skill.run": return this.runSkill(args);
      case "skill.deprecate": return this.registry.deprecate(args.identity, args.repo_id || "");
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
      case "run.list": return this.store.runs(args.limit || 100);
      case "run.cancel": this.service.cancel(args.id); return this.store.run(args.id);
      default: demand(false, "Unknown operator automation operation");
    }
  }
  async runSkill(args) {
    const repoID = String(args.repo_id || "");
    const definition = this.registry.resolve(args.definition?.name + "@" + args.definition?.version, repoID);
    demand(definitionDigest(definition) === definitionDigest(args.definition),
      "Run definition does not match the immutable published skill", "schema_mismatch");
    const principal = repoID
      ? { scope: "repository", repo_id: repoID, role: "dev" }
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
    if (server) await new Promise(resolve => server.close(resolve));
    await this.service.shutdown(); if (this.ownsStore) this.store.close();
    if (process.platform !== "win32") { try { fs.unlinkSync(this.socketPath); } catch {} }
  }
}


function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || "")), b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeError(error) {
  const allowed = new Set(["invalid_request", "invalid_trigger", "forbidden", "unauthorized", "ambiguous_grant", "schema_mismatch", "grant_changed", "idempotency_conflict", "draft_not_found", "skill_unavailable", "capability_unavailable", "owner_fenced", "owner_unavailable", "output_conflict", "schedule_attention", "resource_changed"]);
  return { code: allowed.has(error?.code) ? error.code : "automation_error", message: allowed.has(error?.code) ? error.message : "Automation request failed; inspect local diagnostics" };
}
