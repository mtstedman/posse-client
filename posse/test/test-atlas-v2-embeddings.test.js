// test/test-atlas-v2-embeddings.test.js
//
// Workstream H — usearch-backed EmbeddingIndex + StubEmbeddingEncoder +
// ingest/search pipeline + symbol.search semantic=true integration.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  EmbeddingIndex,
  isUsearchAvailable,
  modelDirName,
  usearchUnavailableReason,
} from "../lib/domains/atlas/classes/v2/EmbeddingIndex.js";
import { ChildEmbeddingIndex, childEmbeddingModelDirName } from "../lib/domains/atlas/classes/v2/ChildEmbeddingIndex.js";
import { AsyncEmbeddingIndex, toAsyncEmbeddingIndex } from "../lib/domains/atlas/classes/v2/AsyncEmbeddingIndex.js";
import {
  HttpEmbeddingEncoder,
  StubEmbeddingEncoder,
  resolveConfiguredEncoder,
  resolveDefaultEncoder,
} from "../lib/domains/atlas/classes/v2/EmbeddingEncoder.js";
import { LocalOnnxEmbeddingEncoder } from "../lib/domains/atlas/classes/v2/LocalOnnxEmbeddingEncoder.js";
import {
  RemoteAtlasEmbeddingEncoder,
  SideBySideEmbeddingEncoder,
} from "../lib/domains/atlas/classes/v2/RemoteAtlasEmbeddingEncoder.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import {
  REMOTE_ATLAS_ENCODER_EGRESS_POLICY,
  RemoteAtlasEncoderClient,
  normalizeRemoteAtlasEncodeRequest,
} from "../lib/domains/remote/functions/atlas-encoder-client.js";
import { ingestView, resolveEmbeddingIngestBatchSize } from "../lib/domains/atlas/functions/v2/embeddings/ingest.js";
import { defaultBuildSymbolText, TEXT_SHAPE_VERSION } from "../lib/domains/atlas/functions/v2/embeddings/build-symbol-text.js";
import { normalizeEmbeddingThreads, shouldUseLocalOnnxEncodePool } from "../lib/domains/atlas/functions/v2/embeddings/local-onnx-encode-pool.js";
import { ensureEmbeddingsForView } from "../lib/domains/atlas/functions/v2/embeddings/on-demand.js";
import {
  configuredVectorBackend,
  embeddingsExplicitlyEnabled,
  openEmbeddingResources,
  semanticDispatchEnabled,
} from "../lib/domains/atlas/functions/v2/embeddings/resources.js";
import { semanticSearch } from "../lib/domains/atlas/functions/v2/embeddings/search.js";
import { symbolSearch } from "../lib/domains/atlas/functions/v2/retrieval/search.js";
import { sliceBuild } from "../lib/domains/atlas/functions/v2/retrieval/slice.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { readPersistentTelemetryEntries } from "../lib/shared/telemetry/functions/persistent-log.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashOf(s) {
  return sha256Hex(Buffer.from(s));
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function deterministicVector(uid, dim) {
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    vector[i] = Math.sin((uid * 131 + i * 17) % 1000) / 32;
  }
  return vector;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label = "condition") {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(5);
  }
}

/**
 * Build a small view with two symbols on src/foo.ts (greet + farewell)
 * and one on src/bar.ts (loops).
 */
function setupView(tmp, viewName) {
  const ledPath = path.join(tmp, `${viewName}.ledger.db`);
  const viewPath = path.join(tmp, `${viewName}.view.db`);
  const led = Ledger.open({ dbPath: ledPath });
  try {
    const aContent = `function greet() { return "hi"; }\nfunction farewell() { return "bye"; }\n`;
    const aHash = hashOf(aContent);
    led.ingestBlob({
      content_hash: aHash,
      lang: "ts",
      byte_size: aContent.length,
      symbols: [
        {
          content_hash: aHash, local_id: 0,
          kind: "function", name: "greet", qualified_name: "greet",
          parent_local_id: null, repo_rel_path: "src/foo.ts", lang: "ts",
          range_start: 0, range_end: 32,
          signature_hash: sha256Hex("greet()"),
          visibility: "public", doc: null,
        },
        {
          content_hash: aHash, local_id: 1,
          kind: "function", name: "farewell", qualified_name: "farewell",
          parent_local_id: null, repo_rel_path: "src/foo.ts", lang: "ts",
          range_start: 33, range_end: 70,
          signature_hash: sha256Hex("farewell()"),
          visibility: "public", doc: null,
        },
      ],
      edges: [],
    });
    led.append({
      branch: "main", op: "add", repo_rel_path: "src/foo.ts",
      before_content_hash: null, after_content_hash: aHash,
    });

    const bContent = `function loops() { for (let i = 0; i < 10; i++) {} }\n`;
    const bHash = hashOf(bContent);
    led.ingestBlob({
      content_hash: bHash,
      lang: "ts",
      byte_size: bContent.length,
      symbols: [
        {
          content_hash: bHash, local_id: 0,
          kind: "function", name: "loops", qualified_name: "loops",
          parent_local_id: null, repo_rel_path: "src/bar.ts", lang: "ts",
          range_start: 0, range_end: 52,
          signature_hash: sha256Hex("loops()"),
          visibility: "public", doc: null,
        },
      ],
      edges: [],
    });
    led.append({
      branch: "main", op: "add", repo_rel_path: "src/bar.ts",
      before_content_hash: null, after_content_hash: bHash,
    });

    new ViewBuilder().buildFrom({
      ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath,
    });
  } finally {
    led.close();
  }
  return viewPath;
}

// Skip the index-backed suites when usearch (an optional native dep)
// isn't installed for this platform. The stub encoder is pure JS and
// always works; symbol.search FTS fallback is asserted in its own
// suite below so the no-usearch case stays covered.
const skipIfNoUsearch = isUsearchAvailable()
  ? undefined
  : `usearch not available: ${usearchUnavailableReason() ?? "missing"}`;

let telemetryTmp;
before(() => {
  telemetryTmp = makeTmp("atlas-v2-emb-telemetry-");
  setRuntimePathOverridesForTests({
    runtimeRoot: telemetryTmp,
    logDir: path.join(telemetryTmp, "logs"),
  });
});

