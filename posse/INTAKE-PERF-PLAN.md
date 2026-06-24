# ATLAS / ONNX Intake & Flow — Performance Plan

> Companion to `MIGRATION-CUTOVER-PLAN.md`. That doc covers the Node→Rust + shared-Daemon
> re-architecture (mostly DONE: shared Daemon, conductor adoption, N-wide ONNX encoder). This
> doc is the **next-layer perf review of the live intake/flow path** — where wall-clock and
> user-perceived latency still go after the cutover, and the concrete levers to cut it.
>
> Every lever below carries a **red-team verdict** (CONFIRMED / RISKY / REFUTED) with the
> guard that must ship with it. The verdicts come from reading the live code, not the design
> intent. Do not implement a RISKY lever without its named guard.
>
> **Status: plan only. No code changed.** All `file:line` anchors are from the working tree
> at authoring time (2026-06-23).

---

## How a warm/intake job actually flows

```
atlas-warm-job.runAtlasWarmJob
└─ runSqliteWrite(ledgerPath)                    ← process-wide SQLite write GATE (barrier)
   └─ getSharedConductor().warm()                ← writesWithReaderHold: drains the reader lane
      └─ dbWrite.run(handleWarmJob)              ← conductor host width-1 semaphore (THE serial point)
         └─ ParseEngine.handleWarmJob
            ├─ Promise.all([                                  ← parse ∥ scip overlap (good)
            │    #warmIncremental  (tree-sitter, SERIAL per-file)
            │    #stageScipFiles → scipQueue     (SCIP indexers, parallel per-language, width 6)
            │  ])
            ├─ await scipQueue.idle()                          ← BARRIER: serial-FIFO SCIP intake drains
            └─ #updateBranchViewIncremental / #rebuildBranchView   ← the "zip" / merge (serial)
      └─ flushDeferredEmbeddings()               ← AFTER the dbWrite slot releases
```

User-perceived "ATLAS ready for tools" = end of view-merge. "Fully indexed" = embeddings encode +
tree-compression, which finish in the background after the TUI is already up.

### Three structural facts that dominate everything

1. **One writer thread, width-1 semaphore, multi-second *synchronous* transactions.**
   `dbWrite = ParseSemaphore(1)` (`parse/semaphore.js:5-7`) wraps warm, SCIP-ingest (the
   documented *"19–26s SCIP ingest transaction"*, `conductor-host.mjs:188-197`), and merge
   (`conductor-host.mjs:125,161,206`). Because better-sqlite3 is synchronous, each op blocks the
   only conductor thread for its full duration. **First-order cost is op duration, not lock
   arbitration.** That reframes the migration doc's Phase-2 DB split as a measure-first item.

2. **Hot loops redo work that infrastructure already exists to avoid.**
   - Tree-sitter parse spawns a **fresh native process per file, synchronously** (`parser.js:105`
     → sync `runAtlasNativeMethod`; the comment at `invoke.js:112-115` says to prefer the async
     daemon variant). The daemon path exists and SCIP already uses it.
   - The Interner does a **`SELECT` + conditional `INSERT` per string with no in-memory cache**
     (`Interner.js:33-53`; the header comment says so explicitly), inside the long ingest txn,
     for repeated strings like `function`/`class`.

3. **Boot serializes independent work and re-does a freshness scan every time.**
   ATLAS warm waits on provider-auth settle though they're independent; boot always runs
   `main-incremental` (with a full file-stat walk) even when the index is current; view-freshness
   is inspected twice.

### The blocker: the write path is un-instrumented

Parse/ingest/merge events emit `durationMs: null`; `ParseSemaphore` has no wait/hold timing (the
`info` op even calls a non-existent `dbWrite.depth()`). The migration doc says "MEASURE FIRST"
for the DB split — right now you **can't**. So instrumentation is Phase 0.

### Parser verification (resolves the open question)

