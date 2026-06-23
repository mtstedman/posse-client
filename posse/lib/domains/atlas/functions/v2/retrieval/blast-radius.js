// @ts-check
//
// review.analyze + review.risk handlers, plus review.delta.
//
// The PR-risk surface combines two pieces:
//   1. A semantic delta between two versions (added/removed/modified
//      symbols + touched paths).
//   2. A risk analysis: blast radius of the changes plus heuristic
//      findings (high inbound-edge counts, API breaks, etc.).
//
// Version semantics:
//   - When the dispatch context supplies a `ledger`, versionIds parse
//     as "<branch>@<seq>" (or the bare seq is interpreted against the
//     `main` branch). The Ledger walks the path-snapshot at each end
//     and we diff blob_symbols per touched path.
//   - When no `ledger` is available, we degrade to the v0 behavior:
//     every current-view symbol reads as "added". The dispatcher logs
//     this fallback via the envelope `meta.cached = false`.

import { symbolHit, bareSymbolCard } from "./cards.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../contracts/tool-params.js").DeltaGetParams} DeltaGetParams */
/** @typedef {import("../contracts/tool-params.js").PrRiskAnalyzeParams} PrRiskAnalyzeParams */
/** @typedef {import("../contracts/tool-params.js").PrRiskParams} PrRiskParams */
/** @typedef {import("../contracts/tool-results.js").DeltaData} DeltaData */
/** @typedef {import("../contracts/tool-results.js").PrRiskAnalyzeData} PrRiskAnalyzeData */
/** @typedef {import("../contracts/tool-results.js").PrRiskData} PrRiskData */
/** @typedef {import("../contracts/tool-results.js").RiskFinding} RiskFinding */
/** @typedef {import("../contracts/tool-results.js").DeltaCard} DeltaCard */
/** @typedef {import("../contracts/tool-results.js").SymbolCard} SymbolCard */

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: DeltaGetParams,
 *   ledger?: Ledger,
 * }} args
 * @returns {import("../contracts/tool-results.js").ToolResultEnvelope<DeltaData>}
 */
export function deltaGet({ view, versionId, params, ledger }) {
  if (!params.fromVersion || !params.toVersion) {
    return errorEnvelope({
      action: "review.delta",
      versionId,
      code: "invalid_params",
      message: "review.delta requires fromVersion and toVersion",
    });
  }
  const maxCards = typeof params.maxCards === "number" ? params.maxCards : 100;

  // Ledger-backed path: real two-snapshot diff.
  if (ledger) {
    // Bare-integer fromVersion/toVersion default to the call-context's
    // branch so a WI worktree does not silently read main's snapshot.
    const defaultBranch = parseVersionId(versionId)?.branch || "main";
    const from = parseVersionId(params.fromVersion, defaultBranch);
    const to = parseVersionId(params.toVersion, defaultBranch);
    if (from && to) {
      try {
        const result = computeLedgerDelta({ ledger, from, to, maxCards });
        /** @type {DeltaData} */
        const data = {
          fromVersion: params.fromVersion,
          toVersion: params.toVersion,
          cards: result.cards.slice(0, maxCards),
          summary: result.summary,
          budgetUsage: {
            cardsReturned: Math.min(result.cards.length, maxCards),
            estimatedTokens: Math.min(result.cards.length, maxCards) * 80,
            hitCardCap: result.cards.length > maxCards,
            hitTokenCap: false,
          },
          truncated: result.cards.length > maxCards,
        };
        return okEnvelope({ action: "review.delta", versionId, data });
      } catch (err) {
        return errorEnvelope({
          action: "review.delta",
          versionId,
          code: "ledger_walk_failed",
          message: String(/** @type {any} */ (err)?.message || err),
        });
      }
    }
  }

  // Fallback: view-only "everything is added".
  const allSymbols = collectAllSymbolsInView(view);
  /** @type {DeltaCard[]} */
  const cards = [];
  /** @type {Set<string>} */
  const touchedPaths = new Set();
  for (const sym of allSymbols) {
    if (cards.length >= maxCards) break;
    touchedPaths.add(sym.repo_rel_path);
    cards.push({
      symbolId: `${sym.content_hash}:${sym.local_id}`,
      change: "added",
      after: viewSymbolToCard(sym),
    });
  }
  /** @type {DeltaData} */
  const data = {
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    cards,
    summary: {
      added: cards.length,
      removed: 0,
      modified: 0,
      moved: 0,
      touchedPaths: Array.from(touchedPaths).sort(),
    },
    budgetUsage: {
      cardsReturned: cards.length,
      estimatedTokens: cards.length * 80,
      hitCardCap: allSymbols.length > maxCards,
      hitTokenCap: false,
    },
    truncated: allSymbols.length > maxCards,
  };
  return okEnvelope({ action: "review.delta", versionId, data });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: PrRiskAnalyzeParams,
 *   ledger?: Ledger,
 * }} args
 * @returns {import("../contracts/tool-results.js").ToolResultEnvelope<PrRiskAnalyzeData>}
 */
