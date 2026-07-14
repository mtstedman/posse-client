// @ts-check

import path from "node:path";
import { languageTagForExtension } from "../../functions/v2/language-tag.js";

/**
 * Ordered join between the tree-sitter and SCIP sides of intake.
 *
 * A document becomes visible to the consumer only after tree-sitter has
 * committed its layer and SCIP has either committed the same immutable
 * content hash or the SCIP phase has completed without a matching document.
 * The async iterator is rendezvous-based: it never accumulates a second,
 * unbounded queue behind the ONNX runner's bounded document window.
 */
export class OrderedDocumentIntake {
  /** @type {Array<any>} */
  #records = [];
  /** @type {Map<string, any>} */
  #byPath = new Map();
  /** @type {Map<string, Map<string, any>>} */
  #earlyScip = new Map();
  /** @type {Array<{ resolve: (value: IteratorResult<any>) => void, reject: (error: unknown) => void }>} */
  #readers = [];
  #registered = false;
  #treeSitterFinished = false;
  #scipFinished = false;
  #cursor = 0;
  #processed = 0;
  #readAhead;
  /** @type {Array<() => void>} */
  #windowWaiters = [];
  /** @type {Array<{ documents: Array<{ repo_rel_path: string, content_hash: string }>, source_languages: string[], scope_paths: string[] }>} */
  #earlyCoverage = [];
  #closed = false;
  /** @type {unknown} */
  #failure = null;
  /** @type {Promise<void>} */
  #done;
  /** @type {() => void} */
  #resolveDone;
  /** @type {(error: unknown) => void} */
  #rejectDone;

  /** @param {{ readAhead?: number }} [opts] */
  constructor({ readAhead = 8 } = {}) {
    this.#readAhead = Math.max(1, Math.floor(Number(readAhead) || 8));
    let resolveDone;
    let rejectDone;
    this.#done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    this.#done.catch(() => {});
    this.#resolveDone = /** @type {() => void} */ (resolveDone);
    this.#rejectDone = /** @type {(error: unknown) => void} */ (rejectDone);
  }

  /** @returns {Promise<void>} */
  get done() {
    return this.#done;
  }

