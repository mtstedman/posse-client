import readline from "node:readline/promises";

import { AgentDefinitionStore } from "../classes/AgentDefinitionStore.js";
import { AgentRuntime } from "../classes/AgentRuntime.js";

const VALUE_FLAGS = new Set(["--session", "--conversation", "--resume", "--message", "-m", "--provider"]);
const BOOLEAN_FLAGS = new Set(["--json", "--deny", "--help"]);
const COMMANDS = new Set(["list", "show", "new", "run", "chat", "confirm", "conversations", "export", "help"]);

export const AGENT_USAGE = `Usage:
  posse agent <name> [--session ID] [-m MESSAGE | stdin] [--json]
  posse agent chat <name> [--session ID]
  posse agent run <name> [--session ID] [-m MESSAGE | stdin] [--json]
  posse agent confirm <session-id> <proposal-id> [--deny] [--json]
  posse agent list [--json]
  posse agent show <name> [--json]
  posse agent new <name>
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
    else if (arg.startsWith("-")) throw Object.assign(new Error(`Unknown option ${arg}`), { code: "invalid_request" });
    else positional.push(arg);
  }
  return {
    positional, json: flags["--json"] === true, deny: flags["--deny"] === true, help: flags["--help"] === true,
    message: flags["--message"] ?? flags["-m"] ?? null,
    session: flags["--session"] ?? flags["--conversation"] ?? flags["--resume"] ?? "",
    provider: flags["--provider"] || "",
  };
}

export async function runAgentCli(argv = process.argv.slice(3), io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, stdin = io.stdin || process.stdin;
  const print = value => stdout.write(`${value}\n`);
  const args = parse(argv);
  if (args.help || !args.positional.length || args.positional[0] === "help") { print(AGENT_USAGE); return 0; }
  const definitions = io.definitions || new AgentDefinitionStore();
  const runtime = io.runtime || new AgentRuntime({ definitions });
  const first = args.positional.shift();
  const command = COMMANDS.has(first) ? first : "direct";
  if (command === "direct") args.positional.unshift(first);

  if (command === "list") {
    const rows = definitions.list().map(item => ({ name: item.name, valid: item.errors.length === 0, description: item.definition?.description || "", model: item.definition?.model || "", errors: item.errors }));
    if (args.json) print(JSON.stringify(rows));
    else if (!rows.length) print("No agents yet. Create one in Bossy or run: posse agent new <name>");
    else for (const row of rows) print(`${row.valid ? " " : "!"} ${row.name.padEnd(24)} ${row.valid ? `${row.model.padEnd(18)} ${row.description}` : row.errors.join("; ")}`.trimEnd());
    return 0;
  }
  if (command === "new") {
    requireCount(args.positional, 1, "posse agent new <name>");
    const created = definitions.create(args.positional[0]);
    print(args.json ? JSON.stringify({ name: created.definition.name, path: created.path, digest: created.digest }) : `created ${created.path}\nEdit it in Bossy Automation Studio → Agents, or with your editor.`);
    return 0;
  }
  if (command === "show") {
    requireCount(args.positional, 1, "posse agent show <name>");
    const loaded = definitions.load(args.positional[0]);
    if (args.json) print(JSON.stringify({ ...loaded.definition, digest: loaded.digest, path: loaded.path }));
    else {
      const d = loaded.definition;
      print(`${d.name} — ${d.description}\n  model       ${d.model}\n  scope       ${d.scope.kind}${d.scope.repo_id ? ` ${d.scope.repo_id}` : ""}\n  tools       ${d.tools.join(", ") || "none"}\n  skills      ${d.skills.join(", ") || "none"}\n  writes      ${d.autonomy.write_tools}${d.autonomy.write_tools === "allow" ? " (UNATTENDED)" : ""}\n  limits      ${d.limits.turns} turns · ${d.limits.calls} calls · $${d.limits.spend_usd} · ${d.limits.wall_seconds}s\n  digest      ${loaded.digest}\n  path        ${loaded.path}`);
    }
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
    const message = args.message == null ? await readMessage(stdin) : args.message;
    const envelope = await runtime.run({ agent: name, message, session: args.session, provider: args.provider, cwd: io.cwd || process.cwd() });
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
      let envelope = await runtime.run({ agent: name, message, session: activeSession, provider, cwd });
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
