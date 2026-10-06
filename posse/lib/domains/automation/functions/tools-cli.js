import fs from "node:fs";
import path from "node:path";
import { SCRIPT_TOOL_LIMITS, SCRIPT_TOOL_TEMPLATES } from "../../../catalog/custom-tools.js";
import { AutomationOwnerClient, ensureAutomationOwner } from "../classes/AutomationOwnerClient.js";

export const SCRIPT_TOOL_TEST_PROTOCOL = "posse.script_tool_test.v1";
const VALUE_FLAGS = new Set(["--template", "--description", "--effect", "--param", "--env", "--secret", "--input", "--input-file", "--inputs-file", "--repo", "--roles"]);
const BOOLEAN_FLAGS = new Set(["--json", "--standalone", "--unattended", "--help"]);

export const TOOLS_USAGE = `Usage:
  posse tools [list]                                   script tools, test state, secrets set
  posse tools new <name> [--template ${SCRIPT_TOOL_TEMPLATES.join("|")}] [--effect read|write]
        [--description TEXT] [--param name:type[:required]]... [--env NAME[=default]]... [--secret NAME]...
  posse tools show <name>                              params, env, secrets, test state, grants
  posse tools test <name> [--input JSON | --input-file PATH] [--inputs-file PATH] [--json]
                                                       run it; a pass publishes this exact version
  posse tools secret set <tool> <NAME>                 write-only; hidden prompt or piped stdin
  posse tools secret unset <tool> <NAME>
  posse tools secret list [<tool>]                     names and fingerprints, never values
  posse tools grant <name> [--repo PATH | --standalone] [--roles dev,researcher|*] [--unattended]
  posse tools revoke <grant-id>
  posse tools sql list
  posse tools sql show <name>
  posse tools sql save <definition.json|->              save to the central Posse database
  posse tools sql test <name> [--input JSON | --input-file PATH]
  posse tools sql grant <name> [--roles dev,researcher|*]
  posse tools prompt list
  posse tools prompt show <name>
  posse tools prompt save <definition.json|->              pre-run context declaration, stored centrally
  posse tools prompt remove <name>`;

function parse(argv) {
  const positional = [], flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++index];
      if (value === undefined) throw Object.assign(new Error(`${arg} needs a value`), { code: "invalid_request" });
      (flags[arg] ||= []).push(String(value));
    } else if (BOOLEAN_FLAGS.has(arg)) flags[arg] = true;
    else if (arg.startsWith("--")) throw Object.assign(new Error(`Unknown option ${arg}`), { code: "invalid_request" });
    else positional.push(arg);
  }
  const one = name => flags[name]?.at(-1);
  return { positional, flags, one, many: name => flags[name] || [], has: name => flags[name] === true };
}

