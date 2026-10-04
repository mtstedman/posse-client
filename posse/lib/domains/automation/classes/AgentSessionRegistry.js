import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

import { AGENT_SESSION_PATTERN } from "../../../catalog/agent.js";
import { agentDefinitionDigest, validateAgentDefinition } from "../../agents/functions/definition.js";
import { demand, matchesGrant } from "../functions/policy.js";
import { repositoryID } from "../functions/paths.js";

const SESSION_KIND = "agent_sessions";
const ACTIVE_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGES = 256;

function nowIso(now) { return new Date(now()).toISOString(); }
function principalFor(definition) {
  if (definition.scope.kind === "repository") return { scope: "repository", repo_id: definition.scope.repo_id, role: "dev" };
  if (definition.scope.kind === "folder") {
    let repoPath = definition.scope.folder_path;
    try { repoPath = fs.realpathSync(repoPath); } catch {}
    return { scope: "repository", repo_id: repositoryID(repoPath), repo_path: repoPath, role: "dev" };
  }
  return { scope: "standalone", role: "dev" };
}
function publicCapability(capability) {
  return {
    name: capability.name,
    description: capability.description,
    parameters: capability.parameters,
    effect: capability.effect,
    kind: capability.kind,
    digest: capability.digest,
  };
}

export class AgentSessionRegistry {
  constructor(service, skills, scripts, { now = () => Date.now() } = {}) {
    this.service = service; this.skills = skills; this.scripts = scripts; this.store = service.store; this.now = now;
  }

  session(id) {
    demand(AGENT_SESSION_PATTERN.test(String(id || "")), "Invalid agent session ID", "agent_session_invalid");
    const session = this.store.get(SESSION_KIND, id);
    demand(session, `No agent session named ${id}`, "agent_session_not_found");
    return session;
  }

  begin({ session_id = "", definition, digest, message }) {
    const checked = validateAgentDefinition(definition);
    demand(checked.ok, checked.errors.join("; "), "agent_invalid");
    const exactDigest = agentDefinitionDigest(checked.definition);
    demand(exactDigest === digest, "Agent definition digest mismatch", "schema_mismatch");
    demand(typeof message === "string" && message.trim(), "Agent turn message is required", "invalid_request");
    const id = session_id || `conv_${randomUUID()}`;
    demand(AGENT_SESSION_PATTERN.test(id), "Invalid agent session ID", "agent_session_invalid");
    const existing = this.store.get(SESSION_KIND, id);
    let session;
    if (existing) {
      demand(existing.agent === checked.definition.name, `Session ${id} belongs to agent ${existing.agent}`, "agent_session_mismatch");
      demand(existing.status !== "pending_confirmation", `Session ${id} is waiting for confirmation`, "agent_confirmation_required");
      demand(!this.active(existing), `Session ${id} already has an active turn`, "agent_session_busy");
      session = existing;
    } else {
      const capabilities = this.resolveCapabilities(checked.definition);
      session = {
        id, agent: checked.definition.name, agent_digest: exactDigest,
        definition: checked.definition, capabilities, messages: [], turns: [],
        status: "idle", created_at: nowIso(this.now), updated_at: nowIso(this.now), active: null, pending: null,
      };
    }
    const token = randomUUID(), turnID = `turn_${randomUUID()}`;
    session.status = "active";
    session.active = {
      token, turn_id: turnID, message: message.trim(), started_at: nowIso(this.now),
      expires_at_ms: this.now() + Math.max(ACTIVE_TTL_MS, checked.definition.limits.wall_seconds * 1000 + 60_000),
    };
    session.pending = null; session.updated_at = nowIso(this.now);
    this.store.put(SESSION_KIND, id, session);
    return { session: this.publicSession(session), definition: structuredClone(session.definition), token, turn_id: turnID, messages: session.messages, capabilities: session.capabilities.map(publicCapability) };
  }

  active(session) {
    return session.status === "active" && session.active && Number(session.active.expires_at_ms) > this.now();
  }

  assertTurn(id, token) {
    const session = this.session(id);
    demand(this.active(session) && session.active.token === token, "Agent turn authority expired or changed", "agent_turn_changed");
    return session;
  }

  async invoke({ session_id, token, tool, input, confirmed = false, idempotency_key = "" }) {
    const session = this.assertTurn(session_id, token);
    const capability = session.capabilities.find(item => item.name === tool);
    demand(capability, `Tool ${tool} is not in this agent's pinned allowlist`, "forbidden");
    if (capability.effect === "write") {
      const mode = session.definition.autonomy.write_tools;
      demand(mode !== "deny", `${tool} is a write tool and this agent denies write tools`, "forbidden");
      demand(mode === "allow" || confirmed === true, `${tool} requires operator confirmation`, "agent_confirmation_required");
    }
    const principal = principalFor(session.definition);
    const started = this.now();
    const run = this.service.invoke(principal, {
      operation: "invoke", tool: capability.entry_id, grant_id: capability.grant_id, input,
      idempotency_key: idempotency_key || `${session_id}:${session.active.turn_id}:${createHash("sha256").update(JSON.stringify([tool, input])).digest("hex").slice(0, 24)}`,
    }, null, { allowExternalWrite: capability.effect !== "write" || session.definition.autonomy.write_tools === "allow" || confirmed === true });
    await this.service.active.get(run.id)?.promise;
    const complete = this.store.run(run.id);
    demand(complete?.status === "succeeded", complete?.error || `Tool ${tool} failed`, complete?.error_code || "agent_tool_failed");
    return { output: complete.output, run_id: complete.id, duration_ms: Math.max(0, this.now() - started), capability: publicCapability(capability) };
  }

