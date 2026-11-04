// One authorized SQLite statement per process. The parent owns the deadline
// and reaps this process on cancellation, including while SQLite runs native
// code. Only the file/query parameters arrive over private IPC, never argv.
import Database from "better-sqlite3";
import { serialize, deserialize } from "node:v8";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { AUTOMATION_MAX_RESPONSE_BYTES } from "../../../../../catalog/custom-tools.js";

const MAX_RESULT_BYTES = AUTOMATION_MAX_RESPONSE_BYTES;
const RESULT_TOO_LARGE = `SQLite result exceeds the ${MAX_RESULT_BYTES} byte IPC limit; select fewer or smaller columns.`;

function execute({ file, statement, parameters, isRead, readOnly, maxRows }) {
  const db = new Database(file, { readonly: readOnly, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const stmt = db.prepare(statement);
    if (isRead && stmt.reader) {
      const rows = [];
      let truncated = false, bytes = 0;
      for (const row of stmt.iterate(...parameters)) {
        if (rows.length >= maxRows) { truncated = true; break; }
        bytes += serialize(row).byteLength;
        if (bytes > MAX_RESULT_BYTES) throw new Error(RESULT_TOO_LARGE);
        rows.push(row);
      }
      return { columns: stmt.columns().map(column => column.name), rows, rowCount: rows.length, truncated };
    }
    const info = stmt.run(...parameters);
    return { columns: [], rows: [], rowCount: 0, affectedRows: info.changes,
      lastInsertRowid: typeof info.lastInsertRowid === "bigint" ? Number(info.lastInsertRowid) : info.lastInsertRowid,
      truncated: false };
  } finally {
    db.close();
  }
}

function responseFor(input) {
  let response;
  try {
    const result = execute(input);
    if (serialize(result).byteLength > MAX_RESULT_BYTES) throw new Error(RESULT_TOO_LARGE);
    response = { ok: true, result };
  } catch (error) {
    response = { ok: false, error: { message: String(error?.message || error).slice(0, 4096), code: error?.code } };
  }
  return response;
}

if (isMainThread) {
  // Keep this process's main loop free to observe parent death and its own
  // deadline while SQLite occupies a native worker thread. SIGKILL terminates
  // the whole process; Worker.terminate/process.exit may wait for native code.
  const kill = () => process.kill(process.pid, "SIGKILL");
  process.once("disconnect", kill);
  process.once("message", input => {
    const timer = setTimeout(kill, input.timeoutMs);
    let replied = false;
    const reply = response => {
      if (replied) return;
      replied = true;
      clearTimeout(timer);
      process.send(response, () => process.disconnect());
    };
    // V8 serialization preserves Buffer parameters; ordinary worker cloning
    // would turn them into Uint8Arrays, which changes SQLite binding types.
    const worker = new Worker(new URL(import.meta.url), { workerData: serialize(input), execArgv: [] });
    worker.once("message", message => reply(deserialize(message)));
    worker.once("error", error => reply({ ok: false, error: { message: error.message, code: error.code } }));
    worker.once("exit", code => {
      if (!replied) reply({ ok: false, error: { message: `SQLite thread exited without a result (${code})` } });
    });
  });
} else {
  parentPort.postMessage(serialize(responseFor(deserialize(workerData))));
  parentPort.close();
}