// `posse tools …`: operator CLI over the automation owner's script operations.
export async function runToolsCli(argv = process.argv.slice(3), io = {}) {
  const out = io.stdout || process.stdout, err = io.stderr || process.stderr;
  const print = text => out.write(`${text}\n`);
  const args = parse(argv);
  const command = args.positional.shift() || "list";
  if (command === "help" || args.has("--help")) { print(TOOLS_USAGE); return 0; }
  const client = io.client || await defaultClient(command);
  const request = async (operation, payload) => {
    try { return await client.request(operation, payload); } catch (error) {
      if (/Unknown operator automation operation/.test(error?.message || "")) {
        throw Object.assign(new Error("The running automation owner predates script tools; restart it with `posse automation service install` (or stop the old owner) and retry"), { code: "owner_outdated" });
      }
      throw error;
    }
  };
  switch (command) {
    case "sql": return await runSqlCommand(args, request, io, print);
    case "prompt": return await runPromptCommand(args, request, io, print);
    case "list": {
      const tools = await request("script.list", {});
      if (args.has("--json")) { print(JSON.stringify(tools)); return 0; }
      if (!tools.length) { print("No script tools yet. Create one with: posse tools new <name> --template bash"); return 0; }
      for (const tool of tools) {
        if (tool.error) { print(`  ${tool.name.padEnd(28)} error: ${tool.error}`); continue; }
        const state = tool.tested ? "tested" : tool.stale ? "test stale" : "needs test";
        const secrets = tool.secrets.length ? ` secrets ${tool.secrets.filter(item => item.set).length}/${tool.secrets.length} set` : "";
        print(`  ${tool.name.padEnd(28)} ${tool.effect.padEnd(6)} ${state.padEnd(11)}${secrets}`.trimEnd());
      }
      return 0;
    }
    case "new": {
      if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools new <name> [options]"), { code: "invalid_request" });
      const created = await request("script.create", { spec: {
        name: args.positional[0], template: args.one("--template") || "bash", effect: args.one("--effect") || "read",
        description: args.one("--description") || "", params: args.many("--param"), env: args.many("--env"), secrets: args.many("--secret"),
      } });
      if (args.has("--json")) { print(JSON.stringify(created)); return 0; }
      print(`created ${created.name} (${created.manifest.effect} tool)\n  ${path.join(created.dir, "tool.json")}\n  ${path.join(created.dir, created.entry)}\n\nnext:`);
      let step = 0;
      print(`  ${++step}. edit ${path.join(created.dir, created.entry)}${created.manifest.description.startsWith("TODO") ? " and the description in tool.json" : ""}`);
      for (const item of created.manifest.env.filter(variable => variable.secret)) print(`  ${++step}. posse tools secret set ${created.name} ${item.name}`);
      print(`  ${++step}. posse tools test ${created.name} --input '${JSON.stringify(exampleInput(created.manifest.params))}'`);
      print(`  ${++step}. posse tools grant ${created.name} --repo <path> --roles dev   (so Posse agents can call it)`);
      return 0;
    }
    case "show": {
      if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools show <name>"), { code: "invalid_request" });
      const tool = await request("script.show", { name: args.positional[0] });
      if (args.has("--json")) { print(JSON.stringify(tool)); return 0; }
      const manifest = tool.manifest;
      print(`${manifest.name} — ${manifest.description}`);
      print(`  effect       ${manifest.effect}`);
      print(`  runs         ${manifest.interpreter} ${manifest.entry} (timeout ${manifest.timeout_seconds}s, output ≤ ${manifest.max_output_bytes} bytes)`);
      const required = new Set(manifest.params.required || []);
      const properties = Object.entries(manifest.params.properties || {});
      if (!properties.length) print("  params       none");
      for (const [name, schema] of properties) print(`  param        ${name} (${schema.type || "any"}${required.has(name) ? ", required" : ""}) → PARAM_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`);
      for (const [name, schema] of Object.entries(manifest.inputs?.properties || {})) print(`  caller input ${name} (${schema.type || "any"}) → PARAM_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`);
      const secretState = new Map(tool.secrets.map(item => [item.name, item]));
      for (const item of manifest.env) {
        if (!item.secret) { print(`  env          ${item.name} = ${JSON.stringify(item.default ?? "")}`); continue; }
        const state = secretState.get(item.name);
        print(state?.set ? `  secret       ${item.name} set ${state.fingerprint} (${state.set_at})` : `  secret       ${item.name} NOT SET — posse tools secret set ${manifest.name} ${item.name}`);
      }
      print(tool.tested ? `  test         passed — published at digest ${tool.digest.slice(0, 12)}`
        : tool.stale ? `  test         stale — the tool changed since it passed; run posse tools test ${manifest.name}`
          : `  test         never passed — agents can call it only after posse tools test ${manifest.name} passes`);
      const grants = tool.grants.filter(grant => grant.enabled);
      if (!grants.length) print(`  grants       none — posse tools grant ${manifest.name} --repo <path> --roles dev`);
      for (const grant of grants) print(`  grant        ${grant.id} · ${grant.scope}${grant.repo_id ? ` ${grant.repo_id}` : ""} · roles ${grant.roles.join(",")}${grant.digest === tool.digest ? "" : " · stale digest"}`);
      return 0;
    }
    case "test": {
      if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools test <name> [--input JSON | --input-file PATH] [--inputs-file PATH] [--json]"), { code: "invalid_request" });
      const source = args.one("--input-file");
      const raw = source ? readBoundedText(source, 1024 * 1024) : args.one("--input") || "{}";
      let input;
      try { input = JSON.parse(raw); } catch { throw Object.assign(new Error("--input must be one JSON object"), { code: "invalid_request" }); }
      let inputs = {};
      const privateFile = args.one("--inputs-file");
      if (privateFile) {
        const info = fs.lstatSync(privateFile);
        if (!info.isFile() || info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 0o077))
          throw Object.assign(new Error("--inputs-file must be a private regular file"), { code: "invalid_request" });
        try { inputs = JSON.parse(readBoundedText(privateFile, 32 * 1024)); }
        catch { throw Object.assign(new Error("--inputs-file must contain one JSON object"), { code: "invalid_request" }); }
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw Object.assign(new Error("--inputs-file must contain one JSON object"), { code: "invalid_request" });
      }
      const tested = await request("script.test", { name: args.positional[0], input, inputs });
      const result = tested.result;
      if (args.has("--json")) {
        print(JSON.stringify({ protocol: SCRIPT_TOOL_TEST_PROTOCOL, tool: tested.tool, digest: tested.digest, ...result, published: tested.published, revoked_grants: tested.revoked_grants }));
        return result.ok ? 0 : 1;
      }
      const state = result.timed_out ? "timed out" : result.ok ? "passed" : `failed (exit ${result.exit_code})`;
      print(`${tested.tool} ${state} in ${result.duration_ms}ms`);
      if (result.output) print(`--- output${result.truncated ? " (truncated)" : ""} ---\n${result.output.replace(/\n$/, "")}`);
      if (result.stderr) print(`--- stderr (tail) ---\n${result.stderr}`);
      if (result.redacted) print("note: secret values or credential-shaped text were redacted");
      if (tested.published) print(`published ${tested.published.id} at digest ${tested.published.digest.slice(0, 12)}`);
      if (tested.revoked_grants.length) print(`revoked ${tested.revoked_grants.length} grant(s) that pinned the previous version; re-grant with posse tools grant`);
      return result.ok ? 0 : 1;
    }
    case "secret": return runSecretCommand(args, request, io, print);
    case "grant": {
      if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools grant <name> [--repo PATH | --standalone] [--roles dev,researcher|*] [--unattended]"), { code: "invalid_request" });
      const name = args.positional[0], standalone = args.has("--standalone");
      const grant = await request("script.grant", {
        name, standalone, repo_path: standalone ? "" : path.resolve(args.one("--repo") || process.cwd()),
        roles: (args.one("--roles") || "dev").split(","), unattended: args.has("--unattended"),
      });
      if (args.has("--json")) { print(JSON.stringify(grant)); return 0; }
      print(`granted ${name} to ${grant.roles.join(",")} ${standalone ? "(standalone)" : `in ${grant.repo_id}`} as ${grant.id}`);
      return 0;
    }
    case "revoke": {
      if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools revoke <grant-id>"), { code: "invalid_request" });
      const grant = await request("grant.revoke", { id: args.positional[0] });
      if (args.has("--json")) { print(JSON.stringify(grant)); return 0; }
      print(`revoked ${grant.id}`);
      return 0;
    }
  }
  err.write(`Unknown tools command: ${command}\n${TOOLS_USAGE}\n`);
  return 2;
}

