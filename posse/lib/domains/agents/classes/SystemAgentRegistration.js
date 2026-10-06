import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { AutomationOwnerClient } from "../../automation/classes/AutomationOwnerClient.js";
import { SystemRegisteredAgentManager } from "../../automation/classes/SystemRegisteredAgentManager.js";
import { demand, digest } from "../../automation/functions/policy.js";
import { agentDefinitionDigest } from "../functions/definition.js";

const DATA = "/var/lib/posse-agent";

function defaultSourceDir() {
  const sudoUser = process.env.SUDO_USER;
  if (!sudoUser) return path.join(os.homedir(), ".posse");
  const result = spawnSync("getent", ["passwd", sudoUser], { encoding: "utf8", timeout: 3000 });
  demand(result.status === 0, "Sudo operator account is unavailable", "invalid_request");
  return path.join(result.stdout.trim().split(":")[5], ".posse");
}

function osUserForGroup(group) {
  const query = spawnSync("getent", ["group", group], { encoding: "utf8" });
  demand(query.status === 0, `Unknown OS group ${group}`, "invalid_request");
  const fields = query.stdout.trim().split(":");
  const members = fields[3]?.split(",").filter(Boolean) || [];
  if (members.length) return members[0];
  const accounts = spawnSync("getent", ["passwd"], { encoding: "utf8" });
  demand(accounts.status === 0, "Cannot enumerate OS accounts", "invalid_request");
  const account = accounts.stdout.split("\n").map(line => line.split(":"))
    .find(parts => parts.length >= 4 && parts[3] === fields[2]);
  demand(account, `Group ${group} has no account to probe`, "invalid_request");
  return account[0];
}

export class SystemAgentRegistration {
  constructor({ managerClass = SystemRegisteredAgentManager, clientClass = AutomationOwnerClient } = {}) {
    this.managerClass = managerClass; this.clientClass = clientClass;
  }