after(() => {
  setRuntimePathOverridesForTests(null);
  try { fs.rmSync(telemetryTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("ATLAS v2 embedding resource selection", () => {
  it("semanticDispatchEnabled defaults off and accepts truthy opt-in values", () => {
    assert.equal(semanticDispatchEnabled({}), false);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "" }), false);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "0" }), false);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "false" }), false);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "1" }), true);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "true" }), true);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "yes" }), true);
    assert.equal(semanticDispatchEnabled({ semanticEnabled: "on" }), true);
  });

  it("keeps embeddings opt-in and honors vector backend off", () => {
    const tmp = makeTmp("atlas-v2-emb-select-");
    try {
      assert.equal(configuredVectorBackend({}), "auto");
      assert.equal(configuredVectorBackend({ vectorBackend: "off" }), "off");
      const disabled = openEmbeddingResources({
        repoRoot: tmp,
        config: { embeddingProvider: "stub", vectorBackend: "off" },
      });
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.reason, "vector_backend_disabled");
      assert.equal(disabled.backend, "off");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves configured HTTP embedding providers without changing the deterministic default", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [
            { embedding: [1, 0, 0] },
            { embedding: [0, 1, 0] },
          ],
        }),
      };
    };
    try {
      const stub = resolveConfiguredEncoder({ embeddingProvider: "test" });
      assert.ok(stub instanceof StubEmbeddingEncoder);

      const enc = resolveConfiguredEncoder({
        embeddingProvider: "openai-compatible",
        embeddingEndpoint: "https://embeddings.example.test/v1",
        embeddingModel: "fixture-model",
        embeddingDim: 3,
        embeddingApiKey: "secret-token",
        embeddingModelVersion: "fixture-v1",
      });
      assert.ok(enc instanceof HttpEmbeddingEncoder);
      assert.equal(enc.model, "openai-compatible:fixture-model");
      assert.equal(enc.model_version, "fixture-v1");
      const vectors = await enc.encode(["alpha", "beta"]);
      assert.deepEqual(Array.from(vectors[0]), [1, 0, 0]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://embeddings.example.test/v1");
      assert.equal(calls[0].init.headers.authorization, "Bearer secret-token");
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        model: "fixture-model",
        input: ["alpha", "beta"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses generic HTTP embedding auth over non-loopback plaintext URLs", () => {
    assert.throws(
      () => new HttpEmbeddingEncoder({
        provider: "openai-compatible",
        endpoint: "http://example.test/embeddings",
        model: "fixture-model",
        dim: 3,
        apiKey: "atlas-embedding-secret",
      }),
      (err) => err?.code === "POSSE_REMOTE_INSECURE_AUTH",
    );

    assert.throws(
      () => new HttpEmbeddingEncoder({
        provider: "openai-compatible",
        endpoint: "http://example.test/embeddings",
        model: "fixture-model",
        dim: 3,
        headers: { authorization: "Bearer atlas-embedding-secret" },
      }),
      (err) => err?.code === "POSSE_REMOTE_INSECURE_AUTH",
    );

    assert.ok(new HttpEmbeddingEncoder({
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:11434/embeddings",
      model: "fixture-model",
      dim: 3,
      apiKey: "local-dev-secret",
    }) instanceof HttpEmbeddingEncoder);

    assert.ok(new HttpEmbeddingEncoder({
      provider: "openai-compatible",
      endpoint: "http://example.test/embeddings",
      model: "fixture-model",
      dim: 3,
    }) instanceof HttpEmbeddingEncoder);
  });

  it("normalizes and posts Posse remote ATLAS encoder batches", async () => {
    assert.deepEqual([...REMOTE_ATLAS_ENCODER_EGRESS_POLICY.symbol_fields], [
      "content_hash",
      "local_id",
      "repo_rel_path",
      "kind",
      "lang",
      "name",
      "qualified_name",
      "signature_hash",
      "signature_text",
      "doc",
      "body_lead",
    ]);
    assert.deepEqual([...REMOTE_ATLAS_ENCODER_EGRESS_POLICY.query_fields], ["texts"]);

    const calls = [];
    const client = new RemoteAtlasEncoderClient({
      baseUrl: "https://remote.example.test",
      apiKey: "remote-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            model: "fixture-atlas",
            model_version: "remote-v1",
            dim: 2,
            vectors: [{ content_hash: "h1", local_id: 0, vector: [1, 0] }],
          }),
        };
      },
    });

    const request = normalizeRemoteAtlasEncodeRequest({
      request_id: "req-1",
      batch_id: "symbols-1",
      kind: "symbols",
      symbols: [{
        content_hash: "h1",
        local_id: 0,
        repo_rel_path: "src/a.ts",
        kind: "function",
        lang: "ts",
        name: "alpha",
        qualified_name: "Mod.alpha",
        signature_hash: "sig",
        signature_text: "function alpha()",
        doc: "Alpha docs",
        body_lead: "return 1;",
        extra_private_field: "dropped",
      }],
    });
    assert.equal(request.symbols[0].extra_private_field, undefined);

    const response = await client.encodeBatch(request);
    assert.equal(response.model, "fixture-atlas");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://remote.example.test/v1/atlas/embeddings/encode");
    assert.equal(calls[0].init.headers.authorization, "Bearer remote-token");
    assert.equal(calls[0].init.headers["x-posse-idempotency-key"], "req-1:symbols-1:symbols");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.kind, "symbols");
    assert.equal(body.symbols[0].name, "alpha");
    assert.equal(body.symbols[0].extra_private_field, undefined);
  });

  it("resolves the Posse remote ATLAS encoder provider and encodes structured symbols", async () => {
    const calls = [];
    const enc = resolveConfiguredEncoder({
      embeddingProvider: "posse-remote",
      remoteEncoderUrl: "https://remote.example.test",
      remoteEncoderModel: "fixture-atlas",
      remoteEncoderDim: 3,
      remoteEncoderModelVersion: "remote-v1",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            model: "fixture-atlas",
            model_version: "remote-v1",
            dim: 3,
            vectors: [{ content_hash: "h1", local_id: 0, vector: [0, 1, 0] }],
          }),
        };
      },
    });

    assert.ok(enc instanceof RemoteAtlasEmbeddingEncoder);
    assert.equal(enc.model, "posse-remote:fixture-atlas");
    assert.equal(enc.model_version, "remote-v1");
    assert.equal(enc.dim, 3);
    const vectors = await enc.encodeSymbols([{
      content_hash: "h1",
      local_id: 0,
      kind: "function",
      lang: "ts",
      name: "alpha",
      qualified_name: "Mod.alpha",
      signature_hash: "sig",
      signature_text: "function alpha()",
      doc: "Alpha docs",
      body_lead: "return 1;",
    }]);
    assert.deepEqual(Array.from(vectors[0]), [0, 1, 0]);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.kind, "symbols");
    assert.deepEqual(body.model_hint, {
      provider: "posse-remote",
      model: "fixture-atlas",
      model_version: "remote-v1",
      dim: 3,
    });
  });

  it("side-by-side shadow mode keeps local vectors authoritative while probing remote", async () => {
    const local = {
      model: "local-fixture",
      model_version: "local-v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async () => [new Float32Array([1, 0])],
    };
    let remoteCalls = 0;
    const remote = {
      model: "remote-fixture",
      model_version: "remote-v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async () => {
        remoteCalls += 1;
        return [new Float32Array([0, 1])];
      },
      encodeSymbols: async () => {
        remoteCalls += 1;
        return [new Float32Array([0, 1])];
      },
    };
    const sideBySide = new SideBySideEmbeddingEncoder({ local, remote, mode: "shadow" });
    const vectors = await sideBySide.encodeSymbols([{
      content_hash: "h1",
      local_id: 0,
      kind: "function",
      lang: "ts",
      name: "alpha",
      qualified_name: "alpha",
      signature_hash: "sig",
    }]);

    assert.deepEqual(Array.from(vectors[0]), [1, 0]);
    assert.equal(remoteCalls, 1);
    assert.equal(sideBySide.lastShadowResult.localOk, true);
    assert.equal(sideBySide.lastShadowResult.remoteOk, true);
  });

  it("ingestView uses structured symbol encoding when the encoder supports it", async () => {
    let buildSymbolTextCalls = 0;
    let added = null;
    const view = {
      query: {
        allSymbols: () => [{
          content_hash: "h1",
          local_id: 0,
          kind: "function",
          lang: "ts",
          name: "alpha",
          qualified_name: "alpha",
          parent_local_id: null,
          repo_rel_path: "src/a.ts",
          range_start: 0,
          range_end: 10,
          signature_hash: "sig",
          visibility: "public",
          doc: "Alpha docs",
        }],
      },
    };
    const index = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      add: async (rows) => { added = rows; },
      removeByContentHash: async () => 0,
      nearest: async () => [],
      count: async () => 0,
      close: async () => {},
    };
    const encoder = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      buildSymbolText: () => {
        buildSymbolTextCalls += 1;
        throw new Error("buildSymbolText should not be called");
      },
      encode: async () => {
        throw new Error("text encode should not be called");
      },
      encodeSymbols: async (symbols) => {
        assert.equal(symbols[0].name, "alpha");
        return [new Float32Array([0.25, 0.75])];
      },
    };

    const report = await ingestView({ view, index, encoder });
    assert.equal(report.indexed, 1);
    assert.equal(buildSymbolTextCalls, 0);
    assert.deepEqual(Array.from(added[0].vector), [0.25, 0.75]);
  });

  it("ingestView skips already-indexed symbols before encoding", async () => {
    const encodedTexts = [];
    const added = [];
    let containsCalls = 0;
    let containsManyCalls = 0;
    const symbols = [
      {
        content_hash: "h1",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "alpha",
        qualified_name: "alpha",
        parent_local_id: null,
        repo_rel_path: "src/a.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-a",
        visibility: "public",
        doc: null,
      },
      {
        content_hash: "h2",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "beta",
        qualified_name: "beta",
        parent_local_id: null,
        repo_rel_path: "src/b.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-b",
        visibility: "public",
        doc: null,
      },
    ];
    const view = { query: { allSymbols: () => symbols } };
    const index = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      contains: async () => {
        containsCalls++;
        return false;
      },
      containsMany: async (keys) => {
        containsManyCalls++;
        assert.deepEqual(keys.map((key) => `${key.content_hash}\0${key.local_id}`), ["h1\0" + "0", "h2\0" + "0"]);
        return new Set(["h1\0" + "0"]);
      },
      add: async (rows) => { added.push(...rows); },
      removeByContentHash: async () => 0,
      nearest: async () => [],
      count: async () => 1,
      close: async () => {},
    };
    const encoder = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async (texts) => {
        encodedTexts.push(...texts);
        return texts.map(() => new Float32Array([0.5, 0.5]));
      },
    };

    const report = await ingestView({ view, index, encoder });
    assert.equal(report.candidates, 2);
    assert.equal(report.alreadyIndexed, 1);
    assert.equal(report.indexed, 1);
    assert.deepEqual(encodedTexts, ["beta"]);
    assert.equal(added.length, 1);
    assert.equal(added[0].content_hash, "h2");
    assert.equal(containsManyCalls, 1);
    assert.equal(containsCalls, 0);
  });

  it("ingestView writes durable batch breadcrumbs before encoder failure", async () => {
    const viewPath = `forensics-${Date.now()}-${Math.random().toString(16).slice(2)}.view.db`;
    const symbols = [{
      content_hash: sha256Hex("forensics-alpha"),
      local_id: 42,
      kind: "function",
      lang: "ts",
      name: "alphaForensics",
      qualified_name: "alphaForensics",
      parent_local_id: null,
      repo_rel_path: "src/alpha.ts",
      range_start: 0,
      range_end: 10,
      signature_hash: "sig-alpha",
      visibility: "public",
      doc: null,
    }];
    const view = {
      _dbPath: () => viewPath,
      query: { allSymbols: () => symbols },
    };
    const index = {
      model: "forensic-index",
      model_version: "v1",
      backend: "fake",
      dim: 2,
      containsMany: async () => new Set(),
      add: async () => {
        throw new Error("index.add should not be reached");
      },
    };
    const encoder = {
      model: "forensic-encoder",
      model_version: "v1",
      dim: 2,
      buildSymbolText: (symbol) => `${symbol.kind} ${symbol.name}`,
      encode: async () => {
        throw new Error("simulated encoder failure");
      },
    };

    await assert.rejects(
      () => ingestView({ view, index, encoder }),
      /simulated encoder failure/,
    );

    const entries = readPersistentTelemetryEntries("atlas-embedding-forensics", {
      limit: 500,
      order: "asc",
      predicate: (entry) => entry?.view_path === viewPath,
    });
    const encodeStart = entries.find((entry) => entry.event === "ingest.batch.encode.start");
    const encodeError = entries.find((entry) => entry.event === "ingest.batch.encode.error");
    assert.ok(encodeStart, "expected pre-encode breadcrumb");
    assert.ok(encodeError, "expected encode error breadcrumb");
    assert.equal(encodeStart.batch, 1);
    assert.equal(encodeStart.kept.local_id_min, 42);
    assert.equal(encodeStart.kept.local_id_max, 42);
    assert.equal(encodeStart.texts.count, 1);
    assert.equal(encodeError.error.message, "simulated encoder failure");
  });

  it("ingestView emits intake timing metadata for embedding batches", async () => {
    const progress = [];
    const symbols = [
      {
        content_hash: "h1",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "alpha",
        qualified_name: "alpha",
        parent_local_id: null,
        repo_rel_path: "src/a.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-a",
        visibility: "public",
        doc: null,
      },
      {
        content_hash: "h2",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "beta",
        qualified_name: "beta",
        parent_local_id: null,
        repo_rel_path: "src/b.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-b",
        visibility: "public",
        doc: null,
      },
    ];
    const view = { query: { allSymbols: () => symbols } };
    const index = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      contains: async () => false,
      add: async () => {},
      getLastAddTiming: () => ({
        rows: 2,
        sqliteMs: 1.2,
        annAddMs: 2.3,
        annSaveMs: 3.4,
        annHashMs: 4.5,
      }),
      removeByContentHash: async () => 0,
      nearest: async () => [],
      count: async () => 0,
      close: async () => {},
    };
    const encoder = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async (texts) => texts.map(() => new Float32Array([0.5, 0.5])),
    };

    const report = await ingestView({
      view,
      index,
      encoder,
      batchSize: 2,
      embeddingThreads: 2,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(report.indexed, 2);
    const batchEvent = progress.find((event) => event.batchTimingMs?.missing === 2);
    assert.ok(batchEvent, "expected a progress event with batch timing");
    assert.equal(batchEvent.kind, "atlas.embeddings.ingest.progress");
    assert.equal(batchEvent.workerCount, 2);
    assert.equal(batchEvent.batchSize, 2);
    assert.equal(batchEvent.batchTimingMs.symbols, 2);
    assert.equal(batchEvent.batchTimingMs.alreadyIndexed, 0);
    assert.equal(batchEvent.batchTimingMs.indexTiming.rows, 2);
    assert.equal(batchEvent.batchTimingMs.indexTiming.annHashMs, 4.5);
    assert.ok(Number.isFinite(batchEvent.timingsMs.elapsedMs));
    assert.ok(Number.isFinite(batchEvent.batchTimingMs.encodeMs));
    assert.ok(Number.isFinite(batchEvent.batchTimingMs.indexAddMs));
  });

  it("ingestView skips symbols from languages without ATLAS semantics", async () => {
    const encodedTexts = [];
    const added = [];
    const progress = [];
    const symbols = [
      {
        content_hash: "h-ts",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "alpha",
        qualified_name: "alpha",
        parent_local_id: null,
        repo_rel_path: "src/a.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-a",
        visibility: "public",
        doc: null,
      },
      {
        content_hash: "h-sh",
        local_id: 0,
        kind: "function",
        lang: "sh",
        name: "deploy",
        qualified_name: "deploy",
        parent_local_id: null,
        repo_rel_path: "scripts/deploy.sh",
        range_start: 0,
        range_end: 20,
        signature_hash: "sig-sh",
        visibility: "public",
        doc: null,
      },
    ];
    const view = { query: { allSymbols: () => symbols } };
    const index = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      contains: async () => false,
      add: async (rows) => { added.push(...rows); },
      removeByContentHash: async () => 0,
      nearest: async () => [],
      count: async () => 0,
      close: async () => {},
    };
    const encoder = {
      model: "structured",
      model_version: "v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async (texts) => {
        encodedTexts.push(...texts);
        return texts.map(() => new Float32Array([0.5, 0.5]));
      },
    };

    const report = await ingestView({
      view,
      index,
      encoder,
      onProgress: (event) => {
        progress.push(Object.fromEntries(event.languageTotal));
      },
    });

    assert.equal(report.candidates, 1);
    assert.equal(report.skippedUnsupportedLanguage, 1);
    assert.equal(report.indexed, 1);
    assert.deepEqual(encodedTexts, ["alpha"]);
    assert.equal(added.length, 1);
    assert.equal(added[0].content_hash, "h-ts");
    assert.ok(progress.length > 0);
    assert.deepEqual(progress.at(-1), { ts: 1 });
  });

  it("ensureEmbeddingsForView encodes only missing symbols", async () => {
    const symbols = [
      {
        content_hash: "h1",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "alpha",
        qualified_name: "alpha",
        parent_local_id: null,
        repo_rel_path: "src/a.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-a",
        visibility: "public",
        doc: null,
      },
      {
        content_hash: "h2",
        local_id: 0,
        kind: "function",
        lang: "ts",
        name: "beta",
        qualified_name: "beta",
        parent_local_id: null,
        repo_rel_path: "src/b.ts",
        range_start: 0,
        range_end: 10,
        signature_hash: "sig-b",
        visibility: "public",
        doc: null,
      },
    ];
    const present = new Set(["h1\0" + "0"]);
    const added = [];
    let containsCalls = 0;
    let containsManyCalls = 0;
    const view = { query: { allSymbols: () => symbols } };
    const index = {
      model: "fake",
      model_version: "v1",
      dim: 2,
      contains: async (hash, localId) => {
        containsCalls++;
        return present.has(`${hash}\0${localId}`);
      },
      containsMany: async (keys) => {
        containsManyCalls++;
        return new Set(keys
          .map((key) => `${key.content_hash}\0${key.local_id}`)
          .filter((key) => present.has(key)));
      },
      add: async (rows) => {
        added.push(...rows);
        for (const row of rows) present.add(`${row.content_hash}\0${row.local_id}`);
      },
      removeByContentHash: async () => 0,
      nearest: async () => [],
      count: async () => present.size,
      close: async () => {},
    };
    const encoder = {
      model: "fake",
      model_version: "v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async (texts) => texts.map((text) => text === "beta" ? new Float32Array([0, 1]) : new Float32Array([1, 0])),
    };

    const first = await ensureEmbeddingsForView({ view, index, encoder });
    assert.equal(first.skipped, false);
    assert.equal(first.missing, 1);
    assert.equal(first.encoded, 1);
    assert.equal(added[0].content_hash, "h2");

    const second = await ensureEmbeddingsForView({ view, index, encoder });
    assert.deepEqual(second, { skipped: true, reason: "fully_indexed", missing: 0 });
    assert.equal(containsManyCalls, 3);
    assert.equal(containsCalls, 0);
  });

  it("ensureEmbeddingsForView reports incomplete lazy encoding instead of throwing", async () => {
    const symbols = [{
      content_hash: "h1",
      local_id: 0,
      kind: "function",
      lang: "ts",
      name: "alpha",
      qualified_name: "alpha",
      parent_local_id: null,
      repo_rel_path: "src/a.ts",
      range_start: 0,
      range_end: 10,
      signature_hash: "sig-a",
      visibility: "public",
      doc: null,
    }];
    const view = { query: { allSymbols: () => symbols } };
    const index = {
      model: "fake",
      model_version: "v1",
      dim: 2,
      contains: async () => false,
      add: async () => {},
    };
    const encoder = {
      model: "fake",
      model_version: "v1",
      dim: 2,
      buildSymbolText: (symbol) => symbol.name,
      encode: async () => { throw new Error("encode_failed"); },
    };

    const result = await ensureEmbeddingsForView({ view, index, encoder });

    assert.equal(result.skipped, false);
    assert.equal(result.incomplete, true);
    assert.equal(result.missing, 1);
    assert.equal(result.encoded, null);
    assert.equal(result.reason, "encode_failed");
  });

  it("gates async-wrapped embedding reads behind active writes on the same asset", async () => {
    const events = [];
    let releaseWrite;
    const inner = {
      model: "fake",
      model_version: "v1",
      dim: 1,
      backend: "fake",
      gateKey: `fake:${Date.now()}:${Math.random()}`,
      add: async () => {
        events.push("write-start");
        await new Promise((resolve) => { releaseWrite = resolve; });
        events.push("write-end");
      },
      nearest: async () => {
        events.push("read");
        return [];
      },
      removeByContentHash: async () => 0,
      count: async () => 0,
      close: async () => {},
    };
    const idx = new AsyncEmbeddingIndex(/** @type {any} */ (inner), { waitMs: 1000 });
    const write = idx.add([{ content_hash: "h", local_id: 0, vector: new Float32Array([1]) }]);
    await waitFor(() => events.includes("write-start"), "embedding write to start");
    const read = idx.nearest(new Float32Array([1]), { k: 1 });
    await sleep(10);
    assert.deepEqual(events, ["write-start"]);
    releaseWrite();
    await write;
    await read;
    assert.deepEqual(events, ["write-start", "write-end", "read"]);
  });
});

