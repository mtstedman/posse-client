import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { demand, digest } from "../functions/policy.js";

const TABLE = "agent_exposures";
const EPOCHS = "registered_os_epochs";
const CLIENTS = "registered_clients";
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;

function lookup(kind, value) {
  const result = spawnSync("getent", [kind, String(value)], { encoding: "utf8", timeout: 3000 });
  demand(result.status === 0, `Unknown OS ${kind === "passwd" ? "user" : "group"}`, "invalid_request");
  const parts = result.stdout.trim().split(":");
  const id = Number(parts[kind === "passwd" ? 2 : 2]);
  demand(Number.isSafeInteger(id) && id >= 0, "Invalid OS identity", "invalid_request");
  return { name: parts[0], id };
}

function currentAccount(identity) {
  const account = lookup("passwd", identity.uid);
  demand(account.name === identity.user, "OS account changed", "forbidden");
  const result = spawnSync("id", ["-G", account.name], { encoding: "utf8", timeout: 3000 });
  demand(result.status === 0, "OS group lookup failed", "forbidden");
  const groups = result.stdout.trim().split(/\s+/).map(Number);
  demand(groups.every(group => Number.isSafeInteger(group) && group >= 0), "Invalid OS groups", "forbidden");
  return { uid: identity.uid, user: account.name,
    groups: groups.filter(group => identity.groups.includes(group)) };
}

function audienceAllows(policy, caller) {
  return policy.audience.global || policy.audience.users.some(user => user.id === caller.uid && user.name === caller.user)
    || policy.audience.groups.some(group => caller.groups.includes(group.id)
      && lookup("group", group.id).name === group.name);
}

function noBroader(next, previous) {
  const audience = previous.audience.global || !next.audience.global
    && next.audience.users.every(user => previous.audience.users.some(old => old.id === user.id && old.name === user.name))
    && next.audience.groups.every(group => previous.audience.groups.some(old => old.id === group.id && old.name === group.name));
  return audience && next.operations.every(operation => previous.operations.includes(operation))
    && next.context_names.every(name => previous.context_names.includes(name))
    && next.max_spend_usd <= previous.max_spend_usd && next.agent_digest === previous.agent_digest;
}

export class AgentExposureRegistry {
  constructor(owner) { this.owner = owner; this.store = owner.store; }

  key(agent, clientID = "") { return `${agent}:${clientID || "@local"}`; }

  stage({ agent, client_id = "", users = [], groups = [], operations = ["chat"], context_names = [], max_spend_usd = 100 }) {
    demand(NAME.test(agent) && (!client_id || NAME.test(client_id)), "Invalid registration name", "invalid_request");
    demand(Array.isArray(users) && Array.isArray(groups) && users.every(x => typeof x === "string")
      && groups.every(x => typeof x === "string"), "Invalid OS audience", "invalid_request");
    demand(!client_id || users.length + groups.length > 0, "Named clients require an explicit audience", "invalid_request");
    demand(Array.isArray(operations) && operations.length > 0 && operations.every(x => ["chat", "run"].includes(x))
      && Array.isArray(context_names) && context_names.every(x => NAME.test(x)), "Invalid registration allowlist", "invalid_request");
    demand(Number.isFinite(max_spend_usd) && max_spend_usd > 0 && max_spend_usd <= 10000,
      "Invalid exposure budget", "invalid_request");
    const loaded = this.owner.registered.validateAgent(agent);
    const policy = { agent, client_id, audience: { global: users.length + groups.length === 0,
      users: [...new Map(users.map(name => { const item = lookup("passwd", name); return [item.id, item]; })).values()],
      groups: [...new Map(groups.map(name => { const item = lookup("group", name); return [item.id, item]; })).values()] },
    operations: [...new Set(operations)], context_names: [...new Set(context_names)],
    max_spend_usd, agent_digest: loaded.digest };
    const key = this.key(agent, client_id);
    return this.store.transaction(() => {
      const old = this.store.get(TABLE, key);
      demand(old?.status !== "revoked", "Revoked exposure cannot be reused", "forbidden");
      if (old?.status === "active" && digest(old.policy) === digest(policy)) return old;
      if (old?.status === "pending_update") {
        if (digest(old.pending_policy) === digest(policy)) return old;
        demand(noBroader(policy, old.pending_policy),
          "A pending restrictive update cannot restore removed authority", "forbidden");
      }
      const record = { id: key, status: old?.policy ? "pending_update" : "pending", policy: old?.policy || null,
        pending_policy: policy, revision: (old?.revision || 0) + 1, created_at: old?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString() };
      this.store.put(TABLE, key, record);
      return record;
    });
  }

