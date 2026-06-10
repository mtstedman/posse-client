import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildAtlasNativeMethodRequest,
  runAtlasNativeMethod,
  runAtlasNativeOperation,
} from "../lib/domains/atlas/functions/v2/native/invoke.js";
import {
  assertAtlasNativeOperationParity,
  diffAtlasNativeOperationParity,
} from "../lib/domains/atlas/functions/v2/native/parity.js";
import {
  sha256Hex,
  isContentHash,
} from "../lib/domains/atlas/functions/v2/hash.js";
import {
  normalizeRepoPath,
  isCanonicalRepoPath,
  repoRelativeFromAbsolute,
} from "../lib/domains/atlas/functions/v2/paths.js";
import {
  symbolIdOf,
  parseSymbolId,
  locationOf,
  etagOf,
  symbolHit,
  bareSymbolCard,
} from "../lib/domains/atlas/functions/v2/retrieval/cards.js";
import { tokenizeForRanking } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/tokens.js";
import { planQuery } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/query-planner.js";
import { lexicalScore, rankSymbols } from "../lib/domains/atlas/functions/v2/retrieval/rank.js";
import { rrfFuse } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/rrf.js";
import {
  okEnvelope,
  errorEnvelope,
  notModifiedEnvelope,
} from "../lib/domains/atlas/functions/v2/retrieval/envelope.js";
import { redactSecrets } from "../lib/domains/atlas/functions/v2/retrieval/redaction.js";
import {
  extractBodyIdentifiers,
} from "../lib/domains/atlas/functions/v2/parser/body-identifiers.js";
import {
  isLikelyMinifiedPath,
  inspectSampleForMinified,
  isOversizedForParsing,
  MINIFIED_SAMPLE_BYTES,
} from "../lib/domains/atlas/functions/v2/parser/index-filters.js";
import {
  buildAtlasCapabilities,
  buildCapabilityFlags,
} from "../lib/domains/atlas/functions/v2/capabilities.js";
import {
  atlasResultData,
  atlasResultFieldPath,
  atlasResultField,
  atlasSymbolCardField,
  atlasValueAtPath,
} from "../lib/domains/atlas/functions/v2/contracts/tool-results.js";

const HASH = sha256Hex("atlas-native-parity");
const OTHER_HASH = sha256Hex("atlas-native-other");
const SYMBOL_ID = `${HASH}:7`;
const OTHER_SYMBOL_ID = `${OTHER_HASH}:8`;
const REPO_ROOT = path.resolve("C:/repo/project");
const ABS_PATH = path.join(REPO_ROOT, "src", "app.ts");

const SYMBOL = Object.freeze({
  content_hash: HASH,
  local_id: 7,
  global_id: 77,
  repo_rel_path: "src/app.ts",
  kind: "function",
  lang: "ts",
  name: "getUser",
  qualified_name: "api.getUser",
  visibility: "public",
  signature_hash: sha256Hex("getUser(signature)"),
  signature_text: "export function getUser(id: string)",
  doc: "Fetch a user by id.",
  body_identifiers: "getUser user id",
  range_start: 10,
  range_end: 42,
  range_start_line: 3,
  range_end_line: 5,
});

const RANK_SYMBOLS = Object.freeze([
  SYMBOL,
  {
    ...SYMBOL,
    content_hash: OTHER_HASH,
    local_id: 8,
    global_id: 78,
    name: "setAccount",
    qualified_name: "api.setAccount",
    body_identifiers: "set account",
  },
]);