  async register({ agent, clientID = "", users = [], groups = [], operations = ["chat"], contextNames = [],
    packageRoot = "/opt/posse-agent/current/posse", sourceDataDir = "", maxSpendUsd = 100,
    restorePreservingConversations = false }) {
    demand(process.platform === "linux" && process.getuid() === 0, "Registration requires Linux root", "forbidden");
    demand(!clientID || users.length + groups.length > 0, "Named clients require --user or --group", "invalid_request");
    demand(fs.existsSync("/etc/posse-agent/owner.env"),
      "System owner environment file is missing", "capability_unavailable");
    const manager = new this.managerClass({ packageRoot });
    const service = manager.install();
    demand(service.active && service.gateway_active, "Registered owner is not running", "owner_unavailable");
    const tokenPath = path.join(DATA, "automation.operator-token");
    const client = new this.clientClass({ operator: true, token: fs.readFileSync(tokenPath, "utf8").trim(),
      socketPath: path.join(DATA, "automation.sock"), timeoutMs: 5000 });
    const loaded = await this.ensureDefinition(client, agent, sourceDataDir);
    demand(loaded.definition?.limits?.spend_usd <= maxSpendUsd,
      "Exposure spend budget is below one agent turn", "agent_budget_exceeded");
    const model = String(loaded.definition?.model || "").split(":")[0].toUpperCase();
    const ownerEnv = fs.readFileSync("/etc/posse-agent/owner.env", "utf8");
    const envValues = new Map(ownerEnv.split("\n").filter(line => line.trim() && !line.trimStart().startsWith("#"))
      .map(line => { const separator = line.indexOf("="); return separator < 0 ? ["", ""]
        : [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
    demand(envValues.get("POSSE_KEY"), "System owner POSSE_KEY is not configured", "capability_unavailable");
    demand(!envValues.has("POSSE_NATIVE_BIN_ROOT"), "System owner native bin root must be the verified release", "forbidden");
    if (["ANTHROPIC", "OPENAI"].includes(model)) demand(envValues.get(`${model}_API_KEY`),
      `System owner ${model} provider credential is not configured`, "capability_unavailable");
    const nativeModule = pathToFileURL(path.join(fs.realpathSync(packageRoot), "lib/shared/tools/classes/BinaryManager.js"));
    const { BinaryManager } = await import(nativeModule.href);
    const nativeBinaries = new BinaryManager({ env: { ...process.env, ...Object.fromEntries(envValues) } });
    demand(nativeBinaries.shouldUse("remote"), "System owner native remote client is unavailable", "capability_unavailable");
    const nativePath = fs.realpathSync(nativeBinaries.binary("remote").resolvePath());
    demand(nativePath.startsWith(fs.realpathSync(packageRoot) + path.sep),
      "Native remote client is outside the verified release", "forbidden");
    let existing = null;
    if (clientID) {
      const clients = await client.request("agent.client.list");
      existing = clients.find(item => item.id === clientID);
      if (existing) demand(existing.enabled && existing.agents.includes(agent)
        && existing.max_spend_usd >= loaded.definition.limits.spend_usd,
        "Existing named client does not authorize this agent", "forbidden");
    }
    if (restorePreservingConversations) {
      const rows = await client.request("agent.exposure.list");
      const id = `${agent}:${clientID || "@local"}`;
      demand(rows.some(item => item.id === id && item.status === "revoked"),
        "Only a revoked exposure can be restored", "forbidden");
      await client.request("agent.exposure.restore", { id });
    }
    const exposure = await client.request("agent.exposure.stage", { agent, client_id: clientID,
      users, groups, operations, context_names: contextNames, max_spend_usd: maxSpendUsd });
    if (clientID && !existing) await client.request("agent.client.create", { id: clientID, agents: [agent],
      operations, context_names: contextNames, max_spend_usd: maxSpendUsd });
    else if (existing && (operations.some(op => !existing.operations.includes(op))
      || contextNames.some(name => !existing.context_names.includes(name))))
      await client.request("agent.client.extend_exposure", { id: clientID, agent,
        operations, context_names: contextNames });
    if (exposure.status !== "active") {
      const audience = new Set([...users, ...groups.map(osUserForGroup)]);
      if (!audience.size) audience.add("nobody");
      for (const user of audience) {
        const probe = spawnSync("runuser", ["-u", user, "--", "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
          service.launcher, "probe", agent, "--json"], { encoding: "utf8", timeout: 10_000 });
        let result = null;
        try { result = JSON.parse(probe.stdout); } catch {}
        demand(probe.status === 0 && result?.ready === true && result.exposure_id === exposure.id,
          `Registration probe failed for OS user ${user}`, "forbidden");
      }
      await client.request("agent.exposure.activate", { id: exposure.id, revision: exposure.revision });
    }
    return { agent, client_id: clientID || null, audience: users.length || groups.length ? { users, groups } : "global",
      operations, status: "active", invocation: `${service.launcher} chat ${agent} --idempotency-key KEY --request-json --json`,
      service: manager.status() };
  }

  async ensureDefinition(client, agent, sourceDataDir = "") {
    const get = () => client.request("agent.definition.get", { name: agent }).catch(error => {
      if (error.code === "agent_not_found") return null;
      throw error;
    });
    let loaded = await get();
    if (!loaded || sourceDataDir) {
      const source = sourceDataDir || defaultSourceDir();
      if (fs.existsSync(path.join(source, "automation.db"))) await this.transferDefinition(client, source, agent);
      loaded = await get();
    }
    if (!loaded) throw Object.assign(new Error(`Agent ${agent} is absent from system owner; use --source-data-dir`),
      { code: "agent_not_found" });
    return loaded;
  }

  async transferDefinition(client, sourceDataDir, agent) {
    const filename = path.join(fs.realpathSync(sourceDataDir), "automation.db");
    demand(fs.statSync(filename).isFile(), "Source automation database is missing", "invalid_request");
    const source = new DatabaseSync(filename, { readOnly: true });
    try {
      const read = (kind, id) => {
        const row = source.prepare("SELECT value FROM automation_objects WHERE kind=? AND id=?").get(kind, id);
        return row ? JSON.parse(row.value) : null;
      };
      const record = read("agent_definitions", agent);
      demand(record?.definition, "Source agent definition is missing", "agent_not_found");
      demand(record.digest === agentDefinitionDigest(record.definition),
        "Source agent definition digest differs", "schema_mismatch");
      for (const name of record.definition.tools || []) {
        const prompt = read("prompt_tools", name);
        if (!prompt) continue;
        demand(prompt.digest === digest(prompt.definition),
          `Source prompt context ${name} digest differs`, "schema_mismatch");
        const target = await client.request("prompt_tool.show", { name }).catch(error => {
          if (error.code === "prompt_tool_not_found") return null;
          throw error;
        });
        if (!target) await client.request("prompt_tool.save", { definition: prompt.definition || prompt });
        else demand(target.digest === prompt.digest, `Prompt context ${name} differs in system owner`, "schema_mismatch");
      }
      const target = await client.request("agent.definition.get", { name: agent }).catch(error => {
        if (error.code === "agent_not_found") return null;
        throw error;
      });
      if (!target) await client.request("agent.definition.save", { definition: record.definition, create: true });
      else demand(target.digest === record.digest, "System agent definition digest differs from source", "schema_mismatch");
    } finally { source.close(); }
  }
}