  activate(id, revision) {
    return this.store.transaction(() => {
      const item = this.store.get(TABLE, id);
      demand(item && item.revision === revision && ["pending", "pending_update"].includes(item.status),
        "Exposure revision changed", "grant_changed");
      demand(this.owner.registered.validateAgent(item.pending_policy.agent).digest === item.pending_policy.agent_digest,
        "Agent changed after exposure staging", "grant_changed");
      if (item.pending_policy.client_id) {
        const client = this.store.get(CLIENTS, item.pending_policy.client_id);
        demand(client?.enabled && client.agents.includes(item.pending_policy.agent)
          && item.pending_policy.operations.every(operation => client.operations.includes(operation))
          && item.pending_policy.context_names.every(name => client.context_names.includes(name)),
        "Named client changed after exposure staging", "grant_changed");
      }
      item.policy = item.pending_policy; item.pending_policy = null; item.status = "active";
      item.updated_at = new Date().toISOString(); this.store.put(TABLE, id, item);
      return item;
    });
  }

  revoke(id) {
    const item = this.store.get(TABLE, id);
    demand(item, "Exposure unavailable", "forbidden");
    item.status = "revoked"; item.revision++; item.updated_at = new Date().toISOString();
    this.store.put(TABLE, id, item);
    this.owner.registered.cancel();
    return item;
  }

  restore(id) {
    return this.store.transaction(() => {
      const item = this.store.get(TABLE, id);
      demand(item?.status === "revoked", "Only a revoked exposure can be restored", "forbidden");
      item.status = "pending"; item.policy = null; item.pending_policy = null;
      item.revision++; item.restored_at = new Date().toISOString(); item.updated_at = item.restored_at;
      this.store.put(TABLE, id, item);
      return item;
    });
  }

  list() { return this.store.list(TABLE); }

  probe(agent, identity) {
    const caller = currentAccount(identity);
    const items = this.list().filter(item => item.pending_policy?.agent === agent
      && ["pending", "pending_update"].includes(item.status)
      && audienceAllows(item.pending_policy, caller));
    demand(items.length === 1, "Agent is not staged for this caller", "forbidden");
    this.owner.registered.validateAgent(agent);
    return { ready: true, agent, exposure_id: items[0].id };
  }

  legacyAllowed(clientID, agent) {
    const item = this.store.get(TABLE, this.key(agent, clientID));
    demand(!item, "This client requires local OS authentication", "forbidden");
  }