export function prRiskAnalyze({ view, versionId, params, ledger }) {
  if (!params.fromVersion || !params.toVersion) {
    return errorEnvelope({
      action: "review.analyze",
      versionId,
      code: "invalid_params",
      message: "review.analyze requires fromVersion and toVersion",
    });
  }

  /** @type {Set<string>} */
  let touchedPaths = new Set();
  /** @type {DeltaCard[]} */
  let deltaCards = [];
  let deltaComputed = false;
  if (ledger) {
    const defaultBranch = parseVersionId(versionId)?.branch || "main";
    const from = parseVersionId(params.fromVersion, defaultBranch);
    const to = parseVersionId(params.toVersion, defaultBranch);
    if (from && to) {
      try {
        const computed = computeLedgerDelta({ ledger, from, to, maxCards: 100 });
        deltaComputed = true;
        deltaCards = computed.cards;
        const fromMap = ledger.pathSnapshotAt(from.branch, from.seq);
        const toMap = ledger.pathSnapshotAt(to.branch, to.seq);
        for (const p of toMap.keys()) {
          if (fromMap.get(p) !== toMap.get(p)) touchedPaths.add(p);
        }
        for (const p of fromMap.keys()) {
          if (!toMap.has(p)) touchedPaths.add(p);
        }
      } catch {
        // Fall through to the view-based estimate.
        touchedPaths = new Set();
      }
    }
  }
  if (deltaComputed && touchedPaths.size === 0) {
    /** @type {PrRiskAnalyzeData} */
    const data = {
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      findings: [],
      blastRadius: [],
      recommendedTests: [],
      riskScore: 0,
    };
    return okEnvelope({ action: "review.analyze", versionId, data });
  }
  if (touchedPaths.size === 0) {
    const all = collectAllSymbolsInView(view);
    for (const s of all) touchedPaths.add(s.repo_rel_path);
  }
  const blastRadiusSymbols = view.query.blastRadius(Array.from(touchedPaths));
  const topImpact = Number(/** @type {any} */ (blastRadiusSymbols[0])?._impact || 0);
  const blastRadius = blastRadiusSymbols.slice(0, 100).map((s) => {
    const hit = symbolHit(s);
    const impact = Number(/** @type {any} */ (s)?._impact || 0);
    if (topImpact > 0) hit.score = Math.min(1, impact / topImpact);
    return hit;
  });

  /** @type {RiskFinding[]} */
  const findings = [];
  // Hotspot heuristic: symbols defined in touched files with > 20 inbound edges.
  for (const path of touchedPaths) {
    if (findings.length >= 25) break;
    for (const sym of view.query.symbolsInFile(path).slice(0, 10)) {
      const callers = view.query.callers(sym.global_id);
      if (callers.length >= 50 || isPublicEntryPointSymbol(sym)) {
        findings.push({
          id: `high_impact:${sym.content_hash}:${sym.local_id}`,
          severity: "high",
          category: callers.length >= 50 ? "very_high_fanin" : "public_api_change",
          message: `${sym.name} is a high-impact changed symbol; ${callers.length} inbound reference${callers.length === 1 ? "" : "s"} found`,
          relatedSymbols: [`${sym.content_hash}:${sym.local_id}`],
        });
      } else if (callers.length >= 20) {
        findings.push({
          id: `hot_spot:${sym.content_hash}:${sym.local_id}`,
          severity: "medium",
          category: "high_fanin",
          message: `${sym.name} has ${callers.length} inbound references; changes likely have broad impact`,
          relatedSymbols: [`${sym.content_hash}:${sym.local_id}`],
        });
      }
    }
  }
  for (const card of deltaCards) {
    if (findings.length >= 25) break;
    if (card.change !== "modified") continue;
    const symbolId = card.after?.symbolId || card.symbolId;
    if (!symbolId || findings.some((f) => f.relatedSymbols?.includes(symbolId))) continue;
    findings.push({
      id: `signature_change:${symbolId}`,
      severity: "low",
      category: "signature_change",
      message: `${card.after?.name || card.before?.name || "Symbol"} changed signature; review direct callers and tests`,
      relatedSymbols: [symbolId],
    });
  }

  const riskThreshold =
    typeof params.riskThreshold === "number" ? params.riskThreshold : 50;
  const impactScore = blastRadius.reduce((sum, hit) => sum + (hit.score ?? 0), 0);
  const riskScore = Math.min(100, Math.round(impactScore + findings.length * 5));

  /** @type {PrRiskAnalyzeData} */
  const data = {
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    findings: findings.filter(
      (f) => severityToScore(f.severity) >= riskThreshold || riskThreshold <= 0,
    ),
    blastRadius,
    recommendedTests: blastRadius.slice(0, 10).map((hit) => ({
      symbolId: hit.symbolId,
      reason: `In blast radius of changed code; add coverage to ${hit.name}`,
      priority: "medium",
    })),
    riskScore,
  };
  return okEnvelope({ action: "review.analyze", versionId, data });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: PrRiskParams,
 *   ledger?: Ledger,
 * }} args
 * @returns {import("../contracts/tool-results.js").ToolResultEnvelope<PrRiskData>}
 */