  pause({ session_id, token, proposal }) {
    const session = this.assertTurn(session_id, token);
    demand(proposal && typeof proposal === "object", "Confirmation proposal is required", "invalid_request");
    session.status = "pending_confirmation";
    session.pending = { ...proposal, proposal_id: proposal.proposal_id || `proposal_${randomUUID()}`, created_at: nowIso(this.now) };
    session.active = null; session.updated_at = nowIso(this.now);
    this.store.put(SESSION_KIND, session_id, session);
    return { session: this.publicSession(session), pending: structuredClone(session.pending) };
  }

  resume({ session_id, proposal_id, deny = false }) {
    const session = this.session(session_id);
    demand(session.status === "pending_confirmation" && session.pending, `Session ${session_id} is not waiting for confirmation`, "agent_confirmation_missing");
    demand(session.pending.proposal_id === proposal_id, "Confirmation proposal changed", "agent_turn_changed");
    const pending = session.pending;
    demand(!pending.expires_at || Date.parse(pending.expires_at) > this.now(), "Confirmation proposal expired", "agent_turn_changed");
    const token = randomUUID();
    session.status = "active";
    session.active = {
      token, turn_id: pending.turn_id, message: pending.message, started_at: pending.started_at,
      expires_at_ms: this.now() + Math.max(ACTIVE_TTL_MS, session.definition.limits.wall_seconds * 1000 + 60_000),
    };
    session.pending = null; session.updated_at = nowIso(this.now);
    this.store.put(SESSION_KIND, session_id, session);
    return { session: this.publicSession(session), token, pending, denied: deny === true };
  }

  complete({ session_id, token, reply, tool_calls = [], usage = null }) {
    const session = this.assertTurn(session_id, token);
    const active = session.active;
    const turn = {
      id: active.turn_id, message: active.message, reply: String(reply || ""), tool_calls: structuredClone(tool_calls),
      usage: usage ? structuredClone(usage) : null, started_at: active.started_at, completed_at: nowIso(this.now),
    };
    session.messages.push({ role: "user", content: active.message }, { role: "assistant", content: turn.reply });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    session.turns.push(turn); session.status = "idle"; session.active = null; session.pending = null; session.updated_at = turn.completed_at;
    this.store.put(SESSION_KIND, session_id, session);
    return { session: this.publicSession(session), turn };
  }

  abort({ session_id, token, error = "" }) {
    const session = this.assertTurn(session_id, token);
    session.status = "idle"; session.active = null; session.pending = null; session.updated_at = nowIso(this.now);
    if (error) session.last_error = String(error).slice(0, 1000);
    this.store.put(SESSION_KIND, session_id, session);
    return this.publicSession(session);
  }

  get(id) { return structuredClone(this.session(id)); }
  list(agent = "") { return this.store.list(SESSION_KIND).filter(item => !agent || item.agent === agent).map(item => this.publicSession(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }

  publicSession(session) {
    return {
      id: session.id, agent: session.agent, agent_digest: session.agent_digest, status: session.status,
      created_at: session.created_at, updated_at: session.updated_at, turns: session.turns.length,
      pending: session.pending ? [{ proposal_id: session.pending.proposal_id, tool: session.pending.tool, summary: session.pending.summary, arguments_digest: session.pending.arguments_digest, expires_at: session.pending.expires_at }] : [],
    };
  }

  resolveCapabilities(definition) {
    const principal = principalFor(definition);
    const capabilities = [];
    for (const name of definition.tools) {
      demand(!name.startsWith("bossy."), `${name} is a Bossy fleet tool and is not yet available in Posse agent sessions`, "capability_unavailable");
      const tool = this.scripts.load(name), entry = this.store.get("entries", this.scripts.entryID(name));
      demand(entry?.enabled && entry.digest === tool.digest, `${name} has no passing test for its current version`, "script_unavailable");
      capabilities.push(this.capability(entry, principal, { name, kind: "script", description: tool.manifest.description, parameters: tool.manifest.params, effect: tool.manifest.effect }));
    }
    for (const identity of definition.skills) {
      demand(/^[a-z][a-z0-9-]*(?:@[^@]+)?$/.test(identity), `Skill ${identity} is not a valid published skill reference`, "skill_unavailable");
      const skill = this.skills.resolveReference(identity,
        definition.scope.kind === "repository" ? definition.scope.repo_id : definition.scope.kind === "folder" ? repositoryID(definition.scope.folder_path) : "",
        definition.scope.kind === "folder" ? definition.scope.folder_path : "");
      const entry = this.store.get("entries", this.skills.entryID(skill));
      capabilities.push(this.capability(entry, principal, {
        name: `skill.${skill.name}`, kind: "skill", description: skill.intent,
        parameters: skill.contract.input_schema, effect: skill.contract.effect === "read_only" ? "read" : "write",
      }));
    }
    const names = new Set();
    for (const item of capabilities) { demand(!names.has(item.name), `Agent capability name ${item.name} is ambiguous`, "agent_invalid"); names.add(item.name); }
    return capabilities;
  }

  capability(entry, principal, surface) {
    demand(entry?.enabled && this.service.entryAvailable(entry), `${surface.name} is unavailable`, "capability_unavailable");
    const grants = this.store.list("grants").filter(grant => grant.tool === entry.id && grant.digest === entry.digest && matchesGrant(grant, principal, "invoke"));
    demand(grants.length > 0, `${surface.name} has no grant for this agent's scope`, "forbidden");
    demand(grants.length === 1, `${surface.name} has multiple matching grants; keep one exact grant`, "ambiguous_grant");
    return { ...surface, entry_id: entry.id, digest: entry.digest, grant_id: grants[0].id };
  }
}
