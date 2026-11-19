import { AutomationOwner } from "../classes/AutomationOwner.js";
import { AutomationOwnerClient, ensureAutomationOwner } from "../classes/AutomationOwnerClient.js";
import { AutomationServiceManager } from "../classes/AutomationServiceManager.js";
import { AUTOMATION_RUN_RECONCILE_RESOLUTIONS } from "../../../catalog/custom-tools.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

// Help for `posse automation run`; the definitions match
// AutomationService.reconcileRun.
export const AUTOMATION_RUN_USAGE = `Usage:
  posse automation run reconcile <run-id> --discard|--accept
      Settle an interrupted run: one whose outcome the owner could not verify
      (it stopped between the run's commit journal and its files, or an
      external call's result is unknown). Until it is settled the run holds
      its output paths, so other runs that write them fail with
      output_conflict, and its schedule cannot be removed.
      --discard  keep nothing: drop the commit journal without saving the
                 run's checkpoints and mark the run failed. Files it had
                 already written stay as they are; there is no earlier
                 content to restore.
      --accept   keep what was committed: files in place with their journaled
                 content become the run's artifacts, its checkpoints are saved
                 only if every journaled file is in place (otherwise a later
                 run redoes the work), and the run is marked succeeded.
      Both release the run's output paths. A schedule paused for the run
      stays paused until it is resumed.`;

// `posse automation run …` arguments as an owner operation.
export function parseRunCommand(args) {
  const [action, ...rest] = args.map(String);
  if (!action || ["help", "--help"].includes(action) || rest.includes("--help")) return { help: true };
  const ids = rest.filter(arg => !arg.startsWith("--")), resolutions = rest.filter(arg => arg.startsWith("--")).map(arg => arg.slice(2));
  if (action !== "reconcile" || ids.length !== 1 || resolutions.length !== 1 || !AUTOMATION_RUN_RECONCILE_RESOLUTIONS.includes(resolutions[0])) {
    throw Object.assign(new Error(AUTOMATION_RUN_USAGE), { code: "invalid_request" });
  }
  return { operation: "run.reconcile", args: { id: ids[0], resolution: resolutions[0] } };
}

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
  if (command === "run") {
    const parsed = parseRunCommand(argv.slice(1));
    if (parsed.help) { process.stdout.write(`${AUTOMATION_RUN_USAGE}\n`); return null; }
    await ensureAutomationOwner();
    return printJson(await new AutomationOwnerClient({ operator: true, timeoutMs: 30_000 }).request(parsed.operation, parsed.args));
  }
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