export function prRisk({ view, versionId, params, ledger }) {
  const delta = deltaGet({
    view,
    versionId,
    ledger,
    params: {
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      maxCards: params.maxCards,
      maxTokens: params.maxTokens,
    },
  });
  const risk = prRiskAnalyze({
    view,
    versionId,
    ledger,
    params: {
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      riskThreshold: params.riskThreshold,
    },
  });
  if (!delta.ok) {
    const err = /** @type {any} */ (delta).error;
    return errorEnvelope({ ...err, action: "review.risk", versionId });
  }
  if (!risk.ok) {
    const err = /** @type {any} */ (risk).error;
    return errorEnvelope({ ...err, action: "review.risk", versionId });
  }
  /** @type {PrRiskData} */
  const data = {
    delta: /** @type {any} */ (delta.data),
    risk: /** @type {any} */ (risk.data),
  };
  return okEnvelope({ action: "review.risk", versionId, data });
}

// ---------------------------------------------------------------------------
// Ledger-backed delta computation.
// ---------------------------------------------------------------------------

/**
 * Diff two path snapshots and turn each changed path into a set of
 * symbol-level DeltaCards by comparing blob_symbols on each side.
 *
 * @param {{
 *   ledger: Ledger,
 *   from: { branch: string, seq: number },
 *   to: { branch: string, seq: number },
 *   maxCards: number,
 * }} args
 * @returns {{ cards: DeltaCard[], summary: DeltaData["summary"] }}
 */
function computeLedgerDelta({ ledger, from, to, maxCards }) {
  const fromMap = ledger.pathSnapshotAt(from.branch, from.seq);
  const toMap = ledger.pathSnapshotAt(to.branch, to.seq);
  /** @type {DeltaCard[]} */
  const cards = [];
  /** @type {Set<string>} */
  const touched = new Set();
  let added = 0;
  let removed = 0;
  let modified = 0;

  /** @type {Set<string>} */
  const paths = new Set([...fromMap.keys(), ...toMap.keys()]);
  for (const path of paths) {
    const beforeHash = fromMap.get(path) || null;
    const afterHash = toMap.get(path) || null;
    if (beforeHash === afterHash) continue;
    touched.add(path);
    const beforeSymbols = beforeHash ? ledger.getBlobSymbols(beforeHash) : [];
    const afterSymbols = afterHash ? ledger.getBlobSymbols(afterHash) : [];
    /** @type {Map<string, SymbolRow>} */
    const beforeByName = new Map();
    for (const s of beforeSymbols) beforeByName.set(symbolKey(s), s);
    /** @type {Map<string, SymbolRow>} */
    const afterByName = new Map();
    for (const s of afterSymbols) afterByName.set(symbolKey(s), s);

    for (const [key, before] of beforeByName) {
      const after = afterByName.get(key);
      if (!after) {
        removed++;
        if (cards.length < maxCards * 2) {
          cards.push({
            symbolId: `${before.content_hash}:${before.local_id}`,
            change: "removed",
            before: ledgerSymbolToCard(before, path),
          });
        }
      } else if (before.signature_hash !== after.signature_hash) {
        modified++;
        if (cards.length < maxCards * 2) {
          cards.push({
            symbolId: `${after.content_hash}:${after.local_id}`,
            change: "modified",
            before: ledgerSymbolToCard(before, path),
            after: ledgerSymbolToCard(after, path),
          });
        }
      }
    }
    for (const [key, after] of afterByName) {
      if (beforeByName.has(key)) continue;
      added++;
      if (cards.length < maxCards * 2) {
        cards.push({
          symbolId: `${after.content_hash}:${after.local_id}`,
          change: "added",
          after: ledgerSymbolToCard(after, path),
        });
      }
    }
  }

  return {
    cards,
    summary: {
      added,
      removed,
      modified,
      moved: 0,
      touchedPaths: Array.from(touched).sort(),
    },
  };
}

