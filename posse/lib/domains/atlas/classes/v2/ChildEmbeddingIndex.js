// @ts-check

import fs from "fs";
import path from "path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendPersistentTelemetry } from "../../../../shared/telemetry/functions/persistent-log.js";
import { getRuntimeLogDir, getRuntimeRoot } from "../../../runtime/functions/paths.js";
import { errorForTelemetry, recordEmbeddingForensics } from "../../functions/v2/embeddings/forensics.js";

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIngest} EmbeddingIngest */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingHit} EmbeddingHit */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSearchOptions} EmbeddingSearchOptions */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIndex} EmbeddingIndexContract */

const CHILD_WORKER_PATH = fileURLToPath(new URL("./EmbeddingIndexChildWorker.js", import.meta.url));
const ANN_INDEX_FILE = "index.usearch";
const ANN_MANIFEST_FILE = "index.usearch.json";
const CHILD_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const RECOVERY_LOG_STREAM = "atlas-embedding-recovery";
// Ops that cannot corrupt the on-disk ANN: pure reads plus the breadcrumb-file
// ops (which touch inflight.json, never index.usearch). A timeout on one of
// these restarts the child WITHOUT quarantining — renaming an intact
// index.usearch just because a read was slow forces a full O(N) rebuild on the
// next start. Quarantine stays reserved for init/load failures and write-path
// crashes where on-disk corruption is plausible.
const ANN_SAFE_OPS = new Set([
  "nearest",
  "count",
  "contains",
  "containsMany",
  "getLastAddTiming",
  "getEmbeddingWatermark",
  "setEmbeddingWatermark",
  "markEncoding",
  "clearEncoding",
  "readInflight",
  "ping",
]);

function nowIsoForFile() {
  return new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "");
}

function encodeModelDirComponent(value) {
  return encodeURIComponent(String(value)).replace(/%/g, "~");
}

export function childEmbeddingModelDirName({ model, model_version }) {
  return `${encodeModelDirComponent(model)}--${encodeModelDirComponent(model_version)}`;
}

function tailText(text) {
  const value = String(text || "");
  return value.length > 4000 ? value.slice(-4000) : value;
}

function serializeSearchOptions(opts = {}) {
  const out = { ...(opts && typeof opts === "object" ? opts : {}) };
  if (out.restrictToContentHashes instanceof Set) {
    out.restrictToContentHashes = Array.from(out.restrictToContentHashes);
  }
  return out;
}

function childError(payload = {}, fallback = "EmbeddingIndex child failed") {
  const err = new Error(String(payload?.message || fallback));
  err.name = String(payload?.name || "Error");
  if (payload?.stack) err.stack = String(payload.stack);
  if (payload?.code != null) {
    try { /** @type {any} */ (err).code = payload.code; } catch { /* best effort */ }
  }
  return err;
}

function decorateError(err, extra = {}) {
  for (const [key, value] of Object.entries(extra)) {
    try { /** @type {any} */ (err)[key] = value; } catch { /* best effort */ }
  }
  return err;
}

function isRecoverableChildFailure(err) {
  const code = String(/** @type {any} */ (err)?.code || "");
  return code === "EMBEDDING_CHILD_EXIT" || code === "EMBEDDING_CHILD_SEND_FAILED" || code === "EMBEDDING_CHILD_TIMEOUT";
}

function recordRecoveryEvent(event, data = {}) {
  appendPersistentTelemetry(RECOVERY_LOG_STREAM, {
    event,
    component: "atlas.embedding.child-index",
    ...data,
  });
}

/** @implements {EmbeddingIndexContract} */
export class ChildEmbeddingIndex {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;
  /** @type {string} */
  backend = "usearch-child";
  /** @type {true} */
  asyncIndex = true;
  /** @type {true} */
  childIndex = true;
  /** @type {string} */
  gateKey;

  /** @type {string} */
  #embeddingsRoot;
  /** @type {number | undefined} */
  #annSaveEveryBatches;
  /** @type {number | undefined} */
  #annSaveEveryMs;
  /** @type {import("node:child_process").ChildProcess | null} */
  #child = null;
  /** @type {Promise<void> | null} */
  #starting = null;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout | null, op: string, child: import("node:child_process").ChildProcess }>} */
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #stopping = false;
  #stdoutTail = "";
  #stderrTail = "";
  /** @type {Record<string, any> | null} */
  #lastAddTiming = null;
  /**
   * Children we intentionally killed (request-timeout or close). Their later
   * async `exit` would otherwise look "stale" — a fresh child has already
   * replaced #child — and log child.stale_exit, which is alarming telemetry for
   * a deliberate retirement (the dominant source of the 100+ "stale exits" seen
   * per run). Tracked here so #onChildExit reports child.retired instead and a
   * genuinely unexpected stale exit stays distinguishable.
   * @type {Set<import("node:child_process").ChildProcess>}
   */
  #retiredChildren = new Set();

