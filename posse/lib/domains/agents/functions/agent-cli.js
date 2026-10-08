import readline from "node:readline/promises";
import fs from "node:fs";

import { AgentDefinitionStore } from "../classes/AgentDefinitionStore.js";
import { AgentRuntime } from "../classes/AgentRuntime.js";
import { runRegisteredAdminCli } from "./registered-agent-admin-cli.js";

const VALUE_FLAGS = new Set(["--session", "--conversation", "--resume", "--message", "-m", "--provider", "--idempotency-key"]);
const BOOLEAN_FLAGS = new Set(["--json", "--request-json", "--deny", "--help"]);
const COMMANDS = new Set(["list", "show", "new", "create", "save", "run", "chat", "confirm", "conversations", "export", "help"]);

export const AGENT_USAGE = `Usage:
  posse agent <name> [--session ID] [--idempotency-key KEY] [-m MESSAGE | stdin] [--json]
  posse agent chat <name> [--session ID]
  posse agent run <name> [--session ID] [-m MESSAGE | stdin] [--json]
  posse agent confirm <session-id> <proposal-id> [--deny] [--json]
  posse agent list [--json]
  posse agent show <name> [--json]
  posse agent new <name>
  posse agent create <name>
  posse agent register <name> [--user USER | --group GROUP] [--client ID]
  posse agent save <definition.json|->
  posse agent conversations [<name>] [--json]
  posse agent export <session-id> [--json]

Qualify a model as provider:model (for example codex:gpt-6.1-sol) or use
--provider to override the account's dev provider. The familiar cheap,
sonnet/standard, and opus/strong labels select that provider's matching tier.`;

function parse(argv) {
  const positional = [], flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++index];
      if (value === undefined) throw Object.assign(new Error(`${arg} needs a value`), { code: "invalid_request" });
      flags[arg] = String(value);
    } else if (BOOLEAN_FLAGS.has(arg)) flags[arg] = true;
    else if (arg !== "-" && arg.startsWith("-")) throw Object.assign(new Error(`Unknown option ${arg}`), { code: "invalid_request" });
    else positional.push(arg);
  }
  return {
    positional, json: flags["--json"] === true, requestJson: flags["--request-json"] === true, deny: flags["--deny"] === true, help: flags["--help"] === true,
    message: flags["--message"] ?? flags["-m"] ?? null,
    session: flags["--session"] ?? flags["--conversation"] ?? flags["--resume"] ?? "",
    provider: flags["--provider"] || "",
    idempotencyKey: flags["--idempotency-key"] || "",
  };
}