/**
 * Key used to pair before/after rows. Prefer qualified_name when present
 * since it survives `local_id` renumbering inside a file.
 *
 * @param {SymbolRow} sym
 * @returns {string}
 */
function symbolKey(sym) {
  return `${sym.kind}|${sym.qualified_name || sym.name}`;
}

/**
 * Hydrate a Ledger-side SymbolRow into a SymbolCard. Thin wrapper over
 * `bareSymbolCard({ path })` because Ledger blob rows don't carry a
 * repo path — the caller passes it via the path-snapshot map.
 *
 * @param {SymbolRow} sym
 * @param {string} repo_rel_path
 * @returns {SymbolCard}
 */
function ledgerSymbolToCard(sym, repo_rel_path) {
  return bareSymbolCard({ symbol: sym, detail: "compact", path: repo_rel_path });
}

/**
 * Hydrate a ViewSymbol into a minimal SymbolCard (no callers/callees).
 * View symbols carry their own path, so no override is required.
 *
 * @param {ViewSymbol} sym
 * @returns {SymbolCard}
 */
function viewSymbolToCard(sym) {
  return bareSymbolCard({ symbol: sym, detail: "minimal" });
}

/**
 * Parse a versionId of the form "<branch>@<seq>", "<seq>", or a numeric
 * string. Returns null when the input doesn't look like a version anchor.
 *
 * `defaultBranch` is used when the versionId is a bare sequence number.
 * Callers operating on a non-main branch (e.g. a WI worktree) MUST pass
 * their own branch — otherwise a bare-integer fromVersion silently reads
 * the main branch's path snapshot, which is the wrong diff.
 *
 * @param {string} versionId
 * @param {string} [defaultBranch="main"]
 * @returns {{ branch: string, seq: number } | null}
 */
function parseVersionId(versionId, defaultBranch = "main") {
  if (!versionId) return null;
  const at = versionId.indexOf("@");
  if (at > 0) {
    const branch = versionId.slice(0, at);
    const seqStr = versionId.slice(at + 1);
    const seq = Number(seqStr);
    if (!Number.isInteger(seq) || seq < 0) return null;
    return { branch, seq };
  }
  const n = Number(versionId);
  if (!Number.isNaN(n) && Number.isInteger(n) && n >= 0) {
    return { branch: defaultBranch, seq: n };
  }
  return null;
}

/**
 * @param {string} severity
 * @returns {number}
 */
function severityToScore(severity) {
  switch (severity) {
    case "critical":
      return 95;
    case "high":
      return 75;
    case "medium":
      return 50;
    case "low":
      return 25;
    default:
      return 5;
  }
}

/**
 * @param {ViewSymbol} sym
 * @returns {boolean}
 */
function isPublicEntryPointSymbol(sym) {
  if (sym.visibility !== "public") return false;
  const normalized = String(sym.repo_rel_path || "").replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() || "";
  if (/^(index|main|app|server|cli|routes?)\.[a-z0-9]+$/.test(base)) return true;
  return normalized.startsWith("bin/") || normalized.includes("/bin/");
}

/**
 * @param {View} view
 * @returns {ViewSymbol[]}
 */
function collectAllSymbolsInView(view) {
  return view.query.allSymbols({ limit: 10000 });
}