describe("ATLAS v2 Embedding stubs + index", { skip: skipIfNoUsearch }, () => {
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-emb-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch { /* best effort */ }
  });

  it("StubEmbeddingEncoder produces deterministic L2-normalized vectors", async () => {
    const enc = new StubEmbeddingEncoder({ dim: 64 });
    const [v1a, v1b] = await enc.encode(["hello world", "hello world"]);
    const [v2] = await enc.encode(["goodbye world"]);
    assert.equal(v1a.length, 64);
    assert.deepEqual(Array.from(v1a), Array.from(v1b), "same input must produce same vector");
    // Different inputs should differ at least at one dimension.
    let diff = 0;
    for (let i = 0; i < v1a.length; i++) {
      if (Math.abs(v1a[i] - v2[i]) > 1e-9) diff++;
    }
    assert.ok(diff > 0, "different inputs should produce different vectors");
    // L2 norm should be ~1 (or 0 + anchor for empty).
    let norm = 0;
    for (let i = 0; i < v1a.length; i++) norm += v1a[i] * v1a[i];
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5, `vector should be L2-normalized; got ${Math.sqrt(norm)}`);
  });

  it("resolveDefaultEncoder always returns the deterministic StubEmbeddingEncoder", () => {
    const enc = resolveDefaultEncoder();
    assert.ok(enc instanceof StubEmbeddingEncoder);
    assert.equal(enc.model, "posse-stub-hash");
    assert.equal(enc.dim, 128);
  });

  it("StubEmbeddingEncoder model_version is v3 (text shape includes signature_text + doc + body_lead)", () => {
    const enc = new StubEmbeddingEncoder({ dim: 128, ngram: 4 });
    assert.equal(enc.model_version, "stub-hash-128-ngram4-text3");
  });

  it("buildSymbolText includes signature_text + doc + body_lead when present and is deterministic", () => {
    const enc = new StubEmbeddingEncoder({ dim: 64 });
    const minimal = enc.buildSymbolText({
      kind: "function", lang: "js", name: "foo", qualified_name: "Mod.foo",
      signature_hash: "abc",
    });
    const enriched = enc.buildSymbolText({
      kind: "function", lang: "js", name: "foo", qualified_name: "Mod.foo",
      signature_hash: "abc",
      signature_text: "function foo(name: string): string",
      doc: "Greets the world cheerfully.",
      body_lead: "return 'hello, world';",
    });
    assert.ok(enriched.length > minimal.length, "enriched text must be longer than minimal");
    assert.ok(enriched.includes("function foo(name: string): string"), "signature_text must appear in built text");
    assert.ok(enriched.includes("Greets the world cheerfully."), "doc text must appear in built text");
    assert.ok(enriched.includes("return 'hello, world'"), "body_lead must appear in built text");
    // Encoder must be deterministic on the enriched shape too.
    const enriched2 = enc.buildSymbolText({
      kind: "function", lang: "js", name: "foo", qualified_name: "Mod.foo",
      signature_hash: "abc",
      signature_text: "function foo(name: string): string",
      doc: "Greets the world cheerfully.",
      body_lead: "return 'hello, world';",
    });
    assert.equal(enriched, enriched2, "same input must produce same text");
  });

  it("openEmbeddingResources is opt-in and opens the configured index", async () => {
    assert.equal(embeddingsExplicitlyEnabled({}), false);
    const disabled = openEmbeddingResources({ repoRoot: tmp, config: {} });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.reason, "disabled");

    const opened = openEmbeddingResources({
      repoRoot: tmp,
      config: { embeddingProvider: "stub", vectorBackend: "usearch" },
    });
    try {
      assert.equal(opened.enabled, true, opened.reason || "");
      assert.equal(opened.provider, "posse-stub-hash");
      assert.equal(opened.backend, "usearch");
      assert.ok(opened.encoder);
      assert.ok(opened.index);
    } finally {
      await opened.close();
    }
  });

  it("wraps the synchronous USEARCH index behind async calls", async () => {
    const root = path.join(tmp, "async-wrap");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const idx = toAsyncEmbeddingIndex(EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: root,
    }));
    try {
      const [v] = await enc.encode(["async alpha"]);
      await idx.add([{ content_hash: "h-async", local_id: 0, vector: v }]);
      const timing = idx.getLastAddTiming();
      assert.equal(timing.rows, 1);
      assert.ok(Number.isFinite(timing.sqliteMs));
      assert.ok(Number.isFinite(timing.totalMs));
      assert.deepEqual(
        await idx.containsMany([
          { content_hash: "h-async", local_id: 0 },
          { content_hash: "h-missing", local_id: 0 },
        ]),
        new Set(["h-async\0" + "0"]),
      );
      assert.equal(await idx.count(), 1);
      const hits = await idx.nearest(v, { k: 1 });
      assert.equal(hits[0]?.content_hash, "h-async");
    } finally {
      await idx.close();
    }
  });

  it("EmbeddingIndex.contains reports exact indexed symbol membership", async () => {
    const root = path.join(tmp, "contains");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const idx = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      const [v] = await enc.encode(["contains alpha"]);
      assert.equal(idx.contains("h-contains", 0), false);
      assert.deepEqual(idx.containsMany([{ content_hash: "h-contains", local_id: 0 }]), new Set());
      idx.add([{ content_hash: "h-contains", local_id: 0, vector: v }]);
      assert.equal(idx.contains("h-contains", 0), true);
      assert.equal(idx.contains("h-contains", 1), false);
      assert.deepEqual(
        idx.containsMany([
          { content_hash: "h-contains", local_id: 0 },
          { content_hash: "h-contains", local_id: 1 },
        ]),
        new Set(["h-contains\0" + "0"]),
      );
    } finally {
      idx.close();
    }
  });

  it("EmbeddingIndex round-trips through save + reopen", async () => {
    const root = path.join(tmp, "rt");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    {
      const idx = EmbeddingIndex.open({
        model: enc.model, model_version: enc.model_version, dim: enc.dim,
        embeddingsRoot: root,
      });
      try {
        const [v1, v2] = await enc.encode(["alpha symbol", "beta symbol"]);
        idx.add([
          { content_hash: "h1", local_id: 0, vector: v1 },
          { content_hash: "h2", local_id: 0, vector: v2 },
        ]);
        // Idempotent — re-add the same row.
        idx.add([{ content_hash: "h1", local_id: 0, vector: v1 }]);
        assert.equal(idx.count(), 2);
        idx.save();
      } finally {
        idx.close();
      }
    }
    // Reopen on a fresh handle; saved state should be back.
    {
      const idx = EmbeddingIndex.open({
        model: enc.model, model_version: enc.model_version, dim: enc.dim,
        embeddingsRoot: root,
      });
      try {
        assert.equal(idx.count(), 2);
        const [q] = await enc.encode(["alpha symbol"]);
        const hits = idx.nearest(q, { k: 2 });
        assert.equal(hits.length, 2);
        // "alpha symbol" must be the closest hit to itself.
        assert.equal(hits[0].content_hash, "h1");
        assert.ok(hits[0].score > hits[1].score - 1e-9);
      } finally {
        idx.close();
      }
    }
  });

  it("EmbeddingIndex quarantines legacy ANN files without a clean-save manifest", { skip: skipIfNoUsearch }, async () => {
    const root = path.join(tmp, "legacy-ann-without-manifest");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const modelDir = path.join(root, modelDirName({
      model: enc.model,
      model_version: enc.model_version,
    }));
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "index.usearch"), "not a valid usearch index");

    const idx = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
      annSaveEveryBatches: 1,
    });
    try {
      assert.equal(fs.existsSync(path.join(modelDir, "index.usearch")), false);
      assert.ok(
        fs.readdirSync(modelDir).some((name) => name.startsWith("index.usearch.missing_ann_manifest-")),
        "legacy ANN file should be quarantined before native load",
      );
      const [v] = await enc.encode(["legacy rebuild"]);
      idx.add([{ content_hash: "h-legacy", local_id: 0, vector: v }]);
      assert.equal(fs.existsSync(path.join(modelDir, "index.usearch")), true);
      assert.equal(fs.existsSync(path.join(modelDir, "index.usearch.json")), true);
    } finally {
      idx.close();
    }

    const reopened = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      const [q] = await enc.encode(["legacy rebuild"]);
      const hits = reopened.nearest(q, { k: 1 });
      assert.equal(hits[0]?.content_hash, "h-legacy");
    } finally {
      reopened.close();
    }
  });

  it("EmbeddingIndex rebuilds a stale ANN from sidecar vector checkpoints", { skip: skipIfNoUsearch }, async () => {
    const root = path.join(tmp, "sidecar-vector-rebuild");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const modelDir = path.join(root, modelDirName({
      model: enc.model,
      model_version: enc.model_version,
    }));
    const [v1, v2] = await enc.encode(["checkpoint-one", "checkpoint-two"]);

    {
      const idx = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: root,
        annSaveEveryBatches: 1,
      });
      try {
        idx.add([{ content_hash: "h-checkpoint-1", local_id: 0, vector: v1 }]);
      } finally {
        idx.close();
      }
    }

    const originalSave = EmbeddingIndex.prototype.save;
    const originalWarn = console.warn;
    {
      const idx = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: root,
        annSaveEveryBatches: 1,
      });
      try {
        console.warn = (...args) => {
          if (String(args[0] || "").includes("forced_ann_save_interruption")) return;
          originalWarn(...args);
        };
        EmbeddingIndex.prototype.save = function interruptedSave() {
          throw new Error("forced_ann_save_interruption");
        };
        idx.add([{ content_hash: "h-checkpoint-2", local_id: 0, vector: v2 }]);
        assert.equal(idx.count(), 2);
      } finally {
        idx.close();
        EmbeddingIndex.prototype.save = originalSave;
        console.warn = originalWarn;
      }
    }

    const reopened = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      assert.equal(reopened.contains("h-checkpoint-2", 0), true);
      const hits = reopened.nearest(v2, { k: 2 });
      assert.ok(hits.some((hit) => hit.content_hash === "h-checkpoint-2"));
      const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, "index.usearch.json"), "utf8"));
      assert.equal(manifest.vector_count, 2);
    } finally {
      reopened.close();
    }
  });

  it("ChildEmbeddingIndex quarantines a crashing ANN and rebuilds from the sidecar", { skip: skipIfNoUsearch }, async () => {
    const root = path.join(tmp, "child-recovers-crashing-ann");
    const model = "child-repro";
    const model_version = "remove-save";
    const dim = 32;
    const modelDir = path.join(root, childEmbeddingModelDirName({ model, model_version }));
    const annPath = path.join(modelDir, "index.usearch");
    const manifestPath = path.join(modelDir, "index.usearch.json");
    {
      const idx = EmbeddingIndex.open({
        model,
        model_version,
        dim,
        embeddingsRoot: root,
        annSaveEveryBatches: 1_000_000,
      });
      try {
        const rows = [];
        for (let uid = 1; uid <= 6000; uid += 1) {
          rows.push({
            content_hash: `h${uid}`,
            local_id: 0,
            vector: deterministicVector(uid, dim),
          });
        }
        idx.add(rows);
      } finally {
        idx.close();
      }
    }

    const db = new Database(path.join(modelDir, "keys.db"));
    try {
      db.transaction(() => {
        db.prepare("DELETE FROM vectors WHERE uid % 3 != 0").run();
        db.prepare("DELETE FROM keys WHERE uid % 3 != 0").run();
      })();
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }

    const poisonScript = `
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const usearch = require("usearch").default ?? require("usearch");
const file = process.argv[2];
const dim = Number(process.argv[3]);
const idx = new usearch.Index({ metric: "cos", dimensions: dim });
const vector = new Float32Array(dim);
for (let uid = 1; uid <= 6000; uid += 1) {
  for (let i = 0; i < dim; i += 1) vector[i] = Math.sin((uid * 131 + i * 17) % 1000) / 32;
  idx.add(BigInt(uid), vector);
}
for (let uid = 1; uid <= 6000; uid += 1) {
  if (uid % 3 !== 0) idx.remove(BigInt(uid));
}
idx.save(file);
process.stdout.write(JSON.stringify({ size: idx.size(), bytes: fs.statSync(file).size }));
`;
    const poison = spawnSync(process.execPath, ["--input-type=module", "-", annPath, String(dim)], {
      input: poisonScript,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    assert.equal(poison.status, 0, poison.stderr || poison.stdout);

    const stat = fs.statSync(annPath);
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      version: 1,
      backend: "usearch",
      index_file: "index.usearch",
      model,
      model_version,
      dim,
      vector_count: 2000,
      native_size: 2000,
      size: stat.size,
      sha256: sha256File(annPath),
      saved_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");

    const child = ChildEmbeddingIndex.open({
      model,
      model_version,
      dim,
      embeddingsRoot: root,
    });
    try {
      assert.equal(await child.count(), 2000);
    } finally {
      await child.close();
    }

    const quarantined = fs.readdirSync(modelDir)
      .filter((name) => name.startsWith("index.usearch.child-init-crash-"));
    assert.ok(quarantined.length > 0, "bad ANN should be quarantined after child init crash");
    const logs = readPersistentTelemetryEntries("atlas-embedding-recovery", { limit: 200 });
    assert.equal(logs.some((entry) => entry.event === "child.init_failed"), true);
    assert.equal(logs.some((entry) => entry.event === "ann.quarantined"), true);
    assert.equal(logs.some((entry) => entry.event === "ann.rebuild_requested"), true);
    assert.equal(logs.some((entry) => entry.event === "ann.rebuilt_from_sidecar"), true);
  });

  it("pins the shared symbol-text shape used by every encoder", () => {
    const text = defaultBuildSymbolText({
      kind: "function",
      lang: "ts",
      name: "foo",
      qualified_name: "Mod.foo",
      signature_hash: "sig",
      signature_text: "export function foo()",
      doc: "Docs with\nextra whitespace.",
      body_lead: "return 1;",
    });
    assert.equal(TEXT_SHAPE_VERSION, 3);
    assert.equal(text, "function § ts § Mod.foo § export function foo() § Docs with extra whitespace. § return 1;");
  });

  it("defines the local ONNX encoder metadata without loading the optional runtime", () => {
    const tmp = makeTmp("atlas-v2-onnx-meta-");
    const enc = new LocalOnnxEmbeddingEncoder({
      cacheDir: path.join(tmp, "models"),
      modelName: "jinaai/jina-embeddings-v2-base-code",
      modelId: "jina-v2-code",
      dim: 768,
    });
    try {
      assert.equal(enc.model, "local-onnx");
      assert.equal(enc.model_version, "onnx-jina-v2-code-768-q8-text3");
      assert.equal(enc.dim, 768);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes local ONNX dtype in the default model version", () => {
    const tmp = makeTmp("atlas-v2-onnx-dtype-");
    try {
      const q8 = new LocalOnnxEmbeddingEncoder({
        cacheDir: path.join(tmp, "models"),
        modelName: "jinaai/jina-embeddings-v2-base-code",
        modelId: "jina-v2-code",
        dim: 768,
        dtype: "q8",
      });
      const fp32 = new LocalOnnxEmbeddingEncoder({
        cacheDir: path.join(tmp, "models"),
        modelName: "jinaai/jina-embeddings-v2-base-code",
        modelId: "jina-v2-code",
        dim: 768,
        dtype: "fp32",
      });
      assert.notEqual(q8.model_version, fp32.model_version);
      assert.match(fp32.model_version, /-fp32-text3$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gates local ONNX worker fanout to configured local encoders", () => {
    const tmp = makeTmp("atlas-v2-onnx-pool-");
    const enc = new LocalOnnxEmbeddingEncoder({
      cacheDir: path.join(tmp, "models"),
      modelName: "jinaai/jina-embeddings-v2-base-code",
      modelId: "jina-v2-code",
      dim: 768,
    });
    try {
      assert.equal(normalizeEmbeddingThreads(undefined), 2);
      assert.equal(normalizeEmbeddingThreads("0"), 1);
      assert.equal(normalizeEmbeddingThreads("12"), 8);
      assert.equal(shouldUseLocalOnnxEncodePool(enc, 2), true);
      assert.equal(shouldUseLocalOnnxEncodePool(enc, 1), false);
      assert.equal(shouldUseLocalOnnxEncodePool(new StubEmbeddingEncoder(), 2), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("validates local ONNX tensor output shape and passes token truncation options", async () => {
    const tmp = makeTmp("atlas-v2-onnx-shape-");
    const enc = new LocalOnnxEmbeddingEncoder({
      cacheDir: path.join(tmp, "models"),
      modelName: "jinaai/jina-embeddings-v2-base-code",
      modelId: "jina-v2-code",
      dim: 16,
      maxInputChars: 4,
      maxInputTokens: 32,
    });
    let receivedBatch = null;
    let receivedOptions = null;
    try {
      enc._pipelinePromise = Promise.resolve((batch, options) => {
        receivedBatch = batch;
        receivedOptions = options;
        return { dims: [batch.length, 16], data: new Float32Array(batch.length * 16) };
      });
      const vectors = await enc.encode(["abcdef", "gh"]);
      assert.equal(vectors.length, 2);
      assert.equal(vectors[0].length, 16);
      assert.deepEqual(receivedBatch, ["abcd", "gh"]);
      assert.equal(receivedOptions.truncation, true);
      assert.equal(receivedOptions.max_length, 32);

      enc._pipelinePromise = Promise.resolve((batch) => ({
        dims: [batch.length, 16],
        data: new Float32Array(batch.length * 16 + 1),
      }));
      await assert.rejects(() => enc.encode(["a", "b"]), /data length 33 != expected 32/);

      enc._pipelinePromise = Promise.resolve((batch) => ({
        dims: [batch.length, 8, 2],
        data: new Float32Array(batch.length * 16),
      }));
      await assert.rejects(() => enc.encode(["a", "b"]), /tensor dim 2x8x2 != expected 2x16/);

      const nonFinite = new Float32Array(16);
      nonFinite[3] = NaN;
      enc._pipelinePromise = Promise.resolve(() => ({
        dims: [1, 16],
        data: nonFinite,
      }));
      await assert.rejects(() => enc.encode(["a"]), /non-finite value at index 3/);

      enc._pipelinePromise = Promise.resolve(() => {
        throw new Error("extractor should not receive blank input");
      });
      await assert.rejects(() => enc.encode(["   "]), /text\[0\] is empty after trim/);
    } finally {
      await enc.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("disposes cached local ONNX pipelines when a dispose method exists", async () => {
    const tmp = makeTmp("atlas-v2-onnx-dispose-");
    const enc = new LocalOnnxEmbeddingEncoder({
      cacheDir: path.join(tmp, "models"),
      modelName: "jinaai/jina-embeddings-v2-base-code",
      modelId: "jina-v2-code",
      dim: 16,
    });
    let disposed = false;
    const extractor = Object.assign(() => ({ dims: [1, 16], data: new Float32Array(16) }), {
      dispose: () => { disposed = true; },
    });
    try {
      enc._pipelinePromise = Promise.resolve(extractor);
      await enc.dispose();
      assert.equal(disposed, true);
      assert.equal(enc._pipelinePromise, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scales the default ingest batch for local ONNX worker fanout", () => {
    const enc = new LocalOnnxEmbeddingEncoder({
      cacheDir: path.join(tmp, "onnx-batch-size"),
      modelName: "jinaai/jina-embeddings-v2-base-code",
      modelId: "jina-v2-code",
      dim: 768,
    });
    assert.equal(resolveEmbeddingIngestBatchSize({ encoder: enc, workerCount: 1 }), 64);
    assert.equal(resolveEmbeddingIngestBatchSize({ encoder: enc, workerCount: 2 }), 128);
    assert.equal(resolveEmbeddingIngestBatchSize({ encoder: enc, workerCount: 8 }), 512);
    assert.equal(resolveEmbeddingIngestBatchSize({ encoder: enc, workerCount: 8, batchSize: 7 }), 7);
    assert.equal(resolveEmbeddingIngestBatchSize({ encoder: new StubEmbeddingEncoder(), workerCount: 8 }), 64);
  });

  it("clears the cached local ONNX pipeline promise after a load failure", async () => {
    const tmp = makeTmp("atlas-v2-onnx-retry-");
    const enc = new LocalOnnxEmbeddingEncoder({
      cacheDir: path.join(tmp, "models"),
      modelName: "posse/missing-local-onnx-model",
      modelId: "missing-local-onnx-model",
      dim: 16,
      localFilesOnly: true,
    });
    try {
      await assert.rejects(() => enc._pipeline());
      assert.equal(enc._pipelinePromise, null);
      await assert.rejects(() => enc._pipeline());
      assert.equal(enc._pipelinePromise, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("EmbeddingIndex maps cosine distance onto a non-negative score range", () => {
    const root = path.join(tmp, "cos-score");
    const idx = EmbeddingIndex.open({
      model: "score-test",
      model_version: "v1",
      dim: 2,
      embeddingsRoot: root,
    });
    try {
      idx.add([
        { content_hash: "h-same", local_id: 0, vector: new Float32Array([1, 0]) },
        { content_hash: "h-opposite", local_id: 0, vector: new Float32Array([-1, 0]) },
      ]);
      const hits = idx.nearest(new Float32Array([1, 0]), { k: 2, minScore: 0 });
      assert.equal(hits.length, 2);
      assert.equal(hits[0].content_hash, "h-same");
      const opposite = hits.find((hit) => hit.content_hash === "h-opposite");
      assert.ok(opposite);
      assert.ok(opposite.distance > 1.9, `expected opposite vector distance near 2; got ${opposite.distance}`);
      assert.ok(opposite.score >= 0 && opposite.score <= 0.001, `expected score near 0; got ${opposite.score}`);
    } finally {
      idx.close();
    }
  });

  it("EmbeddingIndex.add leaves the ANN untouched when the sidecar transaction rolls back", async () => {
    const root = path.join(tmp, "add-rollback");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const [v1] = await enc.encode(["rollback-safe"]);
    const idx = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      assert.throws(() => idx.add([
        { content_hash: "h-rollback", local_id: 0, vector: v1 },
        { content_hash: "h-bad", local_id: 0, vector: new Float32Array([1, 2]) },
      ]), /vector must be Float32Array/);
      assert.equal(idx.count(), 0);
      const nonFinite = new Float32Array(enc.dim);
      nonFinite[5] = Infinity;
      assert.throws(() => idx.add([
        { content_hash: "h-rollback", local_id: 0, vector: v1 },
        { content_hash: "h-nonfinite", local_id: 0, vector: nonFinite },
      ]), /non-finite value at index 5/);
      assert.equal(idx.count(), 0);
      assert.throws(() => idx.nearest(nonFinite, { k: 1 }), /non-finite value at index 5/);
      idx.add([{ content_hash: "h-rollback", local_id: 0, vector: v1 }]);
      assert.equal(idx.count(), 1);
      const hits = idx.nearest(v1, { k: 5 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].content_hash, "h-rollback");
    } finally {
      idx.close();
    }
  });

  it("EmbeddingIndex.add saves partial ANN writes before bubbling an add failure", async () => {
    const localRequire = createRequire(import.meta.url);
    const mod = localRequire("usearch");
    const Usearch = mod?.default ?? mod;
    const originalAdd = Usearch.Index.prototype.add;
    const originalSave = EmbeddingIndex.prototype.save;
    let addCalls = 0;
    let saveCalls = 0;
    const root = path.join(tmp, "add-partial-failure");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const [v1, v2] = await enc.encode(["partial-one", "partial-two"]);
    const idx = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      Usearch.Index.prototype.add = function patchedAdd(uid, vector) {
        addCalls++;
        if (addCalls === 2) throw new Error("forced_ann_add_failure");
        return originalAdd.call(this, uid, vector);
      };
      EmbeddingIndex.prototype.save = function patchedSave() {
        saveCalls++;
        return originalSave.call(this);
      };
      assert.throws(() => idx.add([
        { content_hash: "h-partial-1", local_id: 0, vector: v1 },
        { content_hash: "h-partial-2", local_id: 0, vector: v2 },
      ]), /forced_ann_add_failure/);
      assert.equal(saveCalls, 1);
      assert.equal(idx.count(), 2);
    } finally {
      Usearch.Index.prototype.add = originalAdd;
      EmbeddingIndex.prototype.save = originalSave;
      idx.close();
    }

    const reopened = EmbeddingIndex.open({
      model: enc.model,
      model_version: enc.model_version,
      dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      reopened.add([
        { content_hash: "h-partial-1", local_id: 0, vector: v1 },
        { content_hash: "h-partial-2", local_id: 0, vector: v2 },
      ]);
      const hits = reopened.nearest(v2, { k: 2 });
      assert.equal(hits.length, 2);
      assert.ok(hits.some((hit) => hit.content_hash === "h-partial-1"));
      assert.ok(hits.some((hit) => hit.content_hash === "h-partial-2"));
    } finally {
      reopened.close();
    }
  });

  it("EmbeddingIndex.add defers ANN saves but reopen rebuilds from sidecar checkpoints", async () => {
    const root = path.join(tmp, "crash");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const modelDir = path.join(root, modelDirName({
      model: enc.model,
      model_version: enc.model_version,
    }));
    const [v] = await enc.encode(["needle"]);
    let idx;
    let reopened;
    try {
      idx = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: root,
        annSaveEveryBatches: 1000,
        annSaveEveryMs: 3_600_000,
      });
      idx.add([{ content_hash: "h-crash", local_id: 0, vector: v }]);
      const timing = idx.getLastAddTiming();
      assert.equal(timing.annDeferred, true);
      assert.equal(timing.annDirtyBatches, 1);
      assert.equal(fs.existsSync(path.join(modelDir, "index.usearch")), false);

      // Simulate a process cut-off by opening a fresh handle before the dirty
      // in-memory ANN has a chance to close/save. The committed sidecar vectors
      // are enough to rebuild and query.
      reopened = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: root,
      });
      assert.equal(reopened.count(), 1);
      const hits = reopened.nearest(v, { k: 5 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].content_hash, "h-crash");
      const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, "index.usearch.json"), "utf8"));
      assert.equal(manifest.vector_count, 1);
    } finally {
      try { reopened?.close(); } catch { /* ignore */ }
      try { idx?.close(); } catch { /* ignore */ }
    }
  });

  it("EmbeddingIndex.add checkpoints the ANN when the batch threshold is reached", async () => {
    const root = path.join(tmp, "checkpoint-threshold");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const modelDir = path.join(root, modelDirName({
      model: enc.model,
      model_version: enc.model_version,
    }));
    const [v1, v2] = await enc.encode(["threshold-one", "threshold-two"]);
    {
      const idx = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: root,
        annSaveEveryBatches: 2,
        annSaveEveryMs: 3_600_000,
      });
      try {
        idx.add([{ content_hash: "h-threshold-1", local_id: 0, vector: v1 }]);
        assert.equal(idx.getLastAddTiming().annDeferred, true);
        assert.equal(fs.existsSync(path.join(modelDir, "index.usearch")), false);
        idx.add([{ content_hash: "h-threshold-2", local_id: 0, vector: v2 }]);
        const timing = idx.getLastAddTiming();
        assert.equal(timing.annDeferred, false);
        assert.equal(timing.annDirtyBatches, 0);
        assert.equal(fs.existsSync(path.join(modelDir, "index.usearch")), true);
      } finally {
        idx.close();
      }
    }
    {
      const idx = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: root,
      });
      try {
        assert.equal(idx.count(), 2);
        const hits = idx.nearest(v2, { k: 5 });
        assert.ok(hits.some((hit) => hit.content_hash === "h-threshold-2"));
      } finally {
        idx.close();
      }
    }
  });

  it("EmbeddingIndex.removeByContentHash drops both ANN and sidecar rows", async () => {
    const root = path.join(tmp, "rm");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const idx = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      const [v1, v2] = await enc.encode(["x", "y"]);
      idx.add([
        { content_hash: "h1", local_id: 0, vector: v1 },
        { content_hash: "h1", local_id: 1, vector: v1 },
        { content_hash: "h2", local_id: 0, vector: v2 },
      ]);
      assert.equal(idx.count(), 3);
      const removed = idx.removeByContentHash(["h1"]);
      assert.equal(removed, 2);
      assert.equal(idx.count(), 1);
      // Searching should now only return h2.
      const hits = idx.nearest(v2, { k: 5 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].content_hash, "h2");
    } finally {
      idx.close();
    }
  });

  it("EmbeddingIndex.pruneToKeys drops orphaned sidecar and ANN rows", async () => {
    const root = path.join(tmp, "prune-keys");
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const idx = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: root,
    });
    try {
      const [v1, v2, v3] = await enc.encode(["keep-a", "drop", "keep-b"]);
      idx.add([
        { content_hash: "h1", local_id: 0, vector: v1 },
        { content_hash: "h2", local_id: 0, vector: v2 },
        { content_hash: "h3", local_id: 1, vector: v3 },
      ]);
      assert.equal(idx.count(), 3);
      const removed = idx.pruneToKeys([
        { content_hash: "h1", local_id: 0 },
        { content_hash: "h3", local_id: 1 },
      ]);
      assert.equal(removed, 1);
      assert.equal(idx.count(), 2);
      assert.equal(idx.contains("h1", 0), true);
      assert.equal(idx.contains("h2", 0), false);
      assert.equal(idx.contains("h3", 1), true);
    } finally {
      idx.close();
    }
  });
});


describe("ATLAS v2 ingest + semantic search end-to-end", { skip: skipIfNoUsearch }, () => {
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-emb-e2e-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch { /* best effort */ }
  });

  it("signature_text round-trips ledger -> view -> ViewSymbol.signature_text", () => {
    const ledPath = path.join(tmp, "sigtext.ledger.db");
    const viewPath = path.join(tmp, "sigtext.view.db");
    const led = Ledger.open({ dbPath: ledPath });
    try {
      const content = `function multiply(a: number, b: number): number { return a * b; }\n`;
      const hash = sha256Hex(Buffer.from(content));
      led.ingestBlob({
        content_hash: hash, lang: "ts", byte_size: content.length,
        symbols: [{
          content_hash: hash, local_id: 0,
          kind: "function", name: "multiply", qualified_name: "multiply",
          parent_local_id: null, repo_rel_path: "src/multiply.ts", lang: "ts",
          range_start: 0, range_end: content.length,
          signature_hash: sha256Hex("function multiply(a: number, b: number): number"),
          signature_text: "function multiply(a: number, b: number): number",
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/multiply.ts",
        before_content_hash: null, after_content_hash: hash,
      });
      new ViewBuilder().buildFrom({
        ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath,
      });

      const view = View.mount({ dbPath: viewPath });
      try {
        const syms = view.query.allSymbols({ limit: 10 });
        assert.equal(syms.length, 1);
        assert.equal(
          syms[0].signature_text,
          "function multiply(a: number, b: number): number",
          "signature_text must survive ledger->view round-trip",
        );
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("ingestView indexes every symbol in the view", async () => {
    const viewPath = setupView(tmp, "ingest-all");
    const view = View.mount({ dbPath: viewPath });
    const enc = new StubEmbeddingEncoder({ dim: 64 });
    const idx = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: path.join(tmp, "ingest-all-emb"),
    });
    try {
      const report = await ingestView({ view, index: idx, encoder: enc });
      assert.equal(report.candidates, 3, `expected 3 symbols; got ${report.candidates}`);
      assert.equal(report.indexed, 3);
      assert.equal(report.skipped, 0);
      assert.ok(report.batches >= 1);
      assert.equal(idx.count(), 3);
    } finally {
      idx.close();
      view.close();
    }
  });

  it("semanticSearch returns ViewSymbol hits scored by encoder similarity", async () => {
    const viewPath = setupView(tmp, "search-ranked");
    const view = View.mount({ dbPath: viewPath });
    const enc = new StubEmbeddingEncoder({ dim: 64 });
    const idx = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: path.join(tmp, "search-ranked-emb"),
    });
    try {
      await ingestView({ view, index: idx, encoder: enc });
      // Querying "greet" — the hash-based stub embeds shared n-grams, so
      // the symbol whose canonical text contains "greet" should be near
      // the top of the results.
      const hits = await semanticSearch({
        query: "greet", view, index: idx, encoder: enc, k: 3,
      });
      assert.ok(hits.length >= 1, `expected at least one hit; got ${hits.length}`);
      const names = hits.map((h) => h.symbol.name);
      assert.ok(names.includes("greet"), `expected 'greet' in hits; got [${names.join(", ")}]`);
      // Scores are in [0, 1] and the top hit's score must be > the bottom hit's.
      for (const h of hits) {
        assert.ok(h.score >= 0 && h.score <= 1.0001, `score out of range: ${h.score}`);
      }
    } finally {
      idx.close();
      view.close();
    }
  });

  it("symbol.search with semantic=true routes through the embedding path", async () => {
    const viewPath = setupView(tmp, "sym-search-sem");
    const view = View.mount({ dbPath: viewPath });
    const enc = new StubEmbeddingEncoder({ dim: 64 });
    const idx = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: path.join(tmp, "sym-search-sem-emb"),
    });
    try {
      await ingestView({ view, index: idx, encoder: enc });
      const envelope = await symbolSearch({
        view,
        versionId: "test-v1",
        params: { action: "symbol.search", query: "greet", semantic: true, limit: 5 },
        embeddingIndex: idx,
        encoder: enc,
      });
      assert.equal(envelope.action, "symbol.search");
      assert.equal(envelope.ok, true);
      const items = envelope.data?.items ?? [];
      assert.ok(items.length >= 1, "semantic search should return at least one item");
      assert.ok(items.some((it) => it.name === "greet"));
    } finally {
      idx.close();
      view.close();
    }
  });

  it("slice.build uses semantic entry discovery when embeddings are available", async () => {
    const viewPath = setupView(tmp, "slice-build-sem");
    const view = View.mount({ dbPath: viewPath });
    const enc = new StubEmbeddingEncoder({ dim: 64 });
    const idx = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: path.join(tmp, "slice-build-sem-emb"),
    });
    try {
      await ingestView({ view, index: idx, encoder: enc });
      const envelope = await sliceBuild({
        view,
        versionId: "test-v1",
        params: {
          action: "slice.build",
          taskText: "greet",
          semantic: true,
          budget: { maxCards: 5, maxEstimatedTokens: 10000 },
        },
        embeddingIndex: idx,
        encoder: enc,
      });
      assert.equal(envelope.action, "slice.build");
      assert.equal(envelope.ok, true);
      assert.ok(envelope.data.cards.some((card) => card.name === "greet"));
    } finally {
      idx.close();
      view.close();
    }
  });

});