async function runPromptCommand(args, request, io, print) {
  const action = args.positional.shift() || "list";
  if (action === "list") {
    const tools = await request("prompt_tool.list", {});
    if (args.has("--json")) print(JSON.stringify(tools));
    else if (!tools.length) print("No prompt tools yet.");
    else for (const tool of tools) print(`  ${tool.name.padEnd(32)} global · ${tool.description}`);
    return 0;
  }
  if (action === "show") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools prompt show <name>"), { code: "invalid_request" });
    const tool = await request("prompt_tool.show", { name: args.positional[0] });
    print(args.has("--json") ? JSON.stringify(tool) : `${tool.name} — ${tool.description}\n  scope        global\n  storage      central Posse database`);
    return 0;
  }
  if (action === "save") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools prompt save <definition.json|->"), { code: "invalid_request" });
    const source = args.positional[0];
    const raw = source === "-" ? await readBoundedInput(io.stdin || process.stdin, 1024 * 1024) : readBoundedText(source, 1024 * 1024);
    let definition;
    try { definition = JSON.parse(raw); } catch { throw Object.assign(new Error("Prompt tool definition must be one JSON object"), { code: "invalid_request" }); }
    const saved = await request("prompt_tool.save", { definition });
    print(args.has("--json") ? JSON.stringify(saved) : `saved ${saved.name} as a global pre-run input in the central Posse database at ${saved.digest.slice(0, 12)}`);
    return 0;
  }
  if (action === "remove") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools prompt remove <name>"), { code: "invalid_request" });
    const removed = await request("prompt_tool.remove", { name: args.positional[0] });
    print(args.has("--json") ? JSON.stringify(removed) : `removed ${removed.name} from the central Posse database`);
    return 0;
  }
  throw Object.assign(new Error(`Unknown prompt tools command: ${action}`), { code: "invalid_request" });
}