  /**
   * Register the authoritative file sequence. Duplicate path hints collapse to
   * one document because the final view also has one row-set per path.
   *
   * @param {string[]} paths
   */
  registerPaths(paths) {
    if (this.#registered) throw new Error("OrderedDocumentIntake paths are already registered");
    this.#registered = true;
    const seen = new Set();
    for (const rawPath of Array.isArray(paths) ? paths : []) {
      const repoRelPath = String(rawPath || "");
      if (!repoRelPath || seen.has(repoRelPath)) continue;
      seen.add(repoRelPath);
      const record = {
        ordinal: this.#records.length,
        repo_rel_path: repoRelPath,
        treeSitter: null,
        scipByHash: this.#earlyScip.get(repoRelPath) || new Map(),
        scipTerminal: false,
        skipped: false,
        delivered: deferred(),
        processed: deferred(),
      };
      this.#records.push(record);
      this.#byPath.set(repoRelPath, record);
    }
    this.#earlyScip.clear();
    for (const coverage of this.#earlyCoverage.splice(0)) this.#applyScipCoverage(coverage);
    this.#pump();
  }

  /**
   * Wait before beginning ordered source work outside the N+1 window. The
   * tree-sitter walk uses this before reading; SCIP applies the same pressure
   * when its committed document reaches the ordered head, while allowing an
   * out-of-order artifact to keep writing until it can close an earlier gap.
   *
   * @param {string} repoRelPath
   */
  async waitForReadAhead(repoRelPath) {
    const record = this.#byPath.get(String(repoRelPath || ""));
    if (!record || record.ordinal < this.#processed + this.#readAhead || this.#closed) return;
    await new Promise((resolve) => this.#windowWaiters.push(resolve));
    return this.waitForReadAhead(repoRelPath);
  }

  /**
   * @param {{ repo_rel_path: string, content_hash: string }} source
   * @returns {Promise<void>}
   */
  async markTreeSitter(source) {
    const record = this.#byPath.get(String(source?.repo_rel_path || ""));
    if (!record || record.skipped) return;
    const contentHash = String(source?.content_hash || "");
    if (!contentHash) throw new Error(`tree-sitter completion for '${record.repo_rel_path}' is missing content_hash`);
    record.treeSitter = documentSource(record.repo_rel_path, contentHash);
    const wasHead = record.ordinal === this.#cursor;
    this.#pump();
    // Only the ordered head applies producer backpressure. Awaiting a later
    // record behind an unfinished earlier SCIP document can deadlock the SCIP
    // phase that is needed to close that gap.
    if (wasHead && this.#recordReady(record)) await record.delivered.promise;
  }

  /**
   * @param {{ repo_rel_path: string, content_hash: string }} source
   * @returns {Promise<void>}
   */
  async markScip(source) {
    const repoRelPath = String(source?.repo_rel_path || "");
    const contentHash = String(source?.content_hash || "");
    if (!repoRelPath || !contentHash) return;
    const record = this.#byPath.get(repoRelPath);
    if (!record) {
      let hashes = this.#earlyScip.get(repoRelPath);
      if (!hashes) {
        hashes = new Map();
        this.#earlyScip.set(repoRelPath, hashes);
      }
      hashes.set(contentHash, documentSource(repoRelPath, contentHash));
      return;
    }
    if (record.skipped) return;
    record.scipByHash.set(contentHash, documentSource(repoRelPath, contentHash));
    const wasHead = record.ordinal === this.#cursor;
    this.#pump();
    if (wasHead && this.#recordReady(record)) await record.delivered.promise;
  }

  /**
   * The native SCIP conversion knows the artifact's complete document set
   * before ledger writes begin. Declaring it closes "SCIP absent" gaps early,
   * so ordered backpressure cannot deadlock behind an omitted source file.
   *
   * @param {{ documents?: Array<{ repo_rel_path: string, content_hash: string }>, source_languages?: string[], scope_paths?: string[] }} coverage
   */
  declareScipCoverage(coverage) {
    const normalized = {
      documents: (Array.isArray(coverage?.documents) ? coverage.documents : [])
        .map((document) => ({
          repo_rel_path: String(document?.repo_rel_path || ""),
          content_hash: String(document?.content_hash || ""),
        }))
        .filter((document) => document.repo_rel_path && document.content_hash),
      source_languages: (Array.isArray(coverage?.source_languages) ? coverage.source_languages : [])
        .map((language) => String(language || "").trim().toLowerCase())
        .filter(Boolean),
      scope_paths: (Array.isArray(coverage?.scope_paths) ? coverage.scope_paths : [])
        .map((repoRelPath) => String(repoRelPath || ""))
        .filter(Boolean),
    };
    if (!this.#registered) {
      this.#earlyCoverage.push(normalized);
      return;
    }
    this.#applyScipCoverage(normalized);
  }

  /** @param {{ repo_rel_path?: string }} document */
  markProcessed(document) {
    const record = this.#byPath.get(String(document?.repo_rel_path || ""));
    if (!record || record.ordinal !== this.#processed) {
      throw new Error(`ONNX processed document sequence diverged at '${document?.repo_rel_path || "<unknown>"}'`);
    }
    record.processed.resolve();
    this.#processed++;
    this.#advanceProcessedPastSkips();
    this.#wakeWindowWaiters();
  }

  /** @param {string} repoRelPath */
  async waitUntilProcessed(repoRelPath) {
    const record = this.#byPath.get(String(repoRelPath || ""));
    if (!record || record.ordinal < this.#processed) return;
    await record.processed.promise;
  }

  /** @param {string} repoRelPath */
  skip(repoRelPath) {
    const record = this.#byPath.get(String(repoRelPath || ""));
    if (!record || record.treeSitter) return;
    record.skipped = true;
    this.#pump();
  }

  finishTreeSitter() {
    if (!this.#registered) this.registerPaths([]);
    this.#treeSitterFinished = true;
    for (const record of this.#records) {
      if (!record.treeSitter) record.skipped = true;
    }
    this.#pump();
  }

  finishScip() {
    this.#scipFinished = true;
    for (const record of this.#records) {
      if (!record.treeSitter || record.scipByHash.size === 0) continue;
      if (!record.scipByHash.has(record.treeSitter.content_hash)) record.skipped = true;
    }
    this.#pump();
  }

  /** @param {unknown} error */
  abort(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error instanceof Error ? error : new Error(String(error || "document intake aborted"));
    for (const reader of this.#readers.splice(0)) reader.reject(this.#failure);
    for (const record of this.#records) {
      record.delivered.reject(this.#failure);
      record.processed.reject(this.#failure);
    }
    for (const wake of this.#windowWaiters.splice(0)) wake();
    this.#rejectDone(this.#failure);
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  /** @returns {Promise<IteratorResult<any>>} */
  next() {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject });
      this.#pump();
    });
  }

  /** @returns {Promise<IteratorResult<any>>} */
  return() {
    if (!this.#closed) {
      this.#closed = true;
      for (const reader of this.#readers.splice(0)) reader.resolve({ value: undefined, done: true });
      for (const record of this.#records) {
        record.delivered.resolve();
        record.processed.resolve();
      }
      for (const wake of this.#windowWaiters.splice(0)) wake();
      this.#resolveDone();
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  #recordReady(record) {
    if (!record?.treeSitter) return false;
    return record.scipByHash.has(record.treeSitter.content_hash)
      || record.scipTerminal === true
      || this.#scipFinished;
  }

  #applyScipCoverage(coverage) {
    const documentsByPath = new Map();
    for (const document of coverage.documents) {
      let hashes = documentsByPath.get(document.repo_rel_path);
      if (!hashes) {
        hashes = new Set();
        documentsByPath.set(document.repo_rel_path, hashes);
      }
      hashes.add(document.content_hash);
    }
    const languages = new Set(coverage.source_languages);
    const scopedPaths = new Set(coverage.scope_paths || []);
    for (const record of this.#records) {
      if (scopedPaths.size > 0 && !scopedPaths.has(record.repo_rel_path)) continue;
      const hashes = documentsByPath.get(record.repo_rel_path);
      const language = languageTagForExtension(path.extname(record.repo_rel_path).toLowerCase());
      // Coverage is not a commit. Present documents remain blocked until
      // markScip arrives after their ledger mutation; only files omitted from
      // this language artifact become terminal here.
      if (!hashes && (scopedPaths.size > 0 || (language && languages.has(language)))) {
        record.scipTerminal = true;
      }
    }
    this.#pump();
  }

  #pump() {
    if (this.#closed || !this.#registered) return;
    while (this.#cursor < this.#records.length) {
      const record = this.#records[this.#cursor];
      if (record.skipped) {
        record.delivered.resolve();
        this.#cursor++;
        if (record.ordinal === this.#processed) {
          record.processed.resolve();
          this.#processed++;
          this.#advanceProcessedPastSkips();
          this.#wakeWindowWaiters();
        }
        continue;
      }
      if (!this.#recordReady(record) || this.#readers.length === 0) break;
      const treeSitter = record.treeSitter;
      const scip = record.scipByHash.get(treeSitter.content_hash)
        || documentSource(record.repo_rel_path, treeSitter.content_hash);
      const reader = this.#readers.shift();
      reader.resolve({
        done: false,
        value: {
          document_id: record.repo_rel_path,
          repo_rel_path: record.repo_rel_path,
          content_hash: treeSitter.content_hash,
          treeSitter,
          scip,
        },
      });
      record.delivered.resolve();
      this.#cursor++;
    }
    if (this.#cursor < this.#records.length) return;
    if (!this.#treeSitterFinished || !this.#scipFinished) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader.resolve({ value: undefined, done: true });
    this.#resolveDone();
  }

  #advanceProcessedPastSkips() {
    while (this.#processed < this.#records.length && this.#records[this.#processed].skipped) {
      this.#records[this.#processed].processed.resolve();
      this.#processed++;
    }
  }

  #wakeWindowWaiters() {
    for (const wake of this.#windowWaiters.splice(0)) wake();
  }
}

function documentSource(repoRelPath, contentHash) {
  return {
    document_id: repoRelPath,
    repo_rel_path: repoRelPath,
    content_hash: contentHash,
    // Layer rows stay in the ledger. The ONNX runner validates identity here,
    // then mergeDocument reads the committed A+B rows for this hash.
    symbols: [],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A later out-of-order source may never become the ordered head after an
  // abort; avoid process-level unhandled rejection noise for its private ack.
  promise.catch(() => {});
  return {
    promise,
    resolve: /** @type {() => void} */ (resolve),
    reject: /** @type {(error: unknown) => void} */ (reject),
  };
}
