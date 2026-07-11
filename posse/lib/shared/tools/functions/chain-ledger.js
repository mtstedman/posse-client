// Shared researcher chain-read audit ledger. Tracks what the researcher has
// read, gates the next read until a verdict (relevant/irrelevant) is emitted,
// and accumulates a relevant-content buffer. Both runtimes instantiate this:
// the deterministic MCP server (with disk persistence) and the embedded
// OpenAI/Grok loop (in-memory, per job).
//
// Parameterized over:
//   readFile(args, cwd, scopePredicates) -> string   the raw file reader
//   cwd, scopePredicates                              read scope
//   atlasAvailable                                    enables the symbol-lookup hint
//   persist { load() -> rawState|null, save(rawState) } optional durable store

import path from "path";

import { CONTEXT_CHAIN_READ_DEFAULT_LIMIT_LINES } from "../../../catalog/context.js";

// Matches the out-of-range sentinel returned by the toolkit read executor when
// the requested offset is past EOF. Not an "Error:" string and not content, so
// chainRead must not store it in the research buffer.
const READ_FILE_EOF_SENTINEL_RE = /^File has \d+ lines\. Requested offset \d+ is beyond end of file\.$/;

function normalizeReadRange(argVal, fallback) {
  const n = Number.parseInt(String(argVal ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function createChainLedger({
  readFile,
  cwd,
  scopePredicates,
  atlasAvailable = false,
  persist = null,
} = {}) {
  if (typeof readFile !== "function") {
    throw new Error("createChainLedger requires a readFile function");
  }
  const workspaceCwd = cwd || process.cwd();
  const state = {
    currentlyReading: null,   // { path, content, offset, limit, continuation } — awaiting verdict
    relevant: new Map(),      // path -> { summary, content }
    irrelevant: new Set(),    // paths tagged irrelevant
    readOrder: [],            // ordered list of all reads
  };

  if (persist && typeof persist.load === "function") {
    try {
      const data = persist.load();
      if (data) {
        if (data.relevant) {
          for (const [p, v] of Object.entries(data.relevant)) state.relevant.set(p, v);
        }
        if (Array.isArray(data.irrelevant)) {
          for (const p of data.irrelevant) state.irrelevant.add(p);
        }
        if (Array.isArray(data.readOrder)) state.readOrder = data.readOrder;
        if (data.currentlyReading) state.currentlyReading = data.currentlyReading;
      }
    } catch { /* fresh start */ }
  }

  function save() {
    if (!persist || typeof persist.save !== "function") return;
    try {
      persist.save({
        currentlyReading: state.currentlyReading,
        relevant: Object.fromEntries(state.relevant),
        irrelevant: [...state.irrelevant],
        readOrder: state.readOrder,
      });
    } catch { /* best effort */ }
  }

  function chainRead(args = {}) {
    const requestedPath = args.path;
    if (!requestedPath) return "Error: path is required.";

    if (state.currentlyReading) {
      const pending = state.currentlyReading.path;
      return `AUDIT ERROR: Chain is locked. You must call chain_verdict on "${pending}" before reading another file.`;
    }

    const resolvedPath = path.resolve(workspaceCwd, requestedPath).replace(/\\/g, "/");
    const relPath = path.relative(workspaceCwd, resolvedPath).replace(/\\/g, "/");
    const offset = normalizeReadRange(args.offset, 1);
    const limit = normalizeReadRange(args.limit, CONTEXT_CHAIN_READ_DEFAULT_LIMIT_LINES);
    const continuationRead = offset > 1;

    if (state.relevant.has(relPath) && !continuationRead) {
      const cached = state.relevant.get(relPath) || {};
      const ledgerLine = `[audit ledger: ${state.relevant.size} relevant, ${state.irrelevant.size} irrelevant, ${state.readOrder.length} total reads]`;
      return [
        ledgerLine,
        `[chain restored from ledger: "${relPath}" was already tagged relevant; verdict carries over, do not call chain_verdict again for this restored view]`,
        cached.summary ? `[prior verdict summary: ${cached.summary}]` : "[prior verdict summary: none]",
        "",
        cached.content || "",
      ].join("\n");
    }
    if (state.irrelevant.has(relPath) && !continuationRead) {
      return `AUDIT ERROR: "${relPath}" was already read and tagged irrelevant. ` +
        `Each file may only be read once unless you request a continuation with offset/limit.`;
    }

    const result = readFile({ ...args, path: requestedPath, limit }, workspaceCwd, scopePredicates);

    if (READ_FILE_EOF_SENTINEL_RE.test(result.trim())) {
      return `AUDIT ERROR: ${result.trim()} Nothing was recorded; re-read "${relPath}" with a valid offset.`;
    }
    if (/^Error:/i.test(result.trim())) {
      const message = result.trim().replace(/^Error:\s*/i, "");
      return `AUDIT ERROR: ${message || "read failed"} Nothing was recorded.`;
    }

    if (!result.startsWith("Error:")) {
      state.currentlyReading = { path: relPath, content: result, offset, limit, continuation: continuationRead };
      state.readOrder.push(relPath);
      save();
    }

    const ledgerLine = `[audit ledger: ${state.relevant.size} relevant, ${state.irrelevant.size} irrelevant, ${state.readOrder.length} total reads]`;
    return `${ledgerLine}\n[chain locked — call chain_verdict when done reviewing this file]\n\n${result}`;
  }

  function chainVerdict(args = {}) {
    if (!state.currentlyReading) {
      return "AUDIT ERROR: No file pending verdict. Call chain_read first.";
    }
    const { path: filePath, content, continuation = false } = state.currentlyReading;
    const verdict = String(args.verdict || "").toLowerCase();
    const summary = String(args.summary || "").trim();

    if (verdict !== "relevant" && verdict !== "irrelevant") {
      return `AUDIT ERROR: verdict must be "relevant" or "irrelevant", got "${args.verdict}".`;
    }
    if (verdict === "irrelevant" && !summary) {
      return "AUDIT ERROR: summary is required when verdict is \"irrelevant\" so pruning can preserve why this file was excluded.";
    }

    const wasRelevant = state.relevant.has(filePath);
    if (verdict === "relevant") {
      const previous = state.relevant.get(filePath);
      const nextSummary = summary || "(no summary)";
      state.relevant.set(filePath, previous ? {
        summary: [previous.summary, continuation ? `continuation: ${nextSummary}` : nextSummary].filter(Boolean).join("; "),
        content: [previous.content, content].filter(Boolean).join("\n\n--- chain_read continuation ---\n\n"),
      } : {
        summary: nextSummary,
        content,
      });
      state.irrelevant.delete(filePath);
    } else if (!state.relevant.has(filePath)) {
      state.irrelevant.add(filePath);
    }

    state.currentlyReading = null;
    save();

    const response = {
      ok: true,
      tagged: filePath,
      verdict,
      summary: summary || null,
      ledger: { relevant: state.relevant.size, irrelevant: state.irrelevant.size, total: state.readOrder.length },
      evidence: {
        novel_relevant_file: verdict === "relevant" && !wasRelevant,
        continuation,
      },
      chain: "unlocked",
    };
    if (atlasAvailable && verdict === "relevant") {
      response.hint = "You have symbol.search and slice.build available. " +
        "Use them to trace connections from what you just found instead of browsing more files manually.";
    }
    return JSON.stringify(response, null, 2);
  }

  function digest() {
    return {
      relevant: [...state.relevant.entries()].map(([filePath, entry]) => ({
        path: filePath,
        summary: entry?.summary || "",
        chars: String(entry?.content || "").length,
      })),
      irrelevant: [...state.irrelevant],
      read_order: [...state.readOrder],
      pending: state.currentlyReading ? {
        path: state.currentlyReading.path,
        offset: state.currentlyReading.offset,
        limit: state.currentlyReading.limit,
      } : null,
    };
  }

  return { chainRead, chainVerdict, digest, save, state };
}