  /**
   * @param {{
   *   model: string,
   *   model_version: string,
   *   dim: number,
   *   embeddingsRoot: string,
   *   annSaveEveryBatches?: number,
   *   annSaveEveryMs?: number,
   * }} args
   */
  constructor({ model, model_version, dim, embeddingsRoot, annSaveEveryBatches, annSaveEveryMs }) {
    if (!model) throw new TypeError("ChildEmbeddingIndex: model is required");
    if (!model_version) throw new TypeError("ChildEmbeddingIndex: model_version is required");
    if (!Number.isInteger(dim) || dim <= 0) throw new RangeError("ChildEmbeddingIndex: dim must be a positive integer");
    if (!embeddingsRoot) throw new TypeError("ChildEmbeddingIndex: embeddingsRoot is required");
    this.model = model;
    this.model_version = model_version;
    this.dim = dim;
    this.#embeddingsRoot = embeddingsRoot;
    this.#annSaveEveryBatches = annSaveEveryBatches;
    this.#annSaveEveryMs = annSaveEveryMs;
    this.gateKey = `usearch-child:${path.join(embeddingsRoot, childEmbeddingModelDirName({ model, model_version }))}`;
  }

  /**
   * @param {{
   *   model: string,
   *   model_version: string,
   *   dim: number,
   *   embeddingsRoot: string,
   *   annSaveEveryBatches?: number,
   *   annSaveEveryMs?: number,
   * }} args
   */
  static open(args) {
    return new ChildEmbeddingIndex(args);
  }