  authorize(request, identity) {
    const caller = currentAccount(identity);
    let clientID = String(request.client_id || "");
    if (!clientID && !this.store.get(TABLE, this.key(request.agent))) {
      const candidates = this.list().filter(value => value.policy?.agent === request.agent
        && value.policy.client_id && ["active", "pending_update"].includes(value.status)
        && audienceAllows(value.policy, caller));
      demand(candidates.length <= 1, "Ambiguous registered client for caller", "forbidden");
      clientID = candidates[0]?.policy.client_id || "";
    }
    const item = this.store.get(TABLE, this.key(request.agent, clientID));
    demand(item?.status === "active" || item?.status === "pending_update", "Agent is not registered for this caller", "forbidden");
    const policies = [item.policy, ...(item.status === "pending_update" ? [item.pending_policy] : [])];
    for (const policy of policies) {
      demand(audienceAllows(policy, caller) && policy.operations.includes(request.operation)
        && (request.request.pre_run_context || []).every(context => policy.context_names.includes(context.name)),
      "Caller is outside this exposure", "forbidden");
    }
    demand(this.owner.agentDefinitions.load(request.agent).digest === item.policy.agent_digest,
      "Agent definition changed", "capability_unavailable");
    let registration;
    if (clientID) {
      registration = this.store.get(CLIENTS, clientID);
      demand(registration?.enabled && registration.agents.includes(request.agent)
        && registration.operations.includes(request.operation)
        && (request.request.pre_run_context || []).every(context => registration.context_names.includes(context.name)),
      "Named client unavailable", "forbidden");
      if (request.credential !== undefined) {
        demand(request.client_id === clientID, "Named client mismatch", "forbidden");
        registration = this.owner.registered.authenticate(request);
      }
    } else {
      const epoch = this.epoch(caller.uid);
      const id = `local-${digest([request.agent, caller.uid, epoch]).slice(0, 44)}`;
      registration = this.store.get(CLIENTS, id);
      if (!registration) {
        const created = this.owner.registered.create({ id, agents: [request.agent], operations: ["chat", "run"],
          context_names: [...new Set([...item.policy.context_names, ...(item.pending_policy?.context_names || [])])],
          max_spend_usd: 10000 });
        registration = this.store.get(CLIENTS, id);
        registration.local_only = true; registration.os_uid = caller.uid; registration.epoch = epoch;
        this.store.put(CLIENTS, id, registration);
        // The bearer is deliberately discarded; only the trusted local gateway can use this identity.
        void created;
      }
      const neededContexts = [...new Set([...item.policy.context_names, ...(item.pending_policy?.context_names || [])])];
      if (neededContexts.some(name => !registration.context_names.includes(name))) {
        registration.context_names = [...new Set([...registration.context_names, ...neededContexts])];
        registration.revision++; this.store.put(CLIENTS, id, registration);
      }
      demand(registration.enabled && registration.os_uid === caller.uid && registration.epoch === epoch,
        "Local identity changed", "forbidden");
    }
    return { registration, exposure: item, caller };
  }

  epoch(uid) {
    let value = this.store.get(EPOCHS, String(uid));
    if (!value) { value = { generation: crypto.randomUUID() }; this.store.put(EPOCHS, String(uid), value); }
    return value.generation;
  }

  retireUser(uid) {
    const number = Number(uid);
    demand(Number.isSafeInteger(number) && number >= 0, "Invalid OS UID", "invalid_request");
    const old = this.store.get(EPOCHS, String(number));
    const next = { generation: crypto.randomUUID(), retired_at: new Date().toISOString() };
    this.store.transaction(() => {
      this.store.put(EPOCHS, String(number), next);
      for (const client of this.store.list(CLIENTS)) if (client.local_only && client.os_uid === number) {
        client.enabled = false; client.revision++; this.store.put(CLIENTS, client.id, client);
      }
      for (const item of this.list()) {
        let changed = false;
        for (const policy of [item.policy, item.pending_policy]) if (policy?.client_id) {
          const before = policy.audience.users.length;
          policy.audience.users = policy.audience.users.filter(user => user.id !== number);
          changed ||= policy.audience.users.length !== before;
          if (before !== policy.audience.users.length && !policy.audience.global
            && !policy.audience.users.length && !policy.audience.groups.length) item.status = "revoked";
        }
        if (changed) { item.revision++; item.updated_at = new Date().toISOString(); this.store.put(TABLE, item.id, item); }
      }
    });
    this.owner.registered.cancel();
    return { uid: number, previous_generation: old?.generation || null, generation: next.generation };
  }
}