async function runSqlCommand(args, request, io, print) {
  const action = args.positional.shift() || "list";
  if (action === "list") {
    if (args.positional.length) throw Object.assign(new Error("usage: posse tools sql list"), { code: "invalid_request" });
    const capabilities = await request("sql_capability.list", {});
    if (args.has("--json")) { print(JSON.stringify(capabilities)); return 0; }
    if (!capabilities.length) { print("No SQL capabilities yet."); return 0; }
    for (const capability of capabilities) print(`  ${capability.name.padEnd(32)} ${capability.tested ? "tested" : "needs test"} · ${capability.binding.folder_path}`);
    return 0;
  }
  if (action === "show") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools sql show <name>"), { code: "invalid_request" });
    const capability = await request("sql_capability.show", { name: args.positional[0] });
    if (args.has("--json")) { print(JSON.stringify(capability)); return 0; }
    print(`${capability.name} — ${capability.description}\n  binding      ${capability.binding.folder_path}\n  parameters   ${capability.parameter_order.join(", ") || "none"}\n  rows         ${capability.max_rows}\n  test         ${capability.tested ? `passed at ${capability.digest.slice(0, 12)}` : "required"}\n  storage      central Posse database`);
    return 0;
  }
  if (action === "save") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools sql save <definition.json|->"), { code: "invalid_request" });
    const source = args.positional[0];
    const raw = source === "-" ? await readBoundedInput(io.stdin || process.stdin, 1024 * 1024) : readBoundedText(source, 1024 * 1024);
    let definition;
    try { definition = JSON.parse(raw); } catch { throw Object.assign(new Error("SQL capability definition must be one JSON object"), { code: "invalid_request" }); }
    const saved = await request("sql_capability.save", { definition });
    print(args.has("--json") ? JSON.stringify(saved) : `saved ${saved.name} in the central Posse database at ${saved.digest.slice(0, 12)}; run posse tools sql test ${saved.name}`);
    return 0;
  }
  if (action === "test") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools sql test <name> [--input JSON | --input-file PATH]"), { code: "invalid_request" });
    const source = args.one("--input-file");
    const raw = source ? readBoundedText(source, 1024 * 1024) : args.one("--input") || "{}";
    let input;
    try { input = JSON.parse(raw); } catch { throw Object.assign(new Error("--input must be one JSON object"), { code: "invalid_request" }); }
    const tested = await request("sql_capability.test", { name: args.positional[0], input });
    if (args.has("--json")) print(JSON.stringify(tested));
    else print(`${tested.name} ${tested.passed ? "passed and published" : "failed"}\n${tested.output}`);
    return tested.passed ? 0 : 1;
  }
  if (action === "grant") {
    if (args.positional.length !== 1) throw Object.assign(new Error("usage: posse tools sql grant <name> [--roles dev,researcher|*]"), { code: "invalid_request" });
    const grant = await request("sql_capability.grant", { name: args.positional[0], roles: (args.one("--roles") || "dev").split(",") });
    print(args.has("--json") ? JSON.stringify(grant) : `granted ${args.positional[0]} to ${grant.roles.join(",")} in ${grant.repo_id} as ${grant.id}`);
    return 0;
  }
  throw Object.assign(new Error(`Unknown SQL tools command: ${action}`), { code: "invalid_request" });
}