The migration doc's note that *"atlas is flag-off"* is **STALE**. `BinaryManager.enabled("atlas")`
returns `true` hardwired (`BinaryManager.js:164`), and `ParserAdapter.supports()` routes all
native-owned languages to `nativeBinaries.shouldUse("atlas")` with **no Node fallback** —
unsupported → the file isn't queued at all (`ParserAdapter.js:56-59`). So the **per-file native
sync spawn is the live production parse path today**, as long as the binary is staged for the
platform (it is). P1 is therefore a current-prod fix, not future-flag work.

---

## Phase 0 — Instrumentation (prerequisite · XS · decisive)

Without this, the DB-split decision and the parse-vs-ingest-vs-merge prioritization are guesses.

- **0a.** Time the three `dbWrite.run(...)` sites (`conductor-host.mjs:125,161,206`): emit real
  per-op `durationMs` (ingest vs warm vs merge) **and the semaphore wait time** (enqueue → start).
- **0b.** Give `ParseSemaphore` a real `depth()` / `waitMs` (`ParseSemaphore.js`); replace the
  `durationMs: null` in parse/ingest/merge events.
- **0c.** Emit per-phase totals from `ParseEngine.finalize` (parse / scip-stage / scip-intake /
  merge / encode), not just whole-job duration.
