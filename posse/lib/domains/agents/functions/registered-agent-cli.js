import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { AGENT_TURN_PROTOCOL } from "../../../catalog/agent.js";
import { REGISTERED_AGENT_PROTOCOL } from "../../../catalog/registered-agent.js";
import { registeredAgentSocketPath } from "../../automation/functions/paths.js";

const MAX_BYTES = 1024 * 1024;
const USAGE = "Usage: posse-agent chat <agent> [--session ID] --idempotency-key KEY --request-json --json | posse-agent run <agent> --idempotency-key KEY --request-json --json | posse-agent health --json | posse-agent version --json";

function fault(code, message) { return Object.assign(new Error(message), { code }); }

function fail(code, message) {
  return { protocol: AGENT_TURN_PROTOCOL, agent: "", agent_digest: "", conversation_id: "", turn_id: "", status: "failed",
    reply: "", tool_calls: [], pending: [], usage: null, error: { code, message } };
}

function parse(argv) {
  const [operation, agent, ...rest] = argv;
  if (operation === "health" || operation === "version") {
    if (agent !== "--json" || rest.length) throw new Error(USAGE);
    return { operation };
  }
  if (!["chat", "run"].includes(operation) || !agent || agent.startsWith("-")) throw new Error(USAGE);
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (["--json", "--request-json"].includes(flag)) { if (flags[flag]) throw new Error(USAGE); flags[flag] = true; continue; }
    if (!["--session", "--idempotency-key"].includes(flag) || flags[flag] || !rest[i + 1]) throw new Error(USAGE);
    flags[flag] = rest[++i];
  }
  if (!flags["--json"] || !flags["--request-json"] || !flags["--idempotency-key"] || operation === "run" && flags["--session"]) throw new Error(USAGE);
  return { operation, agent, session: flags["--session"], idempotencyKey: flags["--idempotency-key"] };
}

async function readStdin(input) {
  const chunks = []; let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > MAX_BYTES) throw fault("invalid_request", "Agent request exceeds 1 MiB");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fault("invalid_request", "Agent request is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fault("invalid_request", "Agent request must be an object");
  return value;
}

function registration() {
  const file = process.env.POSSE_AGENT_REGISTRATION_FILE;
  if (file) {
    if (!fs.existsSync(file)) throw fault("invalid_request", "Registration file is missing");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077)) throw fault("forbidden", "Registration file must be private and regular");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value.client_id !== "string" || typeof value.credential !== "string") throw fault("invalid_request", "Registration file is invalid");
    return value;
  }
  const credentialFile = process.env.POSSE_AGENT_CREDENTIAL_FILE;
  if (!credentialFile) throw fault("invalid_request", "POSSE_AGENT_REGISTRATION_FILE or POSSE_AGENT_CREDENTIAL_FILE is required");
  if (!fs.existsSync(credentialFile)) throw fault("invalid_request", "Credential file is missing");
  const stat = fs.lstatSync(credentialFile);
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077)) throw fault("forbidden", "Credential file must be private and regular");
  return { client_id: process.env.POSSE_AGENT_CLIENT_ID, credential: fs.readFileSync(credentialFile, "utf8").trim() };
}

function endpoint() {
  const socketPath = registeredAgentSocketPath();
  if (process.platform !== "win32") {
    const expected = Number(process.env.POSSE_AGENT_EXPECTED_UID || process.getuid());
    const socket = fs.lstatSync(socketPath), parent = fs.statSync(path.dirname(socketPath));
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== expected || parent.mode & 0o022)
      throw fault("unauthorized", "Registered owner endpoint identity is invalid");
  }
  return socketPath;
}

function requestFrame(socketPath, payload, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0), done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error("Registered owner request timed out")), timeoutMs);
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BYTES + 1024) return finish(new Error("Registered owner response is too large"));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (!response.ok) return finish(Object.assign(new Error(response.error || "Registered request failed"), { code: response.code }));
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.once("error", finish);
    socket.once("end", () => finish(new Error("Registered owner closed without a response")));
  });
}

export async function runRegisteredAgentCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr;
  let parsed;
  try { parsed = parse(argv); }
  catch (error) { stdout.write(JSON.stringify(fail("invalid_request", error.message)) + "\n"); return 64; }
  if (parsed.operation === "version") { stdout.write(JSON.stringify({ protocol: REGISTERED_AGENT_PROTOCOL }) + "\n"); return 0; }
  try {
    const socketPath = endpoint();
    if (parsed.operation === "health") { stdout.write(JSON.stringify(await requestFrame(socketPath, { kind: "health" }, 5000)) + "\n"); return 0; }
    const credential = registration();
    const content = await readStdin(io.stdin || process.stdin);
    const request = { protocol: REGISTERED_AGENT_PROTOCOL, client_id: credential.client_id, credential: credential.credential,
      request_id: crypto.randomUUID(), operation: parsed.operation, agent: parsed.agent, idempotency_key: parsed.idempotencyKey,
      ...(parsed.session ? { session: parsed.session } : {}), request: content };
    const result = await requestFrame(socketPath, request);
    stdout.write(JSON.stringify(result) + "\n");
    return result.status === "done" ? 0 : result.status === "needs_confirmation" ? 2 : 1;
  } catch (error) {
    const code = ["unauthorized", "forbidden"].includes(error.code) ? error.code
      : ["invalid_request", "idempotency_conflict", "agent_session_busy", "agent_request_busy", "request_too_large", "agent_session_expired", "receipt_expired"].includes(error.code)
        ? error.code : "owner_unavailable";
    stdout.write(JSON.stringify(fail(code, code === "owner_unavailable" ? "Registered owner unavailable" : "Registered request rejected")) + "\n");
    stderr.write(`${code}\n`);
    return code === "unauthorized" || code === "forbidden" ? 77 : ["invalid_request", "request_too_large"].includes(code) ? 64
      : ["agent_request_busy", "agent_session_busy", "idempotency_conflict", "agent_session_expired", "receipt_expired"].includes(code) ? 1 : 69;
  }
}