export async function runAgentCli(argv = process.argv.slice(3), io = {}) {
  if (["clients", "trust", "repository", "service", "register", "registrations"].includes(argv[0])) return runRegisteredAdminCli(argv, io);
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, stdin = io.stdin || process.stdin;
  const print = value => stdout.write(`${value}\n`);
  const args = parse(argv);
  if (args.help || !args.positional.length || args.positional[0] === "help") { print(AGENT_USAGE); return 0; }
  const definitions = io.definitions || null;
  const runtime = io.runtime || new AgentRuntime({ definitions });
  const definitionRequest = async (operation, args = {}) => {
    if (definitions) {
      if (operation === "agent.definition.list") return definitions.list();
      if (operation === "agent.definition.get") return definitions.load(args.name);
      if (operation === "agent.definition.create") return definitions.create(args.name);
    }
    const client = await runtime.owner();
    return client.request(operation, args);
  };
  const first = args.positional.shift();
  const command = COMMANDS.has(first) ? first : "direct";
  if (command === "direct") args.positional.unshift(first);

  if (command === "list") {
    const rows = (await definitionRequest("agent.definition.list")).map(item => ({ name: item.name, valid: item.errors.length === 0, description: item.definition?.description || "", model: item.definition?.model || "", errors: item.errors }));
    if (args.json) print(JSON.stringify(rows));
    else if (!rows.length) print("No agents yet. Create one in Bossy or run: posse agent new <name>");
    else for (const row of rows) print(`${row.valid ? " " : "!"} ${row.name.padEnd(24)} ${row.valid ? `${row.model.padEnd(18)} ${row.description}` : row.errors.join("; ")}`.trimEnd());
    return 0;
  }
  if (command === "new" || command === "create") {
    requireCount(args.positional, 1, "posse agent new <name>");
    const created = await definitionRequest("agent.definition.create", { name: args.positional[0] });
    print(args.json ? JSON.stringify({ name: created.definition.name, storage: created.storage, digest: created.digest }) : `created ${created.definition.name} in the central Posse database\nEdit it in Bossy Automation Studio → Agents.`);
    return 0;
  }
  if (command === "show") {
    requireCount(args.positional, 1, "posse agent show <name>");
    const loaded = await definitionRequest("agent.definition.get", { name: args.positional[0] });
    if (args.json) print(JSON.stringify({ ...loaded.definition, digest: loaded.digest, storage: loaded.storage }));
    else {
      const d = loaded.definition;
      const scopeBinding = d.scope.repo_id || d.scope.folder_path || "";
      print(`${d.name} — ${d.description}\n  model       ${d.model}\n  scope       ${d.scope.kind}${scopeBinding ? ` ${scopeBinding}` : ""}\n  tools       ${d.tools.join(", ") || "none"}\n  skills      ${d.skills.join(", ") || "none"}\n  writes      ${d.autonomy.write_tools}${d.autonomy.write_tools === "allow" ? " (UNATTENDED)" : ""}\n  limits      ${d.limits.turns} turns · ${d.limits.calls} calls · $${d.limits.spend_usd} · ${d.limits.wall_seconds}s\n  digest      ${loaded.digest}\n  storage     central Posse database`);
    }
    return 0;
  }
  if (command === "save") {
    requireCount(args.positional, 1, "posse agent save <definition.json|->");
    const filename = args.positional[0];
    let definition;
    try { definition = JSON.parse(filename === "-" ? await readMessage(stdin) : fs.readFileSync(filename, "utf8")); }
    catch (error) { throw Object.assign(new Error(`${filename} is not valid JSON: ${error.message}`), { code: "agent_invalid" }); }
    const client = await runtime.owner();
    let existing = false;
    try { await client.request("agent.definition.get", { name: definition?.name }); existing = true; }
    catch (error) { if (error?.code !== "agent_not_found") throw error; }
    const saved = await client.request("agent.definition.save", { definition, create: !existing });
    print(args.json ? JSON.stringify(saved) : `saved ${saved.definition.name} in the central Posse database at ${saved.digest.slice(0, 12)}`);
    return 0;
  }
  if (command === "conversations") {
    if (args.positional.length > 1) throw usageError("posse agent conversations [name]");
    const client = await runtime.owner();
    const rows = await client.request("agent.session.list", { agent: args.positional[0] || "" });
    if (args.json) print(JSON.stringify(rows));
    else if (!rows.length) print("No agent conversations yet.");
    else for (const row of rows) print(`  ${row.id.padEnd(28)} ${row.agent.padEnd(20)} ${row.status.padEnd(22)} ${row.turns} turn(s) · ${row.updated_at}`);
    return 0;
  }
  if (command === "export") {
    requireCount(args.positional, 1, "posse agent export <session-id>");
    const client = await runtime.owner(), session = await client.request("agent.session.get", { id: args.positional[0] });
    print(args.json ? JSON.stringify(session) : JSON.stringify(session, null, 2));
    return 0;
  }
  if (command === "confirm") {
    requireCount(args.positional, 2, "posse agent confirm <session-id> <proposal-id> [--deny]");
    const envelope = await runtime.confirm({ session: args.positional[0], proposal: args.positional[1], deny: args.deny, cwd: io.cwd || process.cwd() });
    return printEnvelope(envelope, args.json, print, stderr);
  }

  const chat = command === "chat" || (command === "direct" && args.message == null && stdin.isTTY);
  if (command === "run" || command === "chat" || command === "direct") {
    requireCount(args.positional, 1, `posse agent ${command === "direct" ? "<name>" : `${command} <name>`}`);
    const name = args.positional[0];
    if (chat) return await runChat({ runtime, name, session: args.session, provider: args.provider, stdin, stdout, stderr, cwd: io.cwd || process.cwd() });
    let request = { message: args.message == null ? await readMessage(stdin) : args.message };
    if (args.requestJson) {
      try { request = JSON.parse(request.message); } catch (error) { throw Object.assign(new Error(`Agent request is not valid JSON: ${error.message}`), { code: "invalid_request" }); }
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.message !== "string") throw Object.assign(new Error("Agent request JSON requires message"), { code: "invalid_request" });
    }
    const envelope = await runtime.run({
      agent: name, message: request.message, bootstrapMessage: request.bootstrap_message || "",
      preRunContext: request.pre_run_context || [], session: args.session, provider: args.provider,
      idempotencyKey: args.idempotencyKey, cwd: io.cwd || process.cwd(),
    });
    return printEnvelope(envelope, args.json, print, stderr);
  }
  throw usageError(AGENT_USAGE);
}