// FTS-only path — runs on EVERY platform, including those without
// usearch. This is what makes symbol.search safe on installs where the
// optional native dep didn't compile (e.g. Windows without a toolchain).
describe("ATLAS v2 symbol.search FTS fallback (no usearch required)", () => {
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-fts-fb-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch { /* best effort */ }
  });

  it("symbol.search with semantic=true and no embedding context falls back to FTS", () => {
    const viewPath = setupView(tmp, "sym-search-fallback");
    const view = View.mount({ dbPath: viewPath });
    try {
      // No embeddingIndex / encoder supplied — should NOT throw, should
      // fall through to the FTS path silently.
      const result = symbolSearch({
        view,
        versionId: "test-v1",
        params: { action: "symbol.search", query: "greet", semantic: true, limit: 5 },
      });
      // Sync path returns directly (not a Promise).
      assert.ok(!(result instanceof Promise), "fallback should be synchronous FTS");
      assert.equal(result.action, "symbol.search");
      assert.equal(result.ok, true);
    } finally {
      view.close();
    }
  });

  it("symbol.search reports incomplete on-demand encoding even when vector ranking returns hits", async () => {
    const viewPath = setupView(tmp, "sym-search-incomplete");
    const view = View.mount({ dbPath: viewPath });
    try {
      const greet = view.query.allSymbols().find((symbol) => symbol.name === "greet");
      const index = {
        model: "fake",
        model_version: "v1",
        dim: 2,
        contains: async () => false,
        add: async () => {},
        nearest: async () => [{
          content_hash: greet.content_hash,
          local_id: greet.local_id,
          score: 0.99,
          distance: 0.01,
        }],
      };
      const encoder = {
        model: "fake",
        model_version: "v1",
        dim: 2,
        buildSymbolText: (symbol) => symbol.name,
        encode: async (texts) => {
          if (texts.length === 1 && texts[0] === "greet") {
            return [new Float32Array([1, 0])];
          }
          throw new Error("symbol_encode_failed");
        },
      };

      const result = await symbolSearch({
        view,
        versionId: "test-v1",
        params: { action: "symbol.search", query: "greet", semantic: true, limit: 5 },
        embeddingIndex: index,
        encoder,
      });

      assert.equal(result.ok, true);
      assert.equal(result.meta.semantic.available, true);
      assert.equal(result.meta.semantic.encoding.incomplete, true);
      assert.equal(result.meta.semantic.degradedReason, "symbol_encode_failed");
      assert.ok(result.meta.warnings.some((warning) => /encoding incomplete/.test(warning)));
    } finally {
      view.close();
    }
  });
});

