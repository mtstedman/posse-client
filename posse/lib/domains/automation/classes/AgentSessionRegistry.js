import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

import { AGENT_SESSION_PATTERN } from "../../../catalog/agent.js";
import { agentDefinitionDigest, agentSessionIdleExpired, validateAgentDefinition } from "../../agents/functions/definition.js";
import { demand, digest, matchesGrant } from "../functions/policy.js";
import { repositoryID } from "../functions/paths.js";
import { assertRegisteredCapability } from "../functions/registered-trust.js";

const SESSION_KIND = "agent_sessions";
const ACTIVE_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGES = 256;

function nowIso(now) { return new Date(now()).toISOString(); }
function toolIdempotencyKey(sessionID, turnID, tool, input) {
  const legacy = `${sessionID}:${turnID}:${createHash("sha256").update(JSON.stringify([tool, input])).digest("hex").slice(0, 24)}`;
  return legacy.length <= 120 ? legacy
    : `agent-tool:${createHash("sha256").update(JSON.stringify([sessionID, turnID, tool, input])).digest("hex")}`;
}
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
  constructor(service, skills, scripts, sqlCapabilities = null, promptTools = null, { now = () => Date.now() } = {}) {
    this.service = service; this.skills = skills; this.scripts = scripts; this.sqlCapabilities = sqlCapabilities; this.promptTools = promptTools; this.store = service.store; this.now = now;
  }
  principalFor(definition) { return principalFor(definition); }

  // Include script tools selected directly or unlocked by instruction skills.
  // Their agent-facing params remain the only model surface.
  privateInputSchema(definition) {
    const properties = {}, required = new Set();
    const toolNames = new Set(definition.tools);
    for (const reference of definition.skills) {
      const skill = this.resolveSkill(definition, reference);
      if (skill.runtime.mode !== "instructions") continue;
      for (const capability of skill.capabilities) {
        if (capability.kind === "tool" && capability.id.startsWith("script:")) toolNames.add(capability.id.slice(7));
      }
    }
    for (const name of toolNames) {
      if (this.store.get("prompt_tools", name) || this.store.get("sql_capabilities", name)) continue;
      const schema = this.scripts.load(name).manifest.inputs;
      if (!schema) continue;
      for (const [key, value] of Object.entries(schema.properties)) {
        if (Object.hasOwn(properties, key)) demand(digest(properties[key]) === digest(value),
          `Private input ${key} has conflicting tool schemas`, "agent_invalid");
        else properties[key] = structuredClone(value);
      }
      for (const key of schema.required || []) required.add(key);
    }
    return { type: "object", additionalProperties: false, properties,
      ...(required.size ? { required: [...required].sort() } : {}) };
  }

  session(id) {
    demand(AGENT_SESSION_PATTERN.test(String(id || "")), "Invalid agent session ID", "agent_session_invalid");
    const session = this.store.get(SESSION_KIND, id);
    demand(session, `No agent session named ${id}`, "agent_session_not_found");
    return session;
  }

  begin({ session_id = "", definition, digest, message, idempotency_key = "", prompt_tool_results = [] }, execution = null) {
    const checked = validateAgentDefinition(definition);
    demand(checked.ok, checked.errors.join("; "), "agent_invalid");
    const exactDigest = agentDefinitionDigest(checked.definition);
    demand(exactDigest === digest, "Agent definition digest mismatch", "schema_mismatch");
    demand(typeof message === "string" && message.trim(), "Agent turn message is required", "invalid_request");
    demand(typeof idempotency_key === "string" && idempotency_key.length <= 120, "Invalid agent turn idempotency key", "invalid_request");
    const id = session_id || `conv_${randomUUID()}`;
    demand(AGENT_SESSION_PATTERN.test(id), "Invalid agent session ID", "agent_session_invalid");
    const existing = this.store.get(SESSION_KIND, id);
    let session, preRunContext = [];
    if (existing) {
      this.assertOwnership(existing, execution);
      if (execution) demand((existing.private_inputs_digest || digest({})) === execution.inputsDigest,
        "Private inputs cannot change within a conversation", "idempotency_conflict");
      demand(existing.agent === checked.definition.name, `Session ${id} belongs to agent ${existing.agent}`, "agent_session_mismatch");
      if (idempotency_key) {
        const prior = existing.turns.find(turn => turn.idempotency_key === idempotency_key);
        if (prior) {
          demand((prior.source_message || prior.message) === message.trim(), "Agent turn idempotency key was reused with a different message", "idempotency_conflict");
          return {
            session: this.publicSession(existing), definition: structuredClone(existing.definition),
            replay: { turn_id: prior.id, reply: prior.reply, tool_calls: structuredClone(prior.tool_calls || []), usage: structuredClone(prior.usage) },
          };
        }
      }
      demand(!agentSessionIdleExpired(existing, this.now()),
        `Conversation ${id} ended after ${existing.definition?.limits?.idle_minutes} minutes without a turn; start a new one`, "agent_session_expired");
      demand(existing.status !== "pending_confirmation", `Session ${id} is waiting for confirmation`, "agent_confirmation_required");
      demand(!this.active(existing), `Session ${id} already has an active turn`, "agent_session_busy");
      session = existing;
      preRunContext = structuredClone(existing.pre_run_context || existing.prompt_tool_results || []);
    } else {
      const resolved = this.resolveCapabilities(checked.definition, prompt_tool_results, execution);
      const capabilities = resolved.capabilities;
      preRunContext = resolved.injected;
      session = {
        id, agent: checked.definition.name, agent_digest: exactDigest,
        definition: checked.definition, capabilities, skill_instructions: resolved.instructions, pre_run_context: structuredClone(preRunContext), messages: [], turns: [],
        status: "idle", created_at: nowIso(this.now), updated_at: nowIso(this.now), active: null, pending: null,
        ownership: execution ? { kind: execution.kind, client_id: execution.clientID, agent: checked.definition.name } : { kind: "operator" },
        ...(execution ? { private_inputs_digest: execution.inputsDigest } : {}),
      };
    }
    const sourceMessage = message.trim();
    const token = randomUUID(), turnID = `turn_${randomUUID()}`;
    session.status = "active";
    session.active = {
      token, turn_id: turnID, message: sourceMessage, source_message: sourceMessage, idempotency_key, started_at: nowIso(this.now),
      expires_at_ms: this.now() + Math.max(ACTIVE_TTL_MS, checked.definition.limits.wall_seconds * 1000 + 60_000),
    };
    session.pending = null; session.updated_at = nowIso(this.now);
    this.store.put(SESSION_KIND, id, session);
    return { session: this.publicSession(session), definition: structuredClone(session.definition), token, turn_id: turnID, messages: session.messages, capabilities: session.capabilities.map(publicCapability), pre_run_context: preRunContext, skill_instructions: structuredClone(session.skill_instructions || []), turn_message: sourceMessage };
  }

  assertOwnership(session, execution) {
    if (execution) demand(session.ownership?.kind === execution.kind && session.ownership.client_id === execution.clientID
      && session.agent === execution.agent, "Conversation is outside this registration", "forbidden");
    else demand(!session.ownership || session.ownership.kind === "operator", "Conversation is registered-client owned", "forbidden");
  }

  registeredSession(id, execution) {
    const session = this.session(id);
    this.assertOwnership(session, execution);
    return session;
  }

  active(session) {
    return session.status === "active" && session.active && Number(session.active.expires_at_ms) > this.now();
  }

  assertTurn(id, token) {
    const session = this.session(id);
    demand(this.active(session) && session.active.token === token, "Agent turn authority expired or changed", "agent_turn_changed");
    return session;
  }

  async invoke({ session_id, token, tool, input, confirmed = false, idempotency_key = "" }, execution = null) {
    const session = this.assertTurn(session_id, token);
    this.assertOwnership(session, execution);
    const capability = session.capabilities.find(item => item.name === tool);
    demand(capability, `Tool ${tool} is not in this agent's pinned allowlist`, "forbidden");
    if (capability.effect === "write") {
      const mode = session.definition.autonomy.write_tools;
      demand(mode !== "deny", `${tool} is a write tool and this agent denies write tools`, "forbidden");
      demand(mode === "allow" || confirmed === true, `${tool} requires operator confirmation`, "agent_confirmation_required");
    }
    const principal = principalFor(session.definition);
    if (execution) {
      execution.check();
      demand(confirmed === false, "Applications cannot confirm writes", "forbidden");
      assertRegisteredCapability(this.service, capability.entry_id, capability.digest, principal, capability.grant_id);
    }
    const started = this.now();
    const run = this.service.invoke(principal, {
      operation: "invoke", tool: capability.entry_id, grant_id: capability.grant_id, input,
      idempotency_key: idempotency_key || toolIdempotencyKey(session_id, session.active.turn_id, tool, input),
    }, null, { allowExternalWrite: capability.effect !== "write" || session.definition.autonomy.write_tools === "allow" || confirmed === true, execution });
    await this.service.active.get(run.id)?.promise;
    const complete = this.store.run(run.id);
    demand(complete?.status === "succeeded", complete?.error || `Tool ${tool} failed`, complete?.error_code || "agent_tool_failed");
    return { output: complete.output, run_id: complete.id, duration_ms: Math.max(0, this.now() - started), capability: publicCapability(capability) };
  }

  pause({ session_id, token, proposal }) {
    const session = this.assertTurn(session_id, token);
    this.assertOwnership(session, null);
    demand(proposal && typeof proposal === "object", "Confirmation proposal is required", "invalid_request");
    session.status = "pending_confirmation";
    session.pending = { ...proposal, turn_idempotency_key: session.active.idempotency_key,
      proposal_id: proposal.proposal_id || `proposal_${randomUUID()}`, created_at: nowIso(this.now) };
    session.active = null; session.updated_at = nowIso(this.now);
    this.store.put(SESSION_KIND, session_id, session);
    return { session: this.publicSession(session), pending: structuredClone(session.pending) };
  }

  resume({ session_id, proposal_id, deny = false }) {
    const session = this.session(session_id);
    this.assertOwnership(session, null);
    demand(session.status === "pending_confirmation" && session.pending, `Session ${session_id} is not waiting for confirmation`, "agent_confirmation_missing");
    demand(session.pending.proposal_id === proposal_id, "Confirmation proposal changed", "agent_turn_changed");
    const pending = session.pending;
    demand(!pending.expires_at || Date.parse(pending.expires_at) > this.now(), "Confirmation proposal expired", "agent_turn_changed");
    const token = randomUUID();
    session.status = "active";
    session.active = {
      token, turn_id: pending.turn_id, message: pending.message, source_message: pending.source_message || pending.message, started_at: pending.started_at,
      idempotency_key: pending.turn_idempotency_key || "",
      expires_at_ms: this.now() + Math.max(ACTIVE_TTL_MS, session.definition.limits.wall_seconds * 1000 + 60_000),
    };
    session.pending = null; session.updated_at = nowIso(this.now);
    this.store.put(SESSION_KIND, session_id, session);
    return { session: this.publicSession(session), token, pending, denied: deny === true };
  }

  complete({ session_id, token, reply, tool_calls = [], usage = null }, execution = null) {
    const session = this.assertTurn(session_id, token);
    this.assertOwnership(session, execution);
    const active = session.active;
    const turn = {
      id: active.turn_id, message: active.message, source_message: active.source_message || active.message, idempotency_key: active.idempotency_key || "", reply: String(reply || ""), tool_calls: structuredClone(tool_calls),
      usage: usage ? structuredClone(usage) : null, started_at: active.started_at, completed_at: nowIso(this.now),
    };
    session.messages.push({ role: "user", content: active.message }, { role: "assistant", content: turn.reply });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    session.turns.push(turn); session.status = "idle"; session.active = null; session.pending = null; session.updated_at = turn.completed_at;
    this.store.put(SESSION_KIND, session_id, session);
    return { session: this.publicSession(session), turn };
  }

  abort({ session_id, token, error = "" }, execution = null) {
    const session = this.assertTurn(session_id, token);
    this.assertOwnership(session, execution);
    session.status = "idle"; session.active = null; session.pending = null; session.updated_at = nowIso(this.now);
    if (error) session.last_error = String(error).slice(0, 1000);
    this.store.put(SESSION_KIND, session_id, session);
    return this.publicSession(session);
  }

  get(id) { const session = this.session(id); this.assertOwnership(session, null); return structuredClone(session); }
  list(agent = "") { return this.store.list(SESSION_KIND).filter(item => (!item.ownership || item.ownership.kind === "operator") && (!agent || item.agent === agent)).map(item => this.publicSession(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }

  publicSession(session) {
    return {
      id: session.id, agent: session.agent, agent_digest: session.agent_digest, status: session.status,
      created_at: session.created_at, updated_at: session.updated_at, turns: session.turns.length,
      pending: session.pending ? [{ proposal_id: session.pending.proposal_id, tool: session.pending.tool, summary: session.pending.summary, arguments_digest: session.pending.arguments_digest, expires_at: session.pending.expires_at }] : [],
    };
  }

  resolveSkill(definition, identity) {
    demand(/^[a-z][a-z0-9-]*(?:@[^@]+)?$/.test(identity), `Skill ${identity} is not a valid published skill reference`, "skill_unavailable");
    return this.skills.resolveReference(identity,
      definition.scope.kind === "repository" ? definition.scope.repo_id : definition.scope.kind === "folder" ? repositoryID(definition.scope.folder_path) : "",
      definition.scope.kind === "folder" ? definition.scope.folder_path : "");
  }

  resolveCapabilities(definition, suppliedPromptResults = [], execution = null) {
    const principal = principalFor(definition);
    const capabilities = [], injected = [];
    const supplied = new Map((Array.isArray(suppliedPromptResults) ? suppliedPromptResults : []).map(item => [String(item?.name || ""), item?.result]));
    for (const name of definition.tools) {
      demand(!name.startsWith("bossy."), `${name} is a Bossy fleet tool and is not yet available in Posse agent sessions`, "capability_unavailable");
      if (this.promptTools && this.store.get("prompt_tools", name)) {
        const promptTool = this.promptTools.load(name);
        demand(supplied.has(name), `The first turn requires caller-supplied result ${name}`, "prompt_tool_result_missing");
        injected.push({ name, description: promptTool.definition.description, digest: promptTool.digest, result: structuredClone(supplied.get(name)) });
        supplied.delete(name);
        continue;
      }
      if (this.sqlCapabilities && this.store.get("sql_capabilities", name)) {
        const sql = this.sqlCapabilities.load(name), entry = this.store.get("entries", this.sqlCapabilities.entryID(name));
        demand(entry?.enabled && entry.digest === sql.digest, `${name} has no passing test for its current definition`, "sql_capability_unavailable");
        capabilities.push(this.capability(entry, principal, { name, kind: "sql", description: sql.definition.description, parameters: sql.definition.input_schema, effect: "read" }, execution));
        continue;
      }
      const tool = this.scripts.load(name), entry = this.store.get("entries", this.scripts.entryID(name));
      demand(entry?.enabled && entry.digest === tool.digest, `${name} has no passing test for its current version`, "script_unavailable");
      capabilities.push(this.capability(entry, principal, { name, kind: "script", description: tool.manifest.description, parameters: tool.manifest.params, effect: tool.manifest.effect }, execution));
    }
    demand(supplied.size === 0, `Unknown prompt tool result ${[...supplied.keys()][0]}`, "prompt_tool_result_unknown");
    const instructions = [];
    for (const identity of definition.skills) {
      const skill = this.resolveSkill(definition, identity);
      const entry = this.store.get("entries", this.skills.entryID(skill));
      if (skill.runtime.mode === "instructions") {
        demand(entry?.enabled && this.service.entryAvailable(entry), `Skill ${identity} or one of its tools is unavailable`, "skill_unavailable");
        instructions.push({ id: this.skills.identity(skill), digest: entry.digest, instructions: skill.instructions });
        for (const grant of skill.capabilities) {
          const toolEntry = grant.id.startsWith("script:") ? this.store.get("entries", grant.id)
            : this.store.get("entries", `builtin:${grant.id}@1`) || this.store.get("entries", grant.id);
          demand(toolEntry && toolEntry.kind !== "skill", `Skill tool ${grant.id} is unavailable`, "capability_unavailable");
          const toolName = grant.id.startsWith("script:") ? grant.id.slice(7) : grant.id;
          const extension = this.capability(toolEntry, principal, {
            name: toolName, kind: toolEntry.kind, description: toolEntry.description,
            parameters: toolEntry.input_schema, effect: toolEntry.effect === "read_only" ? "read" : "write",
          }, execution);
          const existing = capabilities.find(item => item.name === toolName);
          demand(!existing || existing.entry_id === extension.entry_id && existing.digest === extension.digest,
            `Agent capability name ${toolName} is ambiguous`, "agent_invalid");
          if (!existing) capabilities.push(extension);
        }
        continue;
      }
      capabilities.push(this.capability(entry, principal, {
        name: `skill.${skill.name}`, kind: "skill", description: skill.intent,
        parameters: skill.contract.input_schema, effect: skill.contract.effect === "read_only" ? "read" : "write",
      }, execution));
    }
    const names = new Set();
    for (const item of capabilities) { demand(!names.has(item.name), `Agent capability name ${item.name} is ambiguous`, "agent_invalid"); names.add(item.name); }
    return { capabilities, injected, instructions };
  }

  capability(entry, principal, surface, execution = null) {
    demand(entry?.enabled && this.service.entryAvailable(entry), `${surface.name} is unavailable`, "capability_unavailable");
    const grants = this.store.list("grants").filter(grant => grant.tool === entry.id && grant.digest === entry.digest && matchesGrant(grant, principal, "invoke"));
    demand(grants.length > 0, `${surface.name} has no grant for this agent's scope`, "forbidden");
    demand(grants.length === 1, `${surface.name} has multiple matching grants; keep one exact grant`, "ambiguous_grant");
    if (execution) {
      assertRegisteredCapability(this.service, entry.id, entry.digest, principal, grants[0].id);
      if (surface.effect === "write") demand(definitionAllowsWrite(execution.definition),
        `${surface.name} is a write tool and this agent does not allow write tools`, "forbidden");
    }
    return { ...surface, entry_id: entry.id, digest: entry.digest, grant_id: grants[0].id };
  }
}

function definitionAllowsWrite(definition) { return definition?.autonomy?.write_tools === "allow"; }
