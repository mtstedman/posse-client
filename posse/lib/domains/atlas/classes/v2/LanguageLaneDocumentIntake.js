// @ts-check

import path from "node:path";
import { languageTagForExtension } from "../../functions/v2/language-tag.js";
import { OrderedDocumentIntake } from "./OrderedDocumentIntake.js";

/**
 * One ordered tree-sitter/SCIP join per language, read as a single stream.
 *
 * Source work runs as an independent lane per language, so one ordered join
 * across every path would hold a finished language's documents behind the
 * first unfinished document of another. Each language keeps its own ordered
 * join here and the consumer reads whichever lane has a document ready. Order
 * inside a language is unchanged; documents of different languages interleave.
 * At most one delivered document per lane waits for the consumer.
 */
export class LanguageLaneDocumentIntake {
  /** @type {Map<string, OrderedDocumentIntake>} */
  #lanes = new Map();
  /** @type {Map<OrderedDocumentIntake, { pulling: boolean, exhausted: boolean }>} */
  #laneState = new Map();
  /** @type {Array<any>} */
  #ready = [];
  /** @type {Array<{ resolve: (value: IteratorResult<any>) => void, reject: (error: unknown) => void }>} */
  #readers = [];
  /** @type {Array<{ repo_rel_path: string, content_hash: string }>} */
  #earlyScip = [];
  /** @type {Array<any>} */
  #earlyCoverage = [];
  #registered = false;
  #closed = false;
  /** @type {unknown} */
  #failure = null;
  #laneOptions;
  /** @type {Promise<void>} */
  #done;
  /** @type {() => void} */
  #resolveDone;
  /** @type {(error: unknown) => void} */
  #rejectDone;

  /** @param {{ readAhead?: number, producerBackpressure?: boolean }} [opts] */
  constructor(opts = {}) {
    this.#laneOptions = opts;
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

  get done() {
    return this.#done;
  }

  /** Authoritative denominator once the repository path sequence is known. */
  get totalDocuments() {
    if (!this.#registered) return null;
    let total = 0;
    for (const lane of this.#lanes.values()) total += lane.totalDocuments || 0;
    return total;
  }

  /** @param {string[]} paths */
  registerPaths(paths) {
    if (this.#registered) throw new Error("LanguageLaneDocumentIntake paths are already registered");
    this.#registered = true;
    /** @type {Map<string, string[]>} */
    const byLane = new Map();
    for (const rawPath of Array.isArray(paths) ? paths : []) {
      const repoRelPath = String(rawPath || "");
      if (!repoRelPath) continue;
      const key = laneKey(repoRelPath);
      if (!byLane.has(key)) byLane.set(key, []);
      /** @type {string[]} */ (byLane.get(key)).push(repoRelPath);
    }
    for (const [key, lanePaths] of byLane) {
      const lane = new OrderedDocumentIntake(this.#laneOptions);
      this.#lanes.set(key, lane);
      this.#laneState.set(lane, { pulling: false, exhausted: false });
      lane.registerPaths(lanePaths);
    }
    for (const source of this.#earlyScip.splice(0)) void this.#laneFor(source.repo_rel_path)?.markScip(source);
    for (const coverage of this.#earlyCoverage.splice(0)) this.declareScipCoverage(coverage);
    Promise.all([...this.#lanes.values()].map((lane) => lane.done)).then(
      () => { this.#closed = true; this.#resolveDone(); },
      (error) => this.abort(error),
    );
    this.#pump();
  }

  /** @param {string} repoRelPath */
  async waitForReadAhead(repoRelPath) {
    await this.#laneFor(repoRelPath)?.waitForReadAhead(repoRelPath);
  }

  /** @param {{ repo_rel_path: string, content_hash: string }} source */
  async markTreeSitter(source) {
    await this.#laneFor(source?.repo_rel_path)?.markTreeSitter(source);
  }

  /** @param {{ repo_rel_path: string, content_hash: string }} source */
  async markScip(source) {
    if (!this.#registered) {
      const repoRelPath = String(source?.repo_rel_path || "");
      const contentHash = String(source?.content_hash || "");
      if (repoRelPath && contentHash) this.#earlyScip.push({ repo_rel_path: repoRelPath, content_hash: contentHash });
      return;
    }
    await this.#laneFor(source?.repo_rel_path)?.markScip(source);
  }

  /** @param {{ documents?: Array<{ repo_rel_path: string, content_hash: string }>, source_languages?: string[], scope_paths?: string[] }} coverage */
  declareScipCoverage(coverage) {
    if (!this.#registered) {
      this.#earlyCoverage.push(coverage);
      return;
    }
    // Each lane closes only the gaps among its own registered paths.
    for (const lane of this.#lanes.values()) lane.declareScipCoverage(coverage);
  }

  /** @param {{ repo_rel_path?: string }} document */
  markProcessed(document) {
    const lane = this.#laneFor(document?.repo_rel_path);
    if (!lane) throw new Error(`ONNX processed document sequence diverged at '${document?.repo_rel_path || "<unknown>"}'`);
    lane.markProcessed(document);
  }

  /** @param {string} repoRelPath */
  skip(repoRelPath) {
    this.#laneFor(repoRelPath)?.skip(repoRelPath);
  }

  finishTreeSitter() {
    if (!this.#registered) this.registerPaths([]);
    for (const lane of this.#lanes.values()) lane.finishTreeSitter();
    this.#pump();
  }

  finishScip() {
    if (!this.#registered) return;
    for (const lane of this.#lanes.values()) lane.finishScip();
    this.#pump();
  }

  /** @param {unknown} error */
  abort(error) {
    if (this.#failure || this.#closed) return;
    this.#closed = true;
    this.#failure = error instanceof Error ? error : new Error(String(error || "document intake aborted"));
    for (const lane of this.#lanes.values()) lane.abort(this.#failure);
    for (const reader of this.#readers.splice(0)) reader.reject(this.#failure);
    this.#rejectDone(this.#failure);
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  /** @returns {Promise<IteratorResult<any>>} */
  next() {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject });
      this.#pump();
    });
  }

  /** @returns {Promise<IteratorResult<any>>} */
  return() {
    if (!this.#closed) {
      this.#closed = true;
      for (const lane of this.#lanes.values()) void lane.return();
      this.#ready.length = 0;
      for (const reader of this.#readers.splice(0)) reader.resolve({ value: undefined, done: true });
      this.#resolveDone();
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  /** @param {unknown} repoRelPath */
  #laneFor(repoRelPath) {
    return this.#lanes.get(laneKey(String(repoRelPath || ""))) || null;
  }

  #pump() {
    if (this.#failure) return;
    while (this.#readers.length > 0 && this.#ready.length > 0) {
      /** @type {{ resolve: (value: IteratorResult<any>) => void }} */ (this.#readers.shift())
        .resolve({ done: false, value: this.#ready.shift() });
    }
    if (this.#readers.length === 0 || !this.#registered) return;
    let open = false;
    for (const [lane, state] of this.#laneState) {
      if (state.exhausted) continue;
      open = true;
      if (state.pulling) continue;
      state.pulling = true;
      lane.next().then((result) => {
        state.pulling = false;
        if (result.done) state.exhausted = true;
        else this.#ready.push(result.value);
        this.#pump();
      }, (error) => this.abort(error));
    }
    if (open || this.#ready.length > 0) return;
    for (const reader of this.#readers.splice(0)) reader.resolve({ value: undefined, done: true });
  }
}

/** @param {string} repoRelPath */
function laneKey(repoRelPath) {
  return languageTagForExtension(path.extname(repoRelPath).toLowerCase()) || "";
}