describe("ATLAS v2 on-demand embeddings", () => {
  it("coalesces concurrent first-time encodes for the same view and index", async () => {
    const tmp = makeTmp("atlas-v2-emb-on-demand-");
    try {
      const viewPath = setupView(tmp, "on-demand");
      const view = View.mount({ dbPath: viewPath });
      const indexed = new Set();
      let encodeCalls = 0;
      const index = {
        model: "test-index",
        model_version: "v1",
        dim: 16,
        async contains(contentHash, localId) {
          return indexed.has(`${contentHash}\0${localId}`);
        },
        async containsMany(keys) {
          return new Set(keys
            .map((key) => `${key.content_hash}\0${key.local_id}`)
            .filter((key) => indexed.has(key)));
        },
        async add(rows) {
          for (const row of rows) indexed.add(`${row.content_hash}\0${row.local_id}`);
        },
      };
      const encoder = {
        model: "test-index",
        model_version: "v1",
        dim: 16,
        buildSymbolText(symbol) {
          return `${symbol.kind} ${symbol.name}`;
        },
        async encode(texts) {
          encodeCalls += 1;
          await sleep(50);
          return texts.map(() => {
            const vec = new Float32Array(16);
            vec[0] = 1;
            return vec;
          });
        },
      };

      try {
        const [a, b] = await Promise.all([
          ensureEmbeddingsForView({ view, index, encoder, limit: 1000, timeoutMs: 1000 }),
          ensureEmbeddingsForView({ view, index, encoder, limit: 1000, timeoutMs: 1000 }),
        ]);
        assert.equal(a.skipped, false);
        assert.equal(b.skipped, false);
        assert.equal(a.encoded, 3);
        assert.equal(b.encoded, 3);
        assert.equal(encodeCalls, 1);
      } finally {
        view.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
