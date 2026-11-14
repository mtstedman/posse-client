import { AutomationOwner } from "../classes/AutomationOwner.js";
import { AutomationOwnerClient, ensureAutomationOwner } from "../classes/AutomationOwnerClient.js";
import { AutomationServiceManager } from "../classes/AutomationServiceManager.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export async function runAutomationCli(argv = process.argv.slice(3)) {
  const command = String(argv[0] || "health").trim().toLowerCase();
  if (command === "owner") return runOwnerForeground();
  if (command === "service") {
    const manager = new AutomationServiceManager();
    const action = String(argv[1] || "status").trim().toLowerCase();
    if (action === "install") return printJson(await manager.install());
    if (action === "remove") return printJson(await manager.remove());
    if (action === "status") return printJson(await manager.status());
    throw Object.assign(new Error(`Unknown automation service action: ${action}`), { code: "invalid_request" });
  }
  if (command === "ensure") return printJson(await ensureAutomationOwner());
  if (command === "health") {
    const result = await new AutomationOwnerClient({ timeoutMs: 1000 }).health();
    return printJson(result);
  }
  if (command === "request") {
    await ensureAutomationOwner();
    const frame = await readRequestFrame(argv.slice(1));
    const operation = String(frame.operation || "").trim();
    if (!operation) throw Object.assign(new Error("Automation request requires operation"), { code: "invalid_request" });
    const client = new AutomationOwnerClient({ operator: true, timeoutMs: Number(frame.timeout_ms) || 30_000 });
    return printJson(await client.request(operation, frame.args || {}));
  }
  throw Object.assign(new Error(`Unknown automation command: ${command}`), { code: "invalid_request" });
}

export async function readRequestFrame(args, input = process.stdin) {
  const inline = args.join(" ").trim();
  let raw = inline;
  if (!inline) {
    // Bossy sends large draft bodies through a pipe. Node may mark stdin
    // nonblocking, so a synchronous fd read can fail with EAGAIN between writes.
    // Await incoming chunks and enforce the byte limit before buffering more.
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REQUEST_BYTES) {
        throw Object.assign(new Error("Automation request is too large"), { code: "request_too_large" });
      }
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks, size).toString("utf8");
  }
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("Automation request is too large"), { code: "request_too_large" });
  }
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Automation request must be a JSON object"), { code: "invalid_request" });
  }
  return value;
}

async function runOwnerForeground() {
  const owner = new AutomationOwner();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await owner.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await owner.start();
  await new Promise(resolve => owner.server.once("close", resolve));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return value;
}