function fakeAtlasManager(json, capture = {}) {
  return {
    shouldUse(name) {
      capture.shouldUse = name;
      return true;
    },
    binary(name) {
      capture.binary = name;
      return {
        runSync(command, args, opts) {
          capture.command = command;
          capture.args = args;
          capture.input = opts.input;
          capture.key = opts.key;
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

function opCase(name, operation, nodeResult, nativeResult = nodeResult) {
  return { name, operation, nodeResult, nativeResult };
}

describe("ATLAS native parity", () => {
  it("builds the native method envelope", () => {
    assert.deepEqual(buildAtlasNativeMethodRequest("op", { op: "tokenize", input: "getUser" }), {
      protocol: "posse.atlas.native.v1",
      method: "op",
      payload: { op: "tokenize", input: "getUser" },
    });
  });

  it("invokes posse-atlas with a stdin JSON method envelope and explicit auth config", () => {
    const capture = {};
    const auth = {
      heartbeatUrl: "https://auth.example.invalid/native/heartbeat",
      heartbeatJwtPublicKey: "public-key-redacted",
    };
    const manager = fakeAtlasManager({ ok: true, data: ["user"] }, capture);
    const result = runAtlasNativeMethod(
      "op",
      { op: "tokenize", input: "getUser" },
      { manager, key: "test-key", auth },
    );

    assert.deepEqual(result, ["user"]);
    assert.equal(capture.shouldUse, "atlas");
    assert.equal(capture.binary, "atlas");
    assert.equal(capture.command, "op");
    assert.deepEqual(capture.args, []);
    assert.equal(capture.key, "test-key");
    const envelope = JSON.parse(String(capture.input));
    assert.equal(envelope.protocol, "posse.atlas.native.v1");
    assert.equal(envelope.method, "op");
    assert.deepEqual(envelope.payload, { op: "tokenize", input: "getUser" });
    assert.deepEqual(envelope.auth, auth);
  });

  it("reports exact A/B parity and mismatches for Operation calls", () => {
    const matching = diffAtlasNativeOperationParity({
      operation: { op: "normalize_repo_path", value: "./src\\app.ts/" },
      nodeResult: "src/app.ts",
      manager: fakeAtlasManager({ ok: true, data: "src/app.ts" }),
    });
    assert.equal(matching.ok, true);

    const drifted = diffAtlasNativeOperationParity({
      operation: { op: "normalize_repo_path", value: "./src\\app.ts/" },
      nodeResult: "src/app.ts",
      manager: fakeAtlasManager({ ok: true, data: "wrong/path.ts" }),
    });
    assert.equal(drifted.ok, false);
    assert.match(drifted.message, /does not match/);
    assert.throws(
      () => assertAtlasNativeOperationParity(
        { op: "normalize_repo_path", value: "./src\\app.ts/" },
        "src/app.ts",
        { manager: fakeAtlasManager({ ok: true, data: "wrong/path.ts" }) },
      ),
      /does not match/,
    );
  });

  it("A/B sweeps deterministic Atlas helper contracts through Rust operations", () => {
    const ok = okEnvelope({
      action: "symbol.search",
      versionId: "v1",
      data: { results: [{ symbolId: SYMBOL_ID, score: 1 }] },
      meta: { etag: "etag-1" },
    });
    const card = bareSymbolCard({ symbol: SYMBOL, detail: "compact" });
    const rankedLists = {
      fts: [
        { id: SYMBOL_ID, rank: 1, payload: { name: "getUser" } },
        { id: `${OTHER_HASH}:8`, rank: 2, payload: { name: "setAccount" } },
      ],
      vector: [
        { id: `${OTHER_HASH}:8`, rank: 1, payload: { name: "setAccount" } },
        { id: SYMBOL_ID, rank: 2, payload: { name: "getUser" } },
      ],
    };

    const cases = [
      opCase("hash.sha256Hex", { op: "sha256_hex", input: "atlas" }, sha256Hex("atlas")),
      opCase("hash.isContentHash", { op: "is_content_hash", value: HASH }, isContentHash(HASH)),
      opCase("paths.normalizeRepoPath", { op: "normalize_repo_path", value: "./src\\app.ts/" }, normalizeRepoPath("./src\\app.ts/")),
      opCase("paths.isCanonicalRepoPath", { op: "is_canonical_repo_path", value: "src/app.ts" }, isCanonicalRepoPath("src/app.ts")),
      opCase("paths.repoRelativeFromAbsolute", { op: "repo_relative_from_absolute", abs_path: ABS_PATH, repo_root: REPO_ROOT }, repoRelativeFromAbsolute(ABS_PATH, REPO_ROOT)),
      opCase("symbol.isAtlasSymbolId", { op: "is_atlas_symbol_id", value: SYMBOL_ID }, true),
      opCase("symbol.parseAtlasSymbolId", { op: "parse_symbol_id", id: SYMBOL_ID }, { content_hash: HASH, local_id: 7 }),
      opCase(
        "symbol.atlasSymbolIdError",
        { op: "atlas_symbol_id_error", field_name: "target" },
        "ATLAS target must be an opaque symbolId returned by ATLAS (<64-hex-content-hash>:<local_id>). Do not use file paths or symbol names; call symbol.search first, or use symbolRef/file when the tool supports it.",
      ),
      opCase("symbol.requireAtlasSymbolId", { op: "require_atlas_symbol_id", value: ` ${SYMBOL_ID} ` }, SYMBOL_ID),
      opCase("symbol.optionalAtlasSymbolId", { op: "optional_atlas_symbol_id", value: "" }, null),
      opCase(
        "symbol.sanitizeAtlasSymbolIdList",
        { op: "sanitize_atlas_symbol_id_list", values: [SYMBOL_ID, SYMBOL_ID, OTHER_SYMBOL_ID], max_items: 30 },
        [SYMBOL_ID, OTHER_SYMBOL_ID],
      ),
      opCase("cards.symbolIdOf", { op: "symbol_id_of", content_hash: HASH, local_id: 7 }, symbolIdOf(SYMBOL)),
      opCase("cards.parseSymbolId", { op: "parse_symbol_id", id: SYMBOL_ID }, parseSymbolId(SYMBOL_ID)),
      opCase("cards.locationOf", { op: "symbol_location", symbol: SYMBOL }, locationOf(SYMBOL)),
      opCase("cards.etagOf", { op: "symbol_etag", symbol: SYMBOL }, etagOf(SYMBOL)),
      opCase("cards.symbolHit", { op: "symbol_hit", symbol: SYMBOL }, symbolHit(SYMBOL)),
      opCase("cards.bareSymbolCard", { op: "bare_symbol_card", symbol: SYMBOL, detail: "compact" }, card),
      opCase("tokens.tokenizeForRanking", { op: "tokenize", input: "fix getUserById path" }, tokenizeForRanking("fix getUserById path")),
      opCase("query.planQuery", { op: "plan_query", input: "TypeError in src/app.ts getUserById" }, planQuery("TypeError in src/app.ts getUserById")),
      opCase("rank.lexicalScore", { op: "lexical_score", query: "getUser", symbol: SYMBOL }, lexicalScore("getUser", SYMBOL)),
      opCase("rank.rankSymbols", { op: "rank_symbols", query: "get user", symbols: RANK_SYMBOLS }, rankSymbols("get user", RANK_SYMBOLS)),
      opCase("rrf.rrfFuse", { op: "rrf_fuse", lists_by_backend: rankedLists, k: 60 }, rrfFuse(rankedLists, { k: 60 })),
      opCase("envelope.okEnvelope", { op: "ok_envelope", input: { action: "symbol.search", versionId: "v1", data: { results: [] } } }, okEnvelope({ action: "symbol.search", versionId: "v1", data: { results: [] } })),
      opCase("envelope.errorEnvelope", { op: "error_envelope", input: { action: "symbol.search", versionId: "v1", code: "bad_query", message: "Bad query" } }, errorEnvelope({ action: "symbol.search", versionId: "v1", code: "bad_query", message: "Bad query" })),
      opCase("envelope.notModifiedEnvelope", { op: "not_modified_envelope", input: { action: "symbol.search", versionId: "v1", etag: "etag-1" } }, notModifiedEnvelope({ action: "symbol.search", versionId: "v1", etag: "etag-1" })),
      opCase("redaction.redactSecrets", { op: "redact_secrets", value: "api_key = sk-abcdefghijklmnopqrstuvwxyz" }, redactSecrets("api_key = sk-abcdefghijklmnopqrstuvwxyz")),
      opCase("parser.extractBodyIdentifiers", { op: "body_identifiers", request: { source: "function getUserById() { return user_id; }", start: 0, end: 44 } }, extractBodyIdentifiers("function getUserById() { return user_id; }", 0, 44)),
      opCase("parser.isLikelyMinifiedPath", { op: "is_likely_minified_path", repo_rel_path: "dist/app.min.js" }, isLikelyMinifiedPath("dist/app.min.js")),
      opCase("parser.inspectSampleForMinified", { op: "inspect_sample_for_minified", sample: "x".repeat(1200) }, inspectSampleForMinified("x".repeat(1200))),
      opCase("parser.isOversizedForParsing", { op: "is_oversized_for_parsing", byte_size: 20 * 1024 * 1024 }, isOversizedForParsing(20 * 1024 * 1024)),
      opCase("parser.minifiedSampleBytes", { op: "minified_sample_bytes" }, MINIFIED_SAMPLE_BYTES),
      opCase("capabilities.buildCapabilityFlags", { op: "build_capability_flags", config: { atlasLocalOnnxEmbeddings: "on" } }, buildCapabilityFlags({ atlasLocalOnnxEmbeddings: "on" })),
      opCase("capabilities.buildAtlasCapabilities", { op: "build_atlas_capabilities", request: { config: { atlasLocalOnnxEmbeddings: "on" }, policy: { runtimeEnabled: true }, embeddingStatus: { enabled: false, reason: "disabled" } } }, buildAtlasCapabilities({ config: { atlasLocalOnnxEmbeddings: "on" }, policy: { runtimeEnabled: true }, embeddingStatus: { enabled: false, reason: "disabled" } })),
      opCase("toolResults.atlasResultData", { op: "atlas_result_data", action: "symbol.search", result: ok }, atlasResultData("symbol.search", ok)),
      opCase("toolResults.atlasResultFieldPath", { op: "atlas_result_field_path", action: "symbol.search", field: "results" }, atlasResultFieldPath("symbol.search", "results")),
      opCase("toolResults.atlasResultField", { op: "atlas_result_field", action: "symbol.search", result: ok, field: "results" }, atlasResultField("symbol.search", ok, "results")),
      opCase("toolResults.atlasSymbolCardField", { op: "atlas_symbol_card_field", card, field: "symbolId" }, atlasSymbolCardField(card, "symbolId")),
      opCase("toolResults.atlasValueAtPath", { op: "atlas_value_at_path", value: ok, field_path: "meta.etag" }, atlasValueAtPath(ok, "meta.etag")),
    ];

    const capture = { calls: [] };
    const manager = {
      shouldUse(name) {
        capture.shouldUse = name;
        return true;
      },
      binary(name) {
        capture.binary = name;
        return {
          runSync(command, args, opts) {
            const envelope = JSON.parse(String(opts.input));
            const match = cases.find((entry) => entry.operation.op === envelope.payload.op && JSON.stringify(entry.operation) === JSON.stringify(envelope.payload));
            assert.ok(match, `missing parity case for ${JSON.stringify(envelope.payload)}`);
            capture.calls.push({ command, operation: envelope.payload });
            const json = { ok: true, data: match.nativeResult };
            return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
          },
        };
      },
    };

    for (const entry of cases) {
      const result = assertAtlasNativeOperationParity(entry.operation, entry.nodeResult, { manager });
      assert.deepEqual(result, entry.nativeResult, entry.name);
    }
    assert.equal(capture.shouldUse, "atlas");
    assert.equal(capture.binary, "atlas");
    assert.equal(capture.calls.length, cases.length);
    assert.deepEqual([...new Set(capture.calls.map((call) => call.command))], ["op"]);
  });

  it("runAtlasNativeOperation delegates through the op method", () => {
    const capture = {};
    const manager = fakeAtlasManager({ ok: true, data: ["user"] }, capture);
    const result = runAtlasNativeOperation({ op: "tokenize", input: "getUser" }, { manager });

    assert.deepEqual(result, ["user"]);
    assert.equal(capture.command, "op");
    const envelope = JSON.parse(String(capture.input));
    assert.deepEqual(envelope.payload, { op: "tokenize", input: "getUser" });
  });
});