- **0d.** Surface `BinaryManager.workerFallbackStats()` (`BinaryManager.js:192`) at warm end —
  nonzero = the daemon degraded to per-call spawns this run (directly gates P1's payoff).

**Outcome:** learn whether the bottleneck is queue-wait (→ DB split helps) or op-duration (→
Interner cache + PRAGMAs help), and which phase is the real long pole per repo.

---

## Phase 1 — Cheap, deterministic wins (land regardless of measurement)

All respect the SDL-determinism constraint (pure dedup / DB config — no ML, no output change).

### 1a — In-process Interner cache · HIGH · S · **CONFIRMED (with guard)**
Add a per-Ledger `Map<string,id>` write-through in front of the SELECT/INSERT (`Interner.js:33-53`).
The conductor caches Ledger handles by `${ledgerPath}|${dbPath}` and reuses them across warms
(`conductor-host.mjs:68-85`), so the cache survives the session. IDs are append-only — no
DELETE/DROP on `interned_strings`/`interned_paths` (reingest deletes only blob rows,
`Ledger.js:892`), single-writer, so a cached id can never become wrong.
- **Guard:** wire cache invalidation to handle disposal/close. The one hole is an out-of-band
  ledger rebuild (`posse atlas-v2 reparse` deleting the file) while the conductor holds the
  handle — clear the Map when the handle is evicted/closed.
- Biggest redundant-SQLite source inside the long ingest txn; flagged independently by two
  passes. Also defuses the Interner reconciliation risk that makes the Phase-2 DB split scary.

### 1b — PRAGMA tuning on ledger + view DBs · HIGH · XS-S · **RISKY (apply correctly)**
Ledger/view open with only `busy_timeout` + the DDL's WAL/synchronous; the orchestrator DB is
tuned (`lib/shared/storage/functions/index.js:161-163`: `synchronous=NORMAL`, `temp_store=MEMORY`,
`mmap_size=268435456`). Add `cache_size`, `mmap_size`, `temp_store=MEMORY` to ledger
(`schema.js`) and view (`View.js` open).
- **Correction:** `synchronous=NORMAL` is **already set** on both (`ledger.sql:21`, `view.sql:17`)
  — not a new lever, and NORMAL+WAL is the standard safe combo (worst case: lose last commit on
  power loss, never corruption). The cross-DB zip atomicity / half-job GC story is unaffected.
- **Guard 1 — apply per-connection, including readers.** DDL PRAGMAs (except `journal_mode`) are
  per-connection. `runDdl` runs only on the readwrite open (`Ledger.js:88`); readonly opens
  (`schema.js:170-174`) get **only** `busy_timeout`. Put the new PRAGMAs in the open paths
  (`openLedgerDb` / `openLedgerDbReadOnly` / `View` open), or readers won't get them.
- **Guard 2 — bound `cache_size` × handle count.** 64 MiB × N reader handles can blow memory;
  pick the size against how many concurrent ledger/view handles the reader lane holds. Wrap
  `mmap_size` in best-effort try/catch (the orchestrator already runs 256 MiB mmap on Windows,
  so it's tolerated — but don't hard-fail boot on a rejected pragma).

### 1c — WAL checkpoint discipline · MED · S · CONFIRMED
The ledger never checkpoints. Add a periodic `wal_checkpoint(PASSIVE)` after large warms so the
WAL doesn't grow unbounded and slow reads.

---

## Phase 1.5 — ATLAS dispatch-cache hardening (correctness before expansion)

The gateway-level `AtlasToolDispatchCache` is the right boundary for duplicate ATLAS dispatches,
but it sits above more precise retrieval caches. Treat it as a coalescing layer first, not as a
blanket result cache.

### C1 — Make retrieval dispatch caching in-flight-only · HIGH · S · CONFIRMED
Retrieval results split into query-relative selection/ranking (`symbol.search`, `slice.build`,
`context`, `tree.*`, `code.*`) and reusable per-symbol/card materialization. The lower retrieval
caches already carry `versionId`/read-context scoping where needed. A coarse
`repoKey|action:args` ready-result cache above them can serve stale envelopes and duplicates less
precise cache state.
- **Action:** for `symbol.search`, `symbol.card`, `slice.build`, `slice.refresh`, `context`,
  `context.summary`, `tree.*`, and `code.*`, keep dispatch-cache in-flight coalescing only.
  Do not store settled ready results unless the dispatch key carries the same read-context
  version/epoch as the underlying retrieval layer.
- **Guard:** action cache behavior must be declared per action (`never | inflightOnly |
  versioned | gitState`) instead of inferred from a flat allowlist.

### C2 — Prevent stale in-flight promotion · HIGH · S · CONFIRMED
If a cacheable producer starts, then a write/index/read-context invalidation happens before it
resolves, the old result must not be promoted into ready cache afterward.
- **Action:** capture a per-repo dispatch-cache epoch at producer start; on success, promote to
  ready only if the epoch is unchanged and the pending entry is still current.
- **Guard:** bump the repo epoch on read-context changes, deterministic write refresh scheduling,
  and conductor indexing success fan-out.

### C3 — Keep retrieval payload ownership in `RetrievalCache` · MED · M · CONFIRMED
`RetrievalCache` should own reusable retrieval payloads: cards and slices today, with finer
fragments added where they are genuinely cross-query or cross-reindex safe.
- **Action:** add a bare-fragment cache for resolution-free symbol material keyed by
  `etag + symbolId + detail/schema`, with no `versionId`.
- **Guard:** only bare/minimal/signature fragments are cross-reindex-safe. Compact/full cards
  compose those fragments with fresh view edges and remain `versionId`-keyed because callers,
  callees, and confidence policy are view-dependent.

### C4 — Narrow ready-result caching until keys are explicit · HIGH · S · CONFIRMED
Ready-result dispatch caching stays disabled for retrieval actions until each action declares a
versioned key or a git-state fingerprint. State-sensitive actions (`repo.status`, `review.*`,
`repo.quality`) remain `inflightOnly` or `gitState` until their key includes HEAD/branch/dirty
state and review base where applicable.

---

## Phase 2 — Parse path: kill the per-file serial spawn

### P1 — Async/batched parse · HIGH · HIGH · **RISKY (benefit is conditional)**
Move `parseBufferNative` off the sync per-call spawn (`runAtlasNativeMethod`, `parser.js:105`)
onto `runAtlasNativeMethodAsync` (persistent daemon), ideally with a native **`parseBuffers`
batch** method, and issue parses with bounded concurrency in `ParseEngine.#indexPaths` instead of
the serial sync `for` loop. Infra exists; SCIP already uses the async path.
- **Confirmed safe:** native is the live path (parser verification above); concurrent parse is
  write-safe (all durable writes still funnel through `dbWrite`); SCIP staging already proves the
  fan-out pattern; auth is transparent on the conductor (heartbeat manager installed,
  `conductor-host.mjs:26-29`).
- **The hazard:** the async win depends on `hasNativeThreadBridge()` being attached. When it
  isn't, `runAtlasNativeMethodAsync` falls back to an in-thread per-call spawn — same cost,
  silently. **Guard:** gate the claim on Phase-0 `workerFallbackStats` (0d); if fallbacks are
  nonzero under a parse storm, fix bridge attach reliability first or the speedup evaporates.

### P2 — Don't hash files twice per boot · MED · LOW · CONFIRMED
The boot freshness scan already computes a content hash for changed files; thread it (and
small-file bytes) into `#indexPaths` so it skips the second stat+read+hash.

### P3 — Persist a `minified` verdict in `source_stats` · LOW · LOW · CONFIRMED
Avoid re-reading 16 KB of every non-path-matched file each warm to re-decide minified.

---

## Phase 3 — ONNX encode throughput (the model *is* the bottleneck)

The encoder runs jina-v2-code int8 on the onnxruntime CPU EP with **zero EP/thread config**
(grep-confirmed). These keep the same model; the risk is float-output drift vs the embedding
identity contract — read each guard.

### O1 — Configure ORT EP + cap intra-op threads · HIGH · MED · **RISKY (determinism guard required)**
In `onnx-host.mjs` / `LocalOnnxEmbeddingEncoder._pipeline` (`LocalOnnxEmbeddingEncoder.js:116-123`)
cap `intra_op_num_threads` (so N daemon workers stop oversubscribing cores) and pass a faster
device — **DirectML** on Windows, **CoreML** on macOS.
- **Availability CONFIRMED:** `onnxruntime-node@1.24.3` ships `DirectML.dll` on win32;
  transformers.js 4.2.0 registers `dml`/`coreml` devices and accepts `device` + `session_options`
  via `pipeline(...)`. (The earlier "no EP support" claim was wrong.)
- **Guard 1 — verify q8 actually runs on DML.** The model loads `dtype:'q8'`
  (`LocalOnnxEmbeddingEncoder.js:80`); quantized int8 graphs often fall back to CPU under DML or
  fail to bind. Confirm real GPU execution before banking the win.
- **Guard 2 (MUST SHIP) — fold EP + thread identity into `model_version`.** `model_version` is
  `onnx-${modelId}-${dim}-${dtype}-text${textShapeVersion}` (`LocalOnnxEmbeddingEncoder.js:95`) —
  it does **not** encode EP or thread count, and `ingestView` skips re-encoding anything already
  indexed (`ingest.js:196-205`). Flip the EP after vectors exist and you get ANN neighbors
  computed across mixed-EP floats (ORT is not bitwise-stable across EP/thread changes) with **no
  error and no way to self-heal** — silent search-quality rot. Add EP/thread to `model_version`
  so a change forces a full re-encode.

### O2 — CPU-aware `embeddingThreads` · MED · LOW · CONFIRMED (depends on O1)
Today hardcoded `2` (`config.js:802`), capped low *because* intra-op threads are uncapped. After
O1 caps them, scale to `min(8, floor(cores / intraOpThreads))`. **Do not raise width before O1**
or you reintroduce the oversubscription O1 fixes.

### O3 — Overlap encode with index-write · HIGH · LOW-MED · **RISKY (breadcrumb rework required)**
`ingest.js` is strictly serial: encode → `await index.add` → encode next. A one-batch lookahead
(encode N+1 while N's `add` is in flight) hides write latency behind encode.
- **Guard (MUST SHIP):** the single-inflight breadcrumb assumes only one batch is ever in flight
  (`EmbeddingIndex.js:728-748`); `markEncoding`/`clearEncoding` (`ingest.js:259,338`) overwrite a
  single `inflightPath`. Two in-flight batches corrupt crash-recovery (N+1's clear deletes the
  breadcrumb while N's add may be uncommitted). Rework the breadcrumb to track multiple in-flight
  batches (keyed by batch number) before overlapping. The `add` itself is synchronous SQLite, so
  the only real overlap is "encode N+1 while add(N) runs" — fine once the breadcrumb is fixed.

### O4 — Pre-warm the daemon worker set at boot to configured width · MED · MED · CONFIRMED
The dedicated boot warm-worker warms a throwaway model and disposes it (~6s wasted, not folded
into the daemon set), and extra daemon workers pay their 6s lazily mid-ingest. Warm all N up
front, off the critical path; reuse them for the boot warm.

### O5 — Lower `max_length` 8192 → ~512 · LOW · LOW · **RISKY (needs validation + maybe version bump)**
Real symbol text is <~1100 chars (`build-symbol-text.js` caps), so 8192 is dead headroom that
inflates any batch with one long item. **Guard:** if it changes any real vector it needs a
`model_version` bump (same contract as O1). Benchmark with
`scripts/atlas-v2-bench-embedding-intake.mjs` first; lowest priority.

---

## Phase 4 — Boot critical-path latency

ONNX preboot is already correctly backgrounded — the "~6s" is a synthetic progress estimate
(`onnx-warm-state.js:12`), **not** on the critical path. The real user wait is the index build
through view-merge, so Phases 1–3 are the dominant boot wins. The boot-specific items:

### B1 — ~~Skip the warm on a current index~~ → Make the freshness scan non-gating · MED · MED · **REFUTED as written → reframed**
Boot deliberately runs `main-incremental` even when the index is current (`atlas.js:884-888`).
**You cannot skip it:** the fall-through stat-scan (`ParseEngine.js:1363-1519`) is HEAD-independent
by design — it catches uncommitted/dirty edits, out-of-band disk rewrites, branch switches at the
same HEAD, deletions, and partial prior warms (stat rows only refresh on a successful parse). A
HEAD-unchanged gate would serve a stale index.
- **Reframed lever:** keep the scan, but (a) don't hold the `dbWrite` gate when it finds zero
  drift (release early on a clean scan), and (b) overlap the walk with B2 below. The expensive
  re-hash/re-parse only fires for drifted files; the residual cost on a clean repo is the tree
  walk + stats, which can run without blocking the write lane.

### B2 — Overlap ATLAS warm with provider-auth settle · MED-LOW · LOW · **RISKY (small upside, not the claimed race)**
`RunSession` awaits `Promise.allSettled(providerWarmups)` then starts the ATLAS warm
(`RunSession.js:1925-1929`); they're independent. Start `startAtlasWarmupPhase()` concurrently and
join both at the TUI gate.
- **Correction:** the "native calls fire before the heartbeat envelope is ready" race does **not**
  exist — the heartbeat envelope is synchronous, settings-derived config (`HeartbeatAuthManager`),
  not produced by provider OAuth/usage warmup. So B2 is safe.
- **But** the only real cost removed is boot-panel finalization ordering + a little CPU contention;
  the bounded auth prime is short, so the latency upside is modest. Low effort, do it, but don't
  over-weight it.

### B3 — Collapse the double view-freshness inspect · MED · LOW · CONFIRMED
The boot worker already inspects view freshness internally (`atlas.js:858-865`); the outer
`inspectMainViewForBootInWorker` round-trip (`atlas.js:1518`) is redundant — drop it or pass the
result into the worker. Saves a worker spawn + SQLite open every boot.

### B4 — Dedupe boot reindex vs the queued coalesced warm · MED · MED · CONFIRMED
Per-commit warms coalesce by `purpose:branch` (`PipelineHooks.js:404-426`), but the boot's own
`main-incremental:main` and the replayed queued warm for the same head both run serially.
Recognize/cancel one against the other (the cancel machinery exists for WI warms,
`PipelineHooks.js:236-276`).

### B5 — Move `posse update` network check off the critical path · LOW · LOW · CONFIRMED
It gates nothing (`RunSession.js:539-565`).

---

## Recommended sequence & dependencies

```
Phase 0 (instrument)        → unblocks the S1 decision and per-phase prioritization
Phase 1 (Interner, PRAGMAs, WAL)   → ship immediately; independent, low-risk, deterministic
Phase 1.5 C1/C2/C4         → harden dispatch caching before broad ready-result reuse
Phase 3 O1 → O2             → ONNX EP+thread cap first (with model_version guard), then widen
Phase 4 B2/B3/B5           → low-risk boot tidy-ups
Phase 2 P1                 → high effort; gate the payoff on Phase-0 fallback telemetry
Phase 4 B1 (reframed)      → make the freshness scan non-gating (NOT a skip)
Phase 5                    → only if Phase-0 data shows true queue-wait contention
```

**First five to ship:** 0a/0b/0d (instrument), **1a (Interner cache + invalidation hook)**,
**1b (PRAGMAs, per-connection)**, **O1 (ORT EP/threads + `model_version` guard)**, **B3 (drop the
double inspect)**. Mostly XS–S, deterministic, and they hit all three cost centers.

---

## Phase 5 — Structural (only if Phase 0 justifies)

- **S1 — Atlas/SCIP DB split** (migration doc Phase 2). Pursue only if 0a/0b show real
  *queue-wait* contention, not op-duration. Phase 1a defuses its load-bearing Interner risk;
  PRAGMAs + Interner cache may make it unnecessary.
- **S2 — Pipeline SCIP intake.** Move read-only decode + native `scip-rows` row-building outside
  the write transaction so file N+1 decodes while file N commits.
- **S3 — Batch warm ingests per transaction** to amortize WAL fsync on many-small-file repos.

---

## Red-team verdict summary

| Lever | Verdict | Guard that must ship |
|---|---|---|
| 1a Interner cache | CONFIRMED | invalidate on handle close/evict |
| 1b PRAGMA tuning | RISKY | apply per-connection incl. readonly; bound cache_size × handles; `synchronous=NORMAL` already on |
| 1c WAL checkpoint | CONFIRMED | — |
| C1 retrieval dispatch cache | CONFIRMED | in-flight only unless key carries read-context version/epoch |
| C2 stale promotion guard | CONFIRMED | capture repo epoch at producer start; recheck before ready promotion |
| C3 bare fragment cache | CONFIRMED | key by `etag + symbolId + detail/schema`; only bare/minimal/signature cross-reindex |
| C4 ready-result cache scope | CONFIRMED | per-action policy: `never | inflightOnly | versioned | gitState` |
| P1 async/batch parse | RISKY | gate payoff on `workerFallbackStats`; fix bridge attach if degrading |
| P2/P3 boot hashing | CONFIRMED | — |
| O1 ONNX EP + threads | RISKY | fold EP/thread into `model_version`; verify q8 runs on DML |
| O2 CPU-aware width | CONFIRMED | only after O1 |
| O3 encode/add overlap | RISKY | rework single-inflight breadcrumb to multi-batch |
| O4 pre-warm daemon set | CONFIRMED | — |
| O5 lower max_length | RISKY | benchmark; `model_version` bump if vectors change |
| B1 skip warm | REFUTED → reframed | keep scan; make it non-gating, don't skip |
| B2 overlap warm+auth | RISKY | safe (no auth race); upside is modest |
| B3 double inspect | CONFIRMED | — |
| B4 dedupe boot vs queued | CONFIRMED | — |
| B5 posse-update off path | CONFIRMED | — |

## Open questions to settle with Phase-0 data
- Is the conductor bottleneck **queue-wait** (→ S1 DB split) or **op-duration** (→ 1a/1b)?
- Under a real parse storm, how often does the native thread bridge degrade to per-call spawns
  (`workerFallbackStats`)? Determines P1's real ceiling.
- Does q8 actually execute on DirectML/CoreML, or silently fall back to CPU? Determines O1's EP half.