async function runChat({ runtime, name, session, provider, stdin, stdout, stderr, cwd }) {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let activeSession = session;
  try {
    stdout.write(`${name}${activeSession ? ` · session ${activeSession}` : ""} (type /exit to leave)\n`);
    while (true) {
      const message = (await terminal.question("> ")).trim();
      if (!message || message === "/exit") break;
      let envelope = await runtime.run({ agent: name, message, session: activeSession, provider, cwd,
        onProgress: event => { const line = progressLine(event); if (line) stderr.write(line); } });
      activeSession = envelope.conversation_id || activeSession;
      while (envelope.status === "needs_confirmation") {
        const pending = envelope.pending[0];
        stdout.write(`write request: ${pending.summary}\n`);
        const answer = (await terminal.question("Allow? [y/N] ")).trim().toLowerCase();
        envelope = await runtime.confirm({ session: activeSession, proposal: pending.proposal_id, deny: answer !== "y" && answer !== "yes", cwd });
      }
      if (envelope.status === "done") stdout.write(`${envelope.reply}\n`);
      else stderr.write(`${envelope.error?.code || "agent_error"}: ${envelope.error?.message || "Agent turn failed"}\n`);
    }
  } finally { terminal.close(); }
  return 0;
}

// Live activity for interactive chats; replies stay on stdout.
export function progressLine(event) {
  if (event?.type === "turn.started") return event.turn > 1 ? "  · reviewing results…\n" : "  · thinking…\n";
  if (event?.type === "turn.retry") return "  ↻ response ran long; retrying with more room\n";
  if (event?.type === "tool.started") return `  → ${event.tool}\n`;
  if (event?.type === "tool.finished") return `  ${event.status === "ok" ? "✓" : "✗"} ${event.tool} ${((Number(event.duration_ms) || 0) / 1000).toFixed(1)}s${event.error_code ? ` (${event.error_code})` : ""}\n`;
  return "";
}

function printEnvelope(envelope, json, print, stderr) {
  if (json) print(JSON.stringify(envelope));
  else if (envelope.status === "done") print(envelope.reply);
  else if (envelope.status === "needs_confirmation") {
    const pending = envelope.pending[0];
    print(`Write tool ${pending.tool} needs confirmation.\n${pending.summary}\nRun: posse agent confirm ${envelope.conversation_id} ${pending.proposal_id}`);
  } else stderr.write(`${envelope.error?.code || "agent_error"}: ${envelope.error?.message || "Agent turn failed"}\n`);
  return envelope.status === "done" ? 0 : envelope.status === "needs_confirmation" ? 2 : 1;
}

async function readMessage(stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1024 * 1024) throw Object.assign(new Error("Agent message exceeds 1 MiB"), { code: "invalid_request" });
  }
  const message = Buffer.concat(chunks).toString("utf8").trim();
  if (!message) throw Object.assign(new Error("Provide -m MESSAGE or pipe a message on stdin"), { code: "invalid_request" });
  return message;
}

function requireCount(values, count, usage) { if (values.length !== count) throw usageError(usage); }
function usageError(usage) { return Object.assign(new Error(`usage: ${usage}`), { code: "invalid_request" }); }