  #modelDir() {
    return path.join(this.#embeddingsRoot, childEmbeddingModelDirName({
      model: this.model,
      model_version: this.model_version,
    }));
  }

  #log(event, data = {}) {
    recordRecoveryEvent(event, {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      embeddings_root: this.#embeddingsRoot,
      model_dir: this.#modelDir(),
      ...data,
    });
  }

  async #ensureStarted() {
    if (this.#closed) throw new Error("ChildEmbeddingIndex: closed");
    if (this.#isCurrentChildRunning()) return;
    if (this.#starting) return await this.#starting;
    this.#starting = this.#startWithRecovery()
      .finally(() => { this.#starting = null; });
    return await this.#starting;
  }

  async #startWithRecovery() {
    try {
      await this.#startOnce("initial");
      return;
    } catch (err) {
      if (!isRecoverableChildFailure(err)) throw err;
      this.#log("child.init_failed", {
        error: err?.message || String(err),
        code: /** @type {any} */ (err)?.code || null,
        exit_code: /** @type {any} */ (err)?.exitCode ?? null,
        signal: /** @type {any} */ (err)?.signal ?? null,
      });
      this.#quarantineAnnFiles("child-init-crash");
      this.#log("ann.rebuild_requested", { reason: "child_init_crash" });
      await this.#startOnce("after_recovery");
    }
  }

  async #startOnce(reason) {
    this.#stopping = false;
    this.#stdoutTail = "";
    this.#stderrTail = "";
    const reportDir = path.join(getRuntimeLogDir(), "diagnostic-reports", "atlas-embedding-index-child");
    try { fs.mkdirSync(reportDir, { recursive: true }); } catch { /* best effort */ }
    const forkOptions = /** @type {import("node:child_process").ForkOptions & { windowsHide?: boolean }} */ ({
      cwd: process.cwd(),
      env: {
        ...process.env,
        POSSE_ATLAS_EMBEDDING_CHILD: "1",
      },
      execArgv: diagnosticReportExecArgv(reportDir),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      serialization: "advanced",
    });
    const child = fork(CHILD_WORKER_PATH, [], forkOptions);
    this.#child = child;
    this.#log("child.start", { reason, child_pid: child.pid || null });
    recordEmbeddingForensics("child_index.start", {
      reason,
      child_pid: child.pid || null,
      report_dir: reportDir,
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      embeddings_root: this.#embeddingsRoot,
      model_dir: this.#modelDir(),
    });
    child.stdout?.on("data", (chunk) => { this.#stdoutTail = tailText(this.#stdoutTail + String(chunk)); });
    child.stderr?.on("data", (chunk) => { this.#stderrTail = tailText(this.#stderrTail + String(chunk)); });
    child.on("message", (message) => this.#onMessage(child, message));
    child.on("error", (err) => this.#onChildError(child, err));
    child.on("exit", (code, signal) => this.#onChildExit(child, code, signal));
    await this.#sendToCurrent("init", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      embeddingsRoot: this.#embeddingsRoot,
      runtimePathOverrides: {
        runtimeRoot: getRuntimeRoot(),
        logDir: getRuntimeLogDir(),
      },
      annSaveEveryBatches: this.#annSaveEveryBatches,
      annSaveEveryMs: this.#annSaveEveryMs,
    }, { timeoutMs: CHILD_REQUEST_TIMEOUT_MS });
    this.#log("child.ready", { reason, child_pid: child.pid || null });
    recordEmbeddingForensics("child_index.ready", {
      reason,
      child_pid: child.pid || null,
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      model_dir: this.#modelDir(),
    });
  }

  #isCurrentChildRunning() {
    const child = this.#child;
    return !!child && !child.killed && child.exitCode == null;
  }

  #onMessage(child, message = {}) {
    const id = Number(message?.id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (pending.child !== child) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message?.type === "error") {
      recordEmbeddingForensics("child_index.request.message_error", {
        request_id: id,
        op: pending.op,
        child_pid: child?.pid || null,
        error: message.error || null,
      });
      pending.reject(childError(message.error || {}, `EmbeddingIndex child ${pending.op} failed`));
      return;
    }
    recordEmbeddingForensics("child_index.request.done", {
      request_id: id,
      op: pending.op,
      child_pid: child?.pid || null,
      result: summarizeChildResult(message?.result),
    });
    pending.resolve(message?.result);
  }

  #onChildError(child, err) {
    this.#log("child.error", {
      child_pid: child?.pid || null,
      stale_child: child !== this.#child,
      error: err?.message || String(err),
    });
    recordEmbeddingForensics("child_index.error", {
      child_pid: child?.pid || null,
      stale_child: child !== this.#child,
      model: this.model,
      model_version: this.model_version,
      error: errorForTelemetry(err),
    });
  }

  #onChildExit(child, code, signal) {
    const childPid = child?.pid || null;
    const stale = child !== this.#child;
    // Reject the exited child's in-flight ops immediately — even for a stale
    // child — instead of leaving each to its own full timer. A second op left
    // ticking on a dead stale child would otherwise time out minutes later and
    // its retry could re-quarantine a freshly rebuilt index.
    const err = decorateError(new Error(`EmbeddingIndex child exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`), {
      code: "EMBEDDING_CHILD_EXIT",
      exitCode: code ?? null,
      signal: signal || null,
    });
    for (const [id, pending] of this.#pending.entries()) {
      if (pending.child !== child) continue;
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      recordEmbeddingForensics("child_index.request.rejected_by_exit", {
        request_id: id,
        op: pending.op,
        child_pid: childPid,
        stale_child: stale,
        exit_code: code ?? null,
        signal: signal || null,
      });
      this.#pending.delete(id);
    }
    // Deliberately-killed children (request-timeout / close) were recorded as
    // retired; their exit is expected, not a stale anomaly. Delete runs for
    // every exit so the set never leaks.
    const retired = this.#retiredChildren.delete(child);
    if (stale) {
      this.#log(retired ? "child.retired" : "child.stale_exit", {
        child_pid: childPid,
        current_child_pid: this.#child?.pid || null,
        exit_code: code ?? null,
        signal: signal || null,
        ...(retired ? { reason: "intentional_kill" } : {}),
      });
      return;
    }
    const stopping = this.#stopping || this.#closed;
    this.#child = null;
    this.#log(stopping ? "child.exit" : "child.crash", {
      child_pid: childPid,
      exit_code: code ?? null,
      signal: signal || null,
      stdout_tail: this.#stdoutTail || null,
      stderr_tail: this.#stderrTail || null,
    });
    recordEmbeddingForensics(stopping ? "child_index.exit" : "child_index.crash", {
      child_pid: childPid,
      exit_code: code ?? null,
      signal: signal || null,
      stopping,
      stdout_tail: this.#stdoutTail || null,
      stderr_tail: this.#stderrTail || null,
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      model_dir: this.#modelDir(),
    });
  }

  async #request(op, args = {}, { retry = true, timeoutMs = CHILD_REQUEST_TIMEOUT_MS } = {}) {
    try {
      await this.#ensureStarted();
      return await this.#sendToCurrent(op, args, { timeoutMs });
    } catch (err) {
      if (!retry || this.#closed || op === "close" || !isRecoverableChildFailure(err)) throw err;
      this.#log("child.request_failed", {
        op,
        error: err?.message || String(err),
        code: /** @type {any} */ (err)?.code || null,
        exit_code: /** @type {any} */ (err)?.exitCode ?? null,
        signal: /** @type {any} */ (err)?.signal ?? null,
      });
      const timedOut = String(/** @type {any} */ (err)?.code || "") === "EMBEDDING_CHILD_TIMEOUT";
      if (timedOut && ANN_SAFE_OPS.has(op)) {
        // A slow read can't have corrupted the on-disk ANN; restart the child
        // and retry without throwing away an intact index (see ANN_SAFE_OPS).
        this.#log("child.restart_without_quarantine", { op, reason: `child_${op}_timeout` });
      } else {
        this.#quarantineAnnFiles(`child-${op}-crash`);
        this.#log("ann.rebuild_requested", { reason: `child_${op}_crash` });
      }
      return await this.#request(op, args, { retry: false, timeoutMs });
    }
  }

  #sendToCurrent(op, args = {}, { timeoutMs = CHILD_REQUEST_TIMEOUT_MS, killOnTimeout = true } = {}) {
    const child = this.#child;
    if (!this.#isCurrentChildRunning()) {
      throw decorateError(new Error("EmbeddingIndex child is not running"), { code: "EMBEDDING_CHILD_EXIT" });
    }
    const id = this.#nextId++;
    recordEmbeddingForensics("child_index.request.start", {
      request_id: id,
      op,
      child_pid: child.pid || null,
      timeout_ms: timeoutMs,
      pending_count: this.#pending.size,
      args: summarizeChildArgs(op, args),
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      model_dir: this.#modelDir(),
    });
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? setTimeout(() => {
          this.#pending.delete(id);
          recordEmbeddingForensics("child_index.request.timeout", {
            request_id: id,
            op,
            child_pid: child.pid || null,
            timeout_ms: timeoutMs,
            pending_count: this.#pending.size,
          });
          reject(decorateError(new Error(`EmbeddingIndex child ${op} timed out after ${timeoutMs}ms`), {
            code: "EMBEDDING_CHILD_TIMEOUT",
            op,
            timeoutMs,
          }));
          if (killOnTimeout) {
            // Mark as a deliberate retirement BEFORE killing so the async exit
            // is logged as child.retired, not child.stale_exit.
            this.#retiredChildren.add(child);
            try { child.kill(); } catch { /* best effort */ }
          }
        }, Number(timeoutMs))
        : null;
      timer?.unref?.();
      this.#pending.set(id, { resolve, reject, timer, op, child });
      try {
        child.send({ id, op, args }, (err) => {
          if (!err) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          recordEmbeddingForensics("child_index.request.send_failed", {
            request_id: id,
            op,
            child_pid: child.pid || null,
            error: errorForTelemetry(err),
          });
          pending.reject(decorateError(err instanceof Error ? err : new Error(String(err)), {
            code: "EMBEDDING_CHILD_SEND_FAILED",
            op,
          }));
        });
      } catch (err) {
        const pending = this.#pending.get(id);
        if (pending?.timer) clearTimeout(pending.timer);
        this.#pending.delete(id);
        recordEmbeddingForensics("child_index.request.send_throw", {
          request_id: id,
          op,
          child_pid: child.pid || null,
          error: errorForTelemetry(err),
        });
        reject(decorateError(err instanceof Error ? err : new Error(String(err)), {
          code: "EMBEDDING_CHILD_SEND_FAILED",
          op,
        }));
      }
    });
  }

  #quarantineAnnFiles(reason) {
    const modelDir = this.#modelDir();
    const safeReason = String(reason || "child-crash").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "child-crash";
    const stamp = nowIsoForFile();
    const out = [];
    for (const fileName of [ANN_INDEX_FILE, ANN_MANIFEST_FILE]) {
      const filePath = path.join(modelDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const target = `${filePath}.${safeReason}-${stamp}-${process.pid}`;
      try {
        fs.renameSync(filePath, target);
        out.push({ file_path: filePath, quarantine_path: target });
      } catch (err) {
        out.push({ file_path: filePath, error: err?.message || String(err) });
      }
    }
    if (out.length > 0) this.#log("ann.quarantined", { reason: safeReason, files: out });
    return out;
  }

  /**
   * @param {EmbeddingIngest[]} rows
   */
  /**
   * Attach a no-op catch so a close-race rejection on an ABANDONED op cannot
   * become a process-killing unhandled rejection. close() rejects every pending
   * op with EMBEDDING_CHILD_CLOSED; if the op's caller is fire-and-forget — or
   * its awaiter already unwound (e.g. the warm aborted mid-ingest) — there is no
   * live handler, so the rejection escapes and kills the run before wrap-up.
   * Public methods therefore return the GUARDED promise directly (not via an
   * async wrapper, which would create a fresh unguarded promise): callers that
   * DO await still receive the rejection; abandoned ops are silently dropped.
   * @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  #guarded(promise) {
    promise.catch(() => { /* abandoned-op close race — see #guarded */ });
    return promise;
  }

  /**
   * @param {EmbeddingIngest[]} rows
   */
  add(rows) {
    return this.#guarded(
      this.#request("add", { rows: Array.isArray(rows) ? rows : [] })
        .then((result) => { this.#lastAddTiming = result?.lastAddTiming || null; }),
    );
  }

  /**
   * @param {string[]} content_hashes
   */
  removeByContentHash(content_hashes) {
    return this.#guarded(this.#request("removeByContentHash", { content_hashes: Array.isArray(content_hashes) ? content_hashes : [] }));
  }

  /**
   * @param {{ content_hash: string, local_id: number }[]} keys
   */
  pruneToKeys(keys) {
    return this.#guarded(this.#request("pruneToKeys", { keys: Array.isArray(keys) ? keys : [] }));
  }

  /**
   * @param {string} content_hash
   * @param {number} local_id
   */
  contains(content_hash, local_id) {
    return this.#guarded(this.#request("contains", { content_hash, local_id }).then((v) => !!v));
  }

  /**
   * @param {{ content_hash: string, local_id: number }[]} keys
   * @returns {Promise<Set<string>>}
   */
  containsMany(keys) {
    return this.#guarded(
      this.#request("containsMany", { keys: Array.isArray(keys) ? keys : [] })
        .then((result) => new Set((Array.isArray(result) ? result : []).map(String))),
    );
  }

  getLastAddTiming() {
    return this.#lastAddTiming ? { ...this.#lastAddTiming } : null;
  }

  /**
   * @param {string} key
   * @returns {Promise<Record<string, any> | null>}
   */
  getEmbeddingWatermark(key) {
    return this.#guarded(this.#request("getEmbeddingWatermark", { key: String(key || "") }).then((value) => value ?? null));
  }

  /**
   * @param {string} key
   * @param {Record<string, any>} watermark
   * @returns {Promise<void>}
   */
  setEmbeddingWatermark(key, watermark) {
    return this.#guarded(
      this.#request("setEmbeddingWatermark", {
        key: String(key || ""),
        watermark: watermark && typeof watermark === "object" ? watermark : {},
      }).then(() => undefined),
    );
  }

  /**
   * @param {Float32Array} vector
   * @param {EmbeddingSearchOptions} [opts]
   * @returns {Promise<EmbeddingHit[]>}
   */
  nearest(vector, opts = {}) {
    return this.#guarded(this.#request("nearest", { vector, opts: serializeSearchOptions(opts) }));
  }

  count() {
    return this.#guarded(this.#request("count"));
  }

  // --- Durable in-flight breadcrumb passthroughs ---------------------------
  // The breadcrumb lives next to keys.db inside the child's EmbeddingIndex
  // (see EmbeddingIndex.markEncoding). These ops forward to the child so the
  // crash-recovery marker actually exists in production, where this class is
  // the only index callers ever see.

  /**
   * @param {Array<{ content_hash: string, local_id: number }>} keys
   * @param {{ branch?: string|null, batch?: number, total?: number }} [meta]
   */
  markEncoding(keys, meta = {}) {
    return this.#guarded(this.#request("markEncoding", {
      keys: Array.isArray(keys) ? keys : [],
      meta: meta && typeof meta === "object" ? meta : {},
    }));
  }

  /** Clear the in-flight marker once the batch has durably committed. */
  clearEncoding() {
    return this.#guarded(this.#request("clearEncoding"));
  }

  /**
   * @returns {Promise<{ started_at: string, branch: string|null, batch: number|null, total: number|null, keys: Array<{content_hash:string, local_id:number}> } | null>}
   */
  readInflight() {
    return this.#guarded(this.#request("readInflight").then((value) => value ?? null));
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopping = true;
    const child = this.#child;
    try {
      if (child && !child.killed) {
        await this.#sendToCurrent("close", {}, { timeoutMs: 10_000, killOnTimeout: false }).catch(() => undefined);
      }
    } finally {
      for (const pending of this.#pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(decorateError(new Error("EmbeddingIndex child closed"), { code: "EMBEDDING_CHILD_CLOSED" }));
      }
      this.#pending.clear();
      try { child?.disconnect?.(); } catch { /* best effort */ }
      const exited = await waitForChildExit(child, 5_000);
      if (!exited && isChildRunning(child)) {
        this.#retiredChildren.add(child);
        try { child?.kill?.(); } catch { /* best effort */ }
      }
      if (this.#child === child) this.#child = null;
    }
  }
}

