import fs from "node:fs";
import { SystemRegisteredAgentManager } from "../../automation/classes/SystemRegisteredAgentManager.js";
import { AutomationOwnerClient } from "../../automation/classes/AutomationOwnerClient.js";
import { automationOperatorTokenPath } from "../../automation/functions/paths.js";
import { SystemAgentRegistration } from "../classes/SystemAgentRegistration.js";

const USAGE = `Usage:
  posse agent clients create ID --agent NAME [--agent NAME] [--operation chat|run] [--context NAME]
  posse agent clients list
  posse agent clients rotate ID
  posse agent clients revoke ID
  posse agent repository save REPO_ID ROOT
  posse agent register NAME [--client ID] [--user USER] [--group GROUP] [--operation chat|run] [--context NAME] [--max-spend-usd USD] [--source-data-dir DIR] [--update-definition] [--package-root DIR] [--restore-preserving-conversations]
  posse agent registrations list [NAME]
  posse agent registrations show NAME [--client ID]
  posse agent registrations revoke NAME [--client ID]
  posse agent registrations retire-user UID
  posse agent service install --system --package-root /opt/posse-agent/current/posse
  posse agent service status --system
  posse agent service remove --system`;

function parseFlags(argv) {
  const flags = { agent: [], operation: [], context: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--agent", "--operation", "--context"].includes(flag) || !argv[i + 1]) throw new Error(USAGE);
    flags[flag.slice(2)].push(argv[++i]);
  }
  return flags;
}

export async function runRegisteredAdminCli(argv, io = {}) {
  const [noun, verb, id, ...rest] = argv;
  if (noun === "register") {
    if (!verb || !/^[a-z][a-z0-9._-]{0,63}$/.test(verb)) throw Object.assign(new Error(USAGE), { code: "invalid_request" });
    const values = { users: [], groups: [], operations: [], contextNames: [] };
    const map = { "--user": "users", "--group": "groups", "--operation": "operations", "--context": "contextNames" };
    const singles = { "--client": "clientID", "--max-spend-usd": "maxSpendUsd", "--source-data-dir": "sourceDataDir", "--package-root": "packageRoot" };
    for (let index = 2; index < argv.length; index += 2) {
      const flag = argv[index], value = argv[index + 1];
      if (flag === "--restore-preserving-conversations") {
        values.restorePreservingConversations = true; index--; continue;
      }
      if (flag === "--update-definition") {
        values.updateDefinition = true; index--; continue;
      }
      if (!value || (!map[flag] && !singles[flag])) throw Object.assign(new Error(USAGE), { code: "invalid_request" });
      if (map[flag]) values[map[flag]].push(value);
      else values[singles[flag]] = flag === "--max-spend-usd" ? Number(value) : value;
    }
    if (!values.operations.length) values.operations = ["chat"];
    const result = await (io.registration || new SystemAgentRegistration()).register({ agent: verb, ...values });
    (io.stdout || process.stdout).write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (noun === "service") {
    const root = id === "--system" && rest[0] === "--package-root" ? rest[1] : "";
    if (id !== "--system" || verb === "install" && (!root || rest.length !== 2)
      || verb !== "install" && rest.length) throw Object.assign(new Error(USAGE), { code: "invalid_request" });
    const manager = new SystemRegisteredAgentManager({ packageRoot: root });
    const result = verb === "install" ? manager.install() : verb === "status" ? manager.status() : verb === "remove" ? manager.remove() : null;
    if (!result) throw Object.assign(new Error(USAGE), { code: "invalid_request" });
    (io.stdout || process.stdout).write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const system = noun === "registrations";
  const client = io.client || new AutomationOwnerClient({ operator: true,
    token: fs.readFileSync(system ? "/var/lib/posse-agent/automation.operator-token" : automationOperatorTokenPath(), "utf8").trim(),
    ...(system ? { socketPath: "/var/lib/posse-agent/automation.sock" } : {}), timeoutMs: 5000 });
  let result;
  if (noun === "clients" && verb === "create" && id) {
    const flags = parseFlags(rest);
    result = await client.request("agent.client.create", { id, agents: flags.agent,
      operations: flags.operation.length ? flags.operation : ["chat"], context_names: flags.context });
  } else if (noun === "clients" && verb === "list" && !id) result = await client.request("agent.client.list");
  else if (noun === "clients" && verb === "rotate" && id && !rest.length) result = await client.request("agent.client.rotate", { id });
  else if (noun === "clients" && verb === "revoke" && id && !rest.length) result = await client.request("agent.client.revoke", { id });
  else if (noun === "repository" && verb === "save" && id && rest.length === 1) {
    result = await client.request("agent.repository.save", { id, root: rest[0] });
  } else if (noun === "registrations" && verb === "list" && !rest.length) {
    const rows = await client.request("agent.exposure.list");
    result = id ? rows.filter(item => item.policy?.agent === id || item.pending_policy?.agent === id) : rows;
  } else if (noun === "registrations" && ["show", "revoke"].includes(verb) && id) {
    const selectedClient = rest.length === 2 && rest[0] === "--client" ? rest[1] : "";
    if (rest.length && !selectedClient) throw Object.assign(new Error(USAGE), { code: "invalid_request" });
    const rows = await client.request("agent.exposure.list");
    const matches = rows.filter(item => item.id === `${id}:${selectedClient || "@local"}`);
    if (matches.length !== 1) throw Object.assign(new Error("Registration is unavailable"), { code: "agent_not_found" });
    result = verb === "show" ? matches[0] : await client.request("agent.exposure.revoke", { id: matches[0].id });
  }
  else if (noun === "registrations" && verb === "retire-user" && id && !rest.length) result = await client.request("agent.exposure.retire_user", { uid: id });
  else throw Object.assign(new Error(USAGE), { code: "invalid_request" });
  (io.stdout || process.stdout).write(`${JSON.stringify(result)}\n`);
  return 0;
}
