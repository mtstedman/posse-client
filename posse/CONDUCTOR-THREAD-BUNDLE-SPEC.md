# Conductor Thread Bundle — Spec

**Status:** approved direction (Mason, 2026-06-12) · v0 implemented (2026-06-12) · v1/v2 not started
**Owner files:** `lib/domains/atlas/functions/v2/parse/conductor.js`, `conductor-host.mjs`, `lib/domains/atlas/classes/v2/ParseEngine.js`, `lib/classes/tools/daemon/supervisor.js`
**Relates to:** `MIGRATION-CUTOVER-PLAN.md` (daemon re-architecture), per-layer readiness batch (`144764e7`)

## Problem (observed 2026-06-12)

The Atlas-Conductor is one worker thread that both **routes and executes**. A warm
occupies its event loop with long synchronous sections (SCIP ingest: one 19–26s
transaction measured on a 713-doc index; view merge; tree-sitter parse batches;
500ms sync `.scip` polls at ~80ms each). Since `atlas_embedded_dispatch=conductor`
(2026-06-11) routed retrieval into the same thread, reads queue behind those sync
sections at the **thread** level — gates never see them.

Measured causal chain, all from one morning's logs:

```
warm churn → conductor loop saturated → symbol.search 105,372ms
→ atlas_handoff_prefetch_timeout_ms (60s) exceeded → handoff marks ATLAS failed
→ job downgraded to fallback session WITHOUT posse gateway write tools
→ contract still references mcp__posse_gateway__tools_edit_file → job blocks
```

Gate policy cannot fix this: `ProtectedAssetGate` read-priority only reorders
tasks the loop gets to schedule. Nothing preempts a synchronous function.

## Design principle

Same invariant as the SCIP pipeline, lifted one level:
**work fans out, mutation serializes.** The conductor conducts — it never executes.

## Target architecture

Conductor = router over a supervised thread bundle:

| Lane | Count | Owns | Runs |
|---|---|---|---|
| **Writer** | exactly 1 | the ONLY ledger/view write handles (SQLite handles are thread-bound; single-writer rule is real) | ingest, merge/zip, path deltas — the existing `dbWrite` semantics move INTO this lane |
| **Reader** | N | own lazy WAL read-only connections each | retrieve / prefetch ops, least-busy routing. WAL = last-committed snapshots concurrent with the writer ("qualified reads" for free, permanently) |
| **Work** | pool, cap `min(cores − 2, 6)` | nothing durable | parse batches, SCIP stage babysitting (children are processes anyway), fileset hashing, plan resolution; results stream to the writer lane |
| **Conductor thread** | 1 | routing, backpressure, lifecycle | zero execution |

Existing primitives to build on (do NOT reinvent):
- `DaemonSupervisor` (`lib/classes/tools/daemon/supervisor.js`, landed `144764e7`) — registry/lifecycle for bundle members, keyed (kind, identity).
- `Daemon` + `ThreadTransport` per lane; nested delegation already proven (conductor's nested ONNX daemon).
- `ParseSemaphore` / `KeyedAsyncGate` / `ProtectedAssetGate` for in-lane ordering.

## Phases

### v0 — reader lane (small diff; kills the starvation NOW) — IMPLEMENTED 2026-06-12
- Keep warm execution where it is (that thread becomes the de-facto writer lane).
- Move `retrieve` dispatch to ONE reader-lane thread with its own WAL read connections.
- Routing hint that already exists: `isConductorIndexingInFlight()`.
- Acceptance: `symbol.search` p95 < 2s while a full warm runs; handoff prefetch
  never exceeds its 60s budget due to warm activity; the downgrade→write-tools
  block (job #1114 class) cannot reproduce under warm churn.

As built:
- `reader-host.mjs` — allowlisted read-only lane (`retrieve`/`invalidate`/
  `info`/`close`); any write op fails loudly. Lazy spawn on first retrieve.
- Routing is ALWAYS-reader, not hint-based: hint routing would bifurcate the
  embedding-resource cache across two threads and cold-start the reader
  exactly when a warm begins. `isConductorIndexingInFlight()` keeps its
  existing transient-retry role only.
- Cross-lane invalidation: the writer host's in-thread ANN-cache invalidation
  cannot reach the reader, so the conductor client sends the reader an
  `invalidate` op after every warm/merge (short fuse, best effort).
- Known cost: the reader's nested ONNX encoder daemon duplicates the writer's
  (per-thread module graphs) — second model instance when semantic retrieval
  is used. Unify at v2 process promotion.
- Regression guard: `test/test-atlas-v2-reader-lane.test.js` — a test-only
  `debug.block` op occupies the writer's loop synchronously while a retrieve
  must complete in ~1 unblocked baseline (self-calibrating threshold).
- Field acceptance (p95 during a real warm on mike) still to be observed —
  reader spawn logs `Conductor reader lane spawned`, counters via `readerInfo`.

### v1 — work lanes (requires ParseEngine decomposition; the real surgery)
- Split `ParseEngine.handleWarmJob`: fan-out tasks (parse, stage, hash) dispatch
  to work lanes; ONLY mutations run on the writer lane.
- This subsumes the deferred "chunk the 19–26s ingest transaction" item — done
  properly (lane handoff) instead of yields inside a monolith.
- Acceptance: writer-lane occupancy during a warm drops to mutation time only;
  dispatch-hold windows no longer approach the 900s failsafe.

### v2 — process promotion (orthogonal; do when crash isolation earns it)
- Promote the whole bundle to a child process under the supervisor
  (writer thread + reader/work threads inside it).
- Buys crash isolation (native tree-sitter/ONNX crashes), memory isolation,
  clean kill semantics. NOT needed for the latency fix — do not block v0/v1 on it.

## Adjacent open items this interacts with (do not lose)

1. **Warm-trigger churn**: warms re-trigger during research/planner with NO
   commits and complete layers. Distinguish via logs: WI-warm readiness-bar
   replay (cosmetic — `warmReadinessStarted` resets the bar per warm) vs
   `atlas_v2_auto_refresh_stale` etag self-loop vs `atlas_drift_check`. Also:
   coalesce stacked post-commit warms to latest head (supersede at enqueue).
2. **Contract/surface invariant**: a downgraded session must never carry a
   full-surface contract — recompile contract against the tools the fallback
   session actually mounts. (v0 removes the common trigger; the invariant
   should exist regardless.)
3. **ONNX preboot choice** (memory: `onnx-preboot-choice-regression`): readiness
   boot auto-skips to TUI; restore the user's wait/background choice at the
   TUI handoff (`run-session.js`, old `setBootEnterAction` plumbing reusable).
4. **Phase 2 embeddings** (gates its own coding): instrumented warm on mike →
   57ms split / pool utilization / q8 batch scaling; then corpus cut (drop SCIP
   `var` locals, ~4.3×), encode pipelining, serve-old-index-during-model-rebuild.
5. **`memory.surface` logged as `#?`** — fires outside job context somewhere;
   unattributed calls escape per-job budgets/dedupe.

## Done this session (context for the next one)

- SCIP restage route fixed end-to-end (`161ece34`): full-index timeouts +
  duration stretch, failure backoff, marker-gated indexer selection, intake
  drift detection (`stale_scip`), total-failure rows retry, account.db test
  isolation. Rust parity in encoder `ff86deb` (markers + hash), binaries
  rebuilt/deployed, all repos pushed, posse-client synced (`bf523358`).
- TUI: ATLAS bar no longer pins at 97% through the encode pass (`23fd974d`).