function isChildRunning(child) {
  return !!child && !child.killed && child.exitCode == null && child.signalCode == null;
}

function waitForChildExit(child, graceMs) {
  if (!isChildRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off?.("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, Number(graceMs) || 1));
    timer.unref?.();
    child.once?.("exit", onExit);
  });
}

function diagnosticReportExecArgv(reportDir) {
  const inherited = process.execArgv.filter((arg) => !String(arg).startsWith("--inspect"));
  return [
    ...inherited,
    "--report-on-fatalerror",
    "--report-uncaught-exception",
    "--report-on-signal",
    `--report-directory=${reportDir}`,
  ];
}

function summarizeChildArgs(op, args = {}) {
  if (op === "add") {
    const rows = Array.isArray(args?.rows) ? args.rows : [];
    return {
      rows: rows.length,
      first: rowIdentity(rows[0]),
      last: rowIdentity(rows[rows.length - 1]),
    };
  }
  if (op === "containsMany" || op === "pruneToKeys" || op === "markEncoding") {
    const keys = Array.isArray(args?.keys) ? args.keys : [];
    return {
      keys: keys.length,
      first: keyIdentity(keys[0]),
      last: keyIdentity(keys[keys.length - 1]),
    };
  }
  if (op === "getEmbeddingWatermark" || op === "setEmbeddingWatermark") {
    return {
      key: String(args?.key || "").slice(0, 80),
      ledger_seq: Number.isInteger(args?.watermark?.ledger_seq) ? args.watermark.ledger_seq : null,
    };
  }
  if (op === "removeByContentHash") {
    return { content_hashes: Array.isArray(args?.content_hashes) ? args.content_hashes.length : 0 };
  }
  if (op === "nearest") {
    return {
      vector_dim: Number.isInteger(args?.vector?.length) ? args.vector.length : null,
      opts: args?.opts || null,
    };
  }
  return {};
}

function summarizeChildResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ok: /** @type {any} */ (result).ok ?? null,
      count: /** @type {any} */ (result).count ?? null,
      last_add_timing: /** @type {any} */ (result).lastAddTiming || null,
      model: /** @type {any} */ (result).model || null,
      backend: /** @type {any} */ (result).backend || null,
    };
  }
  if (Array.isArray(result)) return { array_length: result.length };
  return { value: result ?? null };
}

function rowIdentity(row) {
  if (!row || typeof row !== "object") return null;
  return {
    local_id: Number.isInteger(row.local_id) ? row.local_id : null,
    content_hash: typeof row.content_hash === "string" ? row.content_hash.slice(0, 16) : null,
    vector_dim: Number.isInteger(row?.vector?.length) ? row.vector.length : null,
  };
}

function keyIdentity(key) {
  if (!key || typeof key !== "object") return null;
  return {
    local_id: Number.isInteger(key.local_id) ? key.local_id : null,
    content_hash: typeof key.content_hash === "string" ? key.content_hash.slice(0, 16) : null,
  };
}
