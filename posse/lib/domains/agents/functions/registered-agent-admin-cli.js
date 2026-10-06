import fs from "node:fs";
import { SystemRegisteredAgentManager } from "../../automation/classes/SystemRegisteredAgentManager.js";
import { AutomationOwnerClient } from "../../automation/classes/AutomationOwnerClient.js";
import { automationOperatorTokenPath } from "../../automation/functions/paths.js";

const USAGE = `Usage:
  posse agent clients create ID --agent NAME [--agent NAME] [--operation chat|run] [--context NAME]
  posse agent clients list
  posse agent clients rotate ID
  posse agent clients revoke ID
  posse agent trust approve ENTRY_ID --level application_safe|operator_only --reviewed-by ID
  posse agent trust list
  posse agent repository save REPO_ID ROOT
  posse agent service install --system --package-root /opt/posse-agent/current/posse
  posse agent service status --system
  posse agent service remove --system`;

function parseFlags(argv) {
  const flags = { agent: [], operation: [], context: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--agent", "--operation", "--context", "--level", "--reviewed-by"].includes(flag) || !argv[i + 1]) throw new Error(USAGE);
    const key = flag.slice(2).replaceAll("-", "_");
    if (["agent", "operation", "context"].includes(key)) flags[key].push(argv[++i]);
    else flags[key] = argv[++i];
  }
  return flags;
}

export async function runRegisteredAdminCli(argv, io = {}) {
  const [noun, verb, id, ...rest] = argv;
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
  const client = io.client || new AutomationOwnerClient({ operator: true,
    token: fs.readFileSync(automationOperatorTokenPath(), "utf8").trim(), timeoutMs: 5000 });
  let result;
  if (noun === "clients" && verb === "create" && id) {
    const flags = parseFlags(rest);
    result = await client.request("agent.client.create", { id, agents: flags.agent,
      operations: flags.operation.length ? flags.operation : ["chat"], context_names: flags.context });
  } else if (noun === "clients" && verb === "list" && !id) result = await client.request("agent.client.list");
  else if (noun === "clients" && verb === "rotate" && id && !rest.length) result = await client.request("agent.client.rotate", { id });
  else if (noun === "clients" && verb === "revoke" && id && !rest.length) result = await client.request("agent.client.revoke", { id });
  else if (noun === "trust" && verb === "approve" && id) {
    const flags = parseFlags(rest);
    result = await client.request("agent.trust.approve", { entry_id: id, trust_level: flags.level, reviewed_by: flags.reviewed_by });
  } else if (noun === "trust" && verb === "list" && !id) result = await client.request("agent.trust.list");
  else if (noun === "repository" && verb === "save" && id && rest.length === 1) {
    result = await client.request("agent.repository.save", { id, root: rest[0] });
  } else throw Object.assign(new Error(USAGE), { code: "invalid_request" });
  (io.stdout || process.stdout).write(`${JSON.stringify(result)}\n`);
  return 0;
}