async function runSecretCommand(args, request, io, print) {
  const action = args.positional.shift();
  if (action === "list") {
    const tools = args.positional.length ? [await request("script.show", { name: args.positional[0] })] : await request("script.list", {});
    const rows = tools.filter(tool => !tool.error).flatMap(tool => tool.secrets.map(item => ({ tool: tool.name, ...item })));
    if (args.has("--json")) { print(JSON.stringify(rows)); return 0; }
    if (!rows.length) { print("No script tool declares a secret."); return 0; }
    for (const row of rows) print(`  ${row.tool.padEnd(28)} ${row.name.padEnd(24)} ${row.set ? `set ${row.fingerprint}` : "NOT SET"}`);
    return 0;
  }
  if ((action === "set" || action === "unset") && args.positional.length === 2) {
    const [tool, name] = args.positional;
    if (action === "unset") {
      const result = await request("script.secret.unset", { tool, name });
      print(args.has("--json") ? JSON.stringify(result) : result.removed ? `removed ${name} for ${tool}` : `${name} for ${tool} was not set`);
      return 0;
    }
    const value = await readSecret(io.stdin || process.stdin, io.stdout || process.stdout, `${name} for ${tool} (input hidden): `);
    const result = await request("script.secret.set", { tool, name, value });
    print(args.has("--json") ? JSON.stringify(result) : `saved ${name} for ${tool} ${result.fingerprint} — only ${tool}'s process receives it`);
    return 0;
  }
  throw Object.assign(new Error("usage: posse tools secret set|unset <tool> <NAME> | secret list [<tool>]"), { code: "invalid_request" });
}

// Hidden terminal input, or the whole of a piped stdin. Never echoed.
async function readSecret(stdin, stdout, prompt) {
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdout.write(prompt);
    return await new Promise((resolve, reject) => {
      let value = "";
      stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
      const done = (error) => { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); stdout.write("\n"); error ? reject(error) : resolve(value); };
      const onData = chunk => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") return done();
          if (character === "\u0003") return done(Object.assign(new Error("Canceled"), { code: "invalid_request" }));
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else value += character;
        }
      };
      stdin.on("data", onData);
    });
  }
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > SCRIPT_TOOL_LIMITS.MAX_SECRET_BYTES + 2) break;
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function defaultClient(command) {
  await ensureAutomationOwner();
  // A test waits for the script; its own timeout is at most ten minutes.
  return new AutomationOwnerClient({ operator: true, timeoutMs: command === "test" ? (SCRIPT_TOOL_LIMITS.MAX_TIMEOUT_SECONDS + 30) * 1000 : 30_000 });
}

function exampleInput(schema) {
  const values = {};
  for (const [name, property] of Object.entries(schema.properties || {})) values[name] = { string: "example", integer: 1, number: 1, boolean: true }[property.type] ?? null;
  return values;
}

function readBoundedText(file, limit) {
  const info = fs.statSync(file);
  if (info.size > limit) throw Object.assign(new Error(`${file} is larger than ${limit} bytes`), { code: "invalid_request" });
  return fs.readFileSync(file, "utf8");
}

async function readBoundedInput(stdin, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error(`Input is larger than ${limit} bytes`), { code: "invalid_request" });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
