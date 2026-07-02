# ATLAS Review Fix Plan (2026-07-01)

Synthesis of the six-agent deep review of the memory system, ATLAS retrieval feedback,
retrieval core, executor/ledger, embeddings/warm pipeline, and the agent feedback tool
(`agent_feedback` / `get_operator_feedback` / `ack_operator_feedback`). Every HIGH was
hand-verified against source; the findings below additionally survived an adversarial
red-team pass (see verdict). Two "should be red" test suites were run and confirmed red.

## Red-team verdict

**Survived unchanged (verified static + where possible empirical):**
- Dead memory curation surface (`memory.remove`/`memory.flag` unimplemented) — parity
  suite run: RED on exactly `memory.query missing from ATLAS_TOOL_ACTIONS`.
- Stale entity-FTS tests — orchestrator suite run: RED, 3 failures (entity-FTS block
  plus an unpredicted `agent.feedback without a ledger still returns ok=true` failure
  that needs its own root-cause during rehab).
- `file.read` `jsonPathValue` redaction bypass (file-read.js:198-206).
- Operator-feedback livelock (see nuance below).
- Embedding pool defeats invalidation (resources.js wrapper close = refcount decrement;
  `invalidateConductorRetrieveResources` closes the wrapper, entry survives, reacquire
  resurrects the stale child).
- Warm truncation at 100/200 paths — red-teamed for escape hatches: live-reconciliation.js
  is telemetry-only; no chunking anywhere; freshness scan is boot-only (ParseEngine.js:1574).
- taskText displaces query (orchestrator/index.js:82) — red-teamed against
  `buildProbes`: raw query is probed only when `isLiteralSymbolName(query)`, which
  matches ONLY quoted/route literals (hygiene.js:22-25). Bare identifier queries with
  divergent taskText get zero query-derived probes. Stands.
- Per-row task-text-match `logEvent` amplification — no sampling/gating exists anywhere.
- `enforceMemoryCap` evicts most-consulted durables first (ORDER BY verified,
  memory.js:1019-1027); wall-clock decay live by default (`memoryStaleAfterDays: 180`,
  policy.js:19, no settings override found).
- Same-call prune trap in the uncommitted memory.js diff (prune at memory.js:408 has no
  exclusion for the just-upserted row; retire threshold 4).
- SideBySide preferred-mode fallback persists local vectors under remote identity
  (RemoteAtlasEmbeddingEncoder.js `#runRemoteAuthoritative`); in-process mid-warm
  fallback is BY DESIGN (atlas-embedded.js comment says "typically busy (mid-warm)") —
  the bug is only that the open path is write-capable (quarantine+rebuild-save).

**Strengthened:**
- Ledger destructive reset (schema.js:155-163): ledger.db has NO WAL pragma anywhere
  (only memory.db, embeddings keys.db, slices.db set WAL) — rollback-journal mode means
  cross-process writers block readers, so a >5s write makes probe `SQLITE_BUSY`
  realistic; catch-all treats it as corruption and deletes the DB. Also verified: reset
  connection lacks `busy_timeout`; `openEmbeddedLedger` escalates failed read-only open
  to read-write (atlas-embedded.js:565-572). The deferred read-then-write transaction
  hazard also survives with a rollback-journal mechanism (SHARED→RESERVED upgrade
  deadlock-timeout) instead of the WAL `SQLITE_BUSY_SNAPSHOT` originally described.

**Downgraded / contradictions resolved:**
- "memory.feedback writes memory.db on the reader lane, uncoordinated" (executor
  reviewer) vs "deliberate and tested" (feedback reviewer): memory.db is WAL with
  busy_timeout 5000 on every open (memory.js:121,767) — cross-lane writes are safe at
  the SQLite level. Surviving issue is SET DRIFT only (phantom `memory.remove` in
  `CONDUCTOR_TOOL_MUTATION_ACTIONS`, `memory.feedback` present in executor's
  `ATLAS_BLOCKING_ACTIONS` but absent from the conductor set), not a data hazard.
- Livelock nuance: bounded per attempt_id (a new job attempt re-delivers) and an
  operator re-nudge supersedes the stuck row (new id → deliverable, superseded row
  leaves the pending count). Still top priority in-subsystem: failure is silent, the
  signal lies, and live-channel turns burn until a human notices.

**Still needs runtime verification (not refuted, not fully proven):**
- Owner-hot `mcpJobId` stale-session fallback (deterministic-mcp-server) — repro needed.
- Reader-lane RetrievalCache same-version staleness — needs a warm that rewrites a view
  without a ledger-seq bump.
- ONNX daemon `_sharedConfig` last-writer-wins contamination — latent (settings global).

---

## Decision gates (need Mason's call before the affected workstream)

- **D1 — Memory curation surface shape.** Options: (a) extend `memory.feedback` with
  `suppress`/`flag` verdicts (no new tool surface, GC stays a deliberate verdict;
  recommended), or (b) implement real `memory.remove`/`memory.flag` actions (matches
  the parity test's and conductor set's encoded intent, but adds agent-facing surface).
  WS1 and the parity-suite rehab depend on this.
- **D2 — Memory-write secret handling:** reject vs scrub-and-warn (recommend scrub, one
  choke point in `memoryStore`, matches file-read behavior).
- **D3 — Ledger WAL:** enable `journal_mode=WAL` on ledger.db (reduces probe BUSY and
  reader blocking; on-disk mode change across processes — do after WS2.3, separately).
- **D4 — Auto-feedback attribution:** skip failed jobs entirely vs persist outcome and
  down-weight; and move origin to a filtered `tool.atlas.autofeedback` observation type
  (recommended) vs keep attributing to the job as agent work.
- **D5 — Wall-clock memory decay:** default `memoryStaleAfterDays` to 0 (doctrine:
  anchor-drift only; recommended) vs keep 180 but exclude `stale_reason='age'` from
  read-suppression and cap-eviction priority. Either way, align the module header.
- **D6 — Memories in generated context:** wire `sliceBuild` to emit `data.memories`
  (feature was designed: capContextPayload/evidenceFromMemory exist) vs delete the dead
  branch. Affects WS9.
- **D7 — repo.status `surfaceMemories`:** feed real anchors (recent/hot files) vs drop
  the advertised param.

---

## Workstreams

Sizes: S (<1h), M (half-day), L (1-2 days). Every item lands with its named test.
Test policy: targeted suites only (`node --test test/<file>`); back up the dirty tree
to scratchpad before any run (standing incident protocol).

### WS1 — Memory action surface & curation repair (after D1)
1. Implement the D1 choice; rewire `applyMemorySuppress`/`applyMemoryFlag`
   (memory-feedback.js:57,77) onto it. [M]
2. `applyMemoryCorrection`: strip `type/tags/confidence` from the store payload; check
   the removal result instead of `.catch(() => null)`; report failure honestly
   (memory-feedback.js:100-122). [S]
3. Reconcile flag reasons: CLI `contradicted` vs `MEMORY_FLAG_REASONS` (memory.js:426). [S]
4. One shared mutation-set constant consumed by `ATLAS_BLOCKING_ACTIONS`
   (AtlasToolExecutor.js:58) and `CONDUCTOR_TOOL_MUTATION_ACTIONS`
   (retrieve-runner.js:429-441); remove phantom `memory.remove`; add alias
   normalization (`normalizeActionName`) before every gate/lane check (fixes the
   `agent_feedback`-alias reader-lane bypass). [M]
5. Tests: one integration test per review action against the REAL dispatch surface;
   a parity test pinning mutation-set ≡ registered actions (kills this bug class). [M]

### WS2 — Data safety
1. `jsonPathValue`: extract from redacted content (or redact the extracted value) in
   `finishFileRead`; test asserts redaction on the field. [S]
2. Secret scrub choke point in `memoryStore` per D2 (covers agent stores, researcher
   memories, insight promotion, corrections). [M]
3. Ledger reset hardening (schema.js:142-163): narrow the probe catch to
   `SQLITE_CORRUPT`/`SQLITE_NOTADB` (BUSY → rethrow/retry); `removeSqliteFile` must
   verify deletion and abort the reset when the main file survives; `busy_timeout` on
   the reset-path connection; kill the read-only→read-write escalation in
   `openEmbeddedLedger`. [M]
4. `.immediate` on read-then-write ledger transactions (`append`, `mergeBlobParseRows`);
   Ledger constructor closes the connection on bootstrap throw (Ledger.js:72-131). [M]
5. (After D3) WAL for ledger.db. [M]

### WS3 — Operator feedback channel integrity
1. Livelock fix: `get_operator_feedback` returns rows with `ack_state='pending'`
   regardless of prior application rows (applications become pure delivery audit), so
   the signal and get can never disagree (agent-interactions.js:402-424 vs 458-490).
   Test: within-attempt re-retrieval after an unacked get. [M]
2. Ack idempotency: `UPDATE … WHERE id=? AND ack_state='pending'` inside
   `runImmediateTransaction`; zero changes → `already_acknowledged`, no re-log/notify;
   reject undelivered/superseded/expired ids (agent-interactions.js:510-583). Tests:
   double-ack, cross-job ack, superseded ack. [M]
3. Job-end reconciliation: finalize/cancel sweeps unacked `user_to_agent` guidance →
   `status='expired'` + event; `RunDisplayActions.nudge` refuses finished jobs. [M]
4. MCP transport parity: thread attempt id through MCP session boot so both transports
   share once-per-attempt delivery + audit rows (deterministic-mcp-server.js:1840-1853). [M]
5. Owner-hot hard-fail: job-scoped live-channel tools error when the hidden session
   param is missing instead of falling back to sticky `mcpJobId` (repro first — see
   needs-verification). [M]
6. Append the availability signal to ATLAS-route results on the MCP/owner path
   (currently native-tools-only, deterministic-mcp-server.js:2746-2748). [S]
7. Derive every `LIVE_CHANNEL_TOOL_NAMES` copy from the catalog's `budgetExempt`
   (tool-runtime.js:40-44, openai/grok index.js, deterministic-mcp-server.js:1816). [S]
8. Hygiene: nudge insert+supersede in one immediate txn; cap nudge body; clamp/validate
   `agent_feedback` phase/status server-side; run the trio ungated (SQLite-only) and
   append the signal outside the handler try, only for string results
   (tool-runtime.js:442-470). [M]

### WS4 — ATLAS freshness (embeddings/warm)
1. Pool invalidation API: `evictNow(key)`/generation bump on the embedding resource
   pool, called by `invalidateConductorRetrieveResources`, the reader-host `invalidate`
   op, and the atlas-embedded mirror. Test: post-warm semantic read observes new
   vectors THROUGH the pooled path. [M] ← top freshness fix
2. Warm truncation: when `clampPaths`/`mergeWarmPayload` would drop entries, clear
   `paths` and set a `force_freshness_scan` flag the ParseEngine honors beyond boot
   (atlas-warm-job.js:207, PipelineHooks.js:156-171, ParseEngine.js:1574). Test:
   >100-path payload achieves full coverage. [M]
3. Read-only `EmbeddingIndex` open mode (no quarantine, no save) for reader-lane and
   in-process-fallback opens; embeddings-gate read gets short `waitMs` (~2s) and on
   timeout dispatch runs without embedding resources (vector reports `unavailable`,
   FTS serves) instead of falling back to a write-capable in-process open
   (EmbeddingIndex.js:349-445, retrieve-runner.js:393-398, atlas-embedded.js:1399-1424). [L]
4. Cross-view prune correctness: prune against the union of live views (or refcount
   hashes); apply the content-hash liveness filter in full scope too
   (stale-tracking.js:51-61, ParseEngine.js:2657-2681). [L]
5. Reader-lane `invalidate`/`beginWrite` ops also clear that thread's RetrievalCache
   (closes the same-version staleness window cheaply). [S]

### WS5 — Ranking & feedback correctness
1. taskText: plan from `args.query`; taskText contributes re-ranking (and optionally
   extra keyword facets), never replaces the query (orchestrator/index.js:82). Test:
   divergent taskText still finds the queried symbol. [M]
2. Task-text-match observability: one aggregate event per query (counts, min/max score,
   truncated taskText) instead of per-row `logEvent` (feedback-boost.js:70-82,
   FeedbackStore.js:103-156). [S] ← quick win, large event-DB relief
3. Orchestrator degraded mode: JS fallbacks for `rrfFuse`/`tokenizeForRanking`
   (the RRF math is ~5 lines), `fallbackQueryPlan` on sync `planQuery` throw, guard +
   batch overlay `lexicalScore` (one native call, or async + memo), early-return empty
   fusion. Test: native binary unavailable → FTS results still served, `fullyDegraded`
   reporting reachable. [L]
4. Vector empty ≠ failure: `ok:true,total:0` when the backend ran; keep `index_empty`
   only when the index is known empty; fix the test pinning the mislabel
   (backends/vector.js:53-55). [S]
5. Task bonus scale: make it rank-relative or document+pin intended dominance
   (task-query-ranking.js:24,48). [S]
6. Feedback decay: `Math.exp(-Math.LN2 * ageDays / halfLifeDays)`; wire a config
   default for ranking-path decay or delete the dead option (FeedbackStore.js:36,
   dispatch.js:210-225). [S]
7. Feedback store integrity: report inserted-vs-requested counts (`recorded` honesty,
   context.js:224-247); dedupe via unique index + `INSERT OR IGNORE`; retention prune
   in a warm/GC job; `ORDER BY MAX(ts) DESC` on the grouped path; fix raw-path
   `hasMore` (context.js:266-276). [M]
8. Auto-feedback per D4: skip failed jobs (or persist outcome + weight); distinct
   filtered observation type (atlas-auto-feedback.js:79-89,189-196,
   WorkerExecutionFinalizer.js:57-63). [S]
9. `enforceMemoryCap`: `offered_count DESC` only within ephemerals
   (`CASE WHEN lifespan='ephemeral' THEN offered_count ELSE 0 END DESC`,
   memory.js:1019-1027). [S]
10. SideBySide: local fallback serves queries only — never `encodeSymbols` ingest
    (RemoteAtlasEmbeddingEncoder.js:271-278). [S]

### WS6 — Memory lifecycle completion (includes the uncommitted diff)
1. Finish the in-flight diff: same-content explicit re-assert is corroboration —
   promote to durable (mirroring `reviveMemory`) or exclude the just-written
   `memory_id` from that call's `pruneSurfacedEphemeral` (memory.js:361-408,992-1003).
   Tests: corrective reset, same-content preserve, no same-call revive/kill. [S]
2. Apply D5 (wall-clock decay default + header alignment; if age-stale stays, exclude
   `stale_reason='age'` from read-suppression and cap priority). [S]
3. Revive paths merge the fresh write's anchors (`replaceMemoryLinks`); keep
   `wrong_count` cumulative across revives (memory.js:245-330,1035-1056). [M]
4. Dedupe race: catch `SQLITE_CONSTRAINT` on the partial unique index → retry the
   dedupe/revive lookup once (memory.js:156-158,245-330). [S]
5. Batch of smalls: repo.status count scoped `repo_id AND deleted=0` (repo.js:302-312);
   `applyAnchorEvidence` missing `viewBuiltAt` keeps the memory (memory.js:1442-1443);
   align schema maxItems/maxLength with handler caps + error on invalid provided
   memoryId; policy check before `openMemoryActionDb` DDL; candidate scan limit derived
   from effective cap. [M]

### WS7 — Executor/gateway robustness
1. Structured executor error codes (`atlas_gate_timeout`, `atlas_conductor_unavailable`)
   surfaced in `_meta`; gate strike/unlock keyed on codes with the prose regexes as
   fallback (AtlasToolExecutor.js:119-139, gate.js:119-131). [M]
2. Direct-read payload: `{ ...args, action }` ordering; win32 repo-key lowercase +
   resolve (mirror sqlite-gate); write-completion clears dedupe/dispatch caches; skip
   `#rememberDedupe` for error results; cap direct-read result size
   (AtlasToolExecutor.js:239-242,442-449,605-643,668,131-138). [M]
3. usage-events: route reader-lane usage to a writable channel or count drops with a
   periodic warn; record sync-handler throws before rethrow (usage.js:77-103,
   dispatch.js:81-93,508-530). [M]
4. Smalls: async `resolveTargetBranchAsync` in `#branchForRepo`; migration
   `ensureColumn` catches duplicate-column; ScipIndexStore COALESCE display name +
   re-select on race; host-migration 001 FK pragma placement note. [M]

### WS8 — Performance batch
Forensics telemetry sampled/async (persistent-log.js sync fs per event on hot paths);
collapse the two per-warm full ANN rebuilds into one keys-diff+rebuild
(EmbeddingIndex.js:646-692); defer open-time FTS rebuild to self-repair warm
(schema.js:213-240); boot ONNX warm through `getSharedOnnxDaemon().warm()` in the
realm that encodes (RunSession.js:1888-1934); SLICE_REGISTRY LRU cap (slice.js:66);
prune-window churn guard when the 100k candidate cap is hit (stale-tracking.js:53);
headless soft-timeout auto-backgrounds (RunSession.js:1861-1865); `.tmp` sweep age/pid
check (EmbeddingIndex.js:1288-1303); onnx close-race queueing (onnx-daemon.js:228-253);
guard `saveSliceEntry` (slice-store.js). All [S] individually.

### WS9 — Dead code & test rehab
1. Rehab the red suites: parity list per D1; orchestrator entity-FTS tests rewritten
   around `feedback_fts`; root-cause the `agent.feedback without a ledger` and BM25-tie
   failures (unpredicted — may be real regressions); regenerate `memory.get` corpus
   snapshot (missing `domains`); delete dead `"memories"` branch in `normalizeEntities`. [M]
2. Apply D6 (memories-in-context) and D7 (repo.status surfaceMemories). [M or S]
3. Deletions: VERSIONED/GIT_STATE dispatch-cache policies; `AsyncEmbeddingIndex` layer
   + `closeAllPooledEmbeddingResources` (unless WS4.1 reuses it);
   `hasPendingOperatorFeedbackForJob` (or consume in WS3.3); legacy ledger
   `memories_fts`/`ensureMemoryEvidenceColumns`; insights-step0 legacy surface helpers;
   `budgetExempt` flag becomes THE source after WS3.7. [M]

## Phase ordering

- **Phase 1 — ship independently, this week:** WS2.1 (jsonPath), WS5.2 (event
  amplification), WS6.1 (finish the in-flight diff before it merges), WS2.3 (ledger
  reset), WS3.1+3.2 (livelock + ack). Small, contained, highest blast-radius relief.
- **Phase 2 — feature repair:** D1 → WS1 complete; WS4.1+4.2 (freshness); WS7.1 partly
  lands with WS1.4.
- **Phase 3 — correctness batch:** WS5 (ranking), WS3.3-3.8, WS4.3-4.5, WS2.4-2.5.
- **Phase 4 — polish:** WS6 remainder, WS7, WS8, WS9 (+D3-D7 stragglers).

Progress notes live in this file as phases land. Full per-finding evidence (with fix
sketches and complete LOW/test-gap lists) is in the six review-session reports;
the top-ten digest is in session memory (`atlas-deep-review-2026-07`).

## Progress

**2026-07-01 — Phase 1 shipped (all green on targeted suites):**
- WS2.1 `jsonPathValue` redacted via `redactJsonPathValue` (file-read.js) + 3-case test.
- WS5.2 per-row task-text `logEvent` → one aggregate summary per query
  (feedback-boost.js, `onSummary` test hook) + volume test.
- WS6.1 diff completed: same-content explicit re-assert = corroboration (revive bump +
  durable in the upsert CASE — mirrors the dedupe path), making it immune to the
  same-call prune; corrective refresh keeps the offered_count reset. 3 tests.
- WS2.3 ledger reset: corruption-only probe catch (`isSqliteCorruptionError`),
  `removeSqliteFile` returns main-file success and the reset ABORTS on failure,
  busy_timeout on all open paths, read-only open no longer escalates to read-write
  (atlas-embedded). 3 tests incl. a real win32 locked-file case.
- WS3.1 livelock: applications table is delivery AUDIT only — unacked items re-deliver
  until acked; delivery event/notify only on first delivery. WS3.2 ack idempotent
  (guarded UPDATE in immediate txn; repeats read back the recorded decision with
  `already_acknowledged`; both transports). 3 tests (re-retrieval, double-ack,
  cross-job rejection).

**2026-07-01 — Phase 2 shipped:**
- WS1/D1 (option a): `memory.feedback` verdict `suppress` = deliberate soft-delete
  (dispatcher-accepted, NOT in the agent-facing catalog enum); CLI
  suppress/flag/correct rewired onto real actions with honest results (correction
  checks its suppression); `contradicted`→`wrong` mapping; phantom `memory.remove`
  removed from the conductor mutation set; alias normalization
  (`normalizeActionName`, now exported) applied at all three gate layers
  (retrieve-runner, atlas-embedded, AtlasToolExecutor); gate sets exported + parity
  test pins no-phantoms and conductor⊆executor. Parity suite GREEN (was red).
  Corpus samples repaired (stale `type:` field, dead memory.query fixture) —
  memory.store/get snapshots are meaningful again; corpus suite GREEN (was red).
  NOTE: set-EQUALITY was deliberately not enforced — memory.feedback stays
  reader-lane-allowed by design (memory.db is WAL; red-team resolution).
- WS4.1 pool invalidation: `retire`/`retireAll` on the embedding resource pool
  (active holders defer the real close to the last release — no child leak),
  `retirePooledEmbeddingResources()` wired into `invalidateConductorRetrieveResources`
  (covers reader-host + conductor-host) and `invalidateAtlasEmbeddedResourceCache`
  (main realm). 2 pool tests.
- WS4.2 warm truncation: executor clamp overflow (main-incremental) and coalescer
  union overflow (>200) now clear hints and set `paths_truncated`; ParseEngine runs
  the freshness scan for truncated warms (not just boot). Typedef updated. Coalesce
  overflow test.

**2026-07-01 — Phase 3 shipped (validation sweep: 250 tests across 9 touched
suites, 0 fail; orchestrator suite fully green for the first time):**
- WS5.1 taskText: plan derives from the query (`query || taskText`), divergence test.
- WS5.3 orchestrator degraded mode: JS `rrfFuseJs` fallback + ≤1-backend
  short-circuit (native stays primary); JS tokenizer fallback (sync + async, not
  memoized so native quality returns with the daemon); sync/async `planQuery` →
  `fallbackQueryPlan` on throw; overlay `lexicalScore` guarded to the floor score.
- WS5.4 vector empty ≠ failure (`index_empty` only when `index.size === 0`); tests
  re-pinned to intent. WS5.5 task bonus now PROPORTIONAL (0.25 × own score ×
  overlap) — real tiebreaker semantics. WS5.6 decay uses LN2 (true half-life;
  pinned by a 0.5-at-one-half-life test). WS5.8/D4: auto-feedback only for
  SUCCEEDED jobs; origin `auto_feedback` → `tool.atlas.autofeedback`, excluded
  from agent tool feeds/counts alongside `.prefetch` (suffix list generalized).
  WS5.7 (partial): agent.feedback reports `insertedCount`/`skippedCount` and
  `recorded` reflects rows that actually landed; typedef + tests.
- WS5.9 cap eviction: `offered_count` applies to ephemerals only. WS5.10
  SideBySide: preferred-mode local fallback is queries-only (never `encodeSymbols`).
- WS3.3 job-end reconciliation: `expireUnackedOperatorFeedbackForJob` (finalizer,
  terminal statuses) + TUI refuses nudging finished jobs; test. WS3.7
  `LIVE_CHANNEL_TOOL_NAMES` now derived from tool-suites `budgetExempt` (single
  source; 4 hand-copies deleted). WS3.8 (runtime part): the trio runs ungated
  (SQLite-only — operator channel stays reachable under worktree-gate holds);
  signal append guarded (never converts success to error; string results only);
  nudge insert+supersede in one immediate txn; nudge body capped at 4000 chars.
- WS6/D5: `memoryStaleAfterDays` defaults 0 (anchor-drift owns decay; age test
  now opts in via policy). WS6.3 (partial): `wrong_count` survives same-content
  revive/re-assert (repeat-offender history; content rewrite starts clean).
  WS6.4 dedupe race: unique-index constraint → retry lookup → dedup envelope.
  WS6.5 (partial): repo.status memory count scoped (repo_id + deleted=0);
  `applyAnchorEvidence` keeps memories when built_at is unknown.
- WS2.4: Ledger constructor closes the connection on bootstrap throw
  (#bootstrap extraction); all 6 ledger/blob write transactions use
  `.immediate()`. WS7.2 (partial): direct-read payload is `{ ...args, action }`;
  win32 repo keys lowercased (gate/cache unity). (External change during the
  session: `#branchForRepo` moved to `resolveTargetBranchAsync` — WS7.4 item
  done by the other session.)
- Corpus snapshots regenerated twice, both times verified drift-by-drift
  (stale `type:` sample + dead memory.query fixture repaired; final drift is
  exactly the honesty fields + policy default).

**2026-07-01 — Continuation batch shipped (sweep: 304 tests / 0 fail / 1 skip
across 11 suites):**
- WS5.7 complete: within-batch feedback dedupe (one call = one opinion per
  symbol/signal); per-(symbol, signal) window cap (ROW_NUMBER ≤ 20) so bursts
  can't evict other symbols from the 5000-row raw scan; grouped aggregates
  `ORDER BY MAX(ts) DESC`; `limit` now means AGGREGATES on every recentFeedback
  path (raw scan uses its own cap — hasMore/pagination honest); opportunistic
  90-day retention prune (bounded 500/call, FTS triggers keep the shadow in
  sync); recordFeedback txn is `.immediate()`.
- WS7.1: executor-level failures synthesize machine codes
  (`atlas_gate_timeout`, `atlas_conductor_unavailable`) into the structured
  error block; gate classification is code-first (`atlasErrorCodeFromResultText`,
  parsed only from Error: texts) with the prose regexes as fallback —
  unavailability now unlocks instead of accruing strikes. WS7.3: reader-lane
  usage events are counted as drops (`getUsageEventDropStats` + warn-once)
  instead of silently swallowed; sync dispatch throws now record a
  `handler_threw` usage event before rethrow.
- WS6.3 complete: `mergeMemoryLinks` on all three revive paths (dedupe /
  resurrect / near-dup) — fresh anchors merge in additively and file baselines
  re-anchor to today's view (kills the resurrect→re-kill flip-flop). WS6.5
  complete: policy gate before memory.db creation; candidate scan limit derived
  from the effective cap (50k ceiling when uncapped); schema caps aligned to
  handler truncation (store 100 anchors / id 120; get/surface 500); a provided
  but invalid memoryId errors instead of silently minting a duplicate.
- WS3.4 complete: `attemptId` was already in the MCP boot payload — the child
  now reads it (boot + owner-hot re-set + observation context) and passes it to
  get/ack, giving the MCP transport the same once-per-attempt delivery + audit
  rows as embedded. WS3.6 complete: owner-side ATLAS results carry the
  operator-feedback signal (`operatorFeedbackSignalTextForJob` shared from
  tool-runtime; appended in PersistentMcpOwner._executeAtlasToolCall,
  advisory-guarded).
- WS8 partial: SLICE_REGISTRY LRU cap (256, durable resolution survives via
  slices.db); `saveSliceEntry` guarded at both build/refresh call sites;
  `.tmp` ANN sweep only removes temps >10min old (no racing a live save);
  headless boots auto-background at the ATLAS warm soft-timeout instead of
  waiting on an unreachable Enter.

**2026-07-01 — committed.** Everything above landed in three commits on main:
`69f7aeda` (phases 1-3 + phase-4 quick wins), `e5c51d5f` (WS4.3+4.5:
read-only reader opens — implementing the pool's standing "B (reader
read-only)" safety assumption — reader-lane cache invalidation, 2s embeddings
gate wait with lexical degrade), `12de18f8` (WS4.4: full-scope prunes keep
sibling-view keys via read-only mounts of main + views/warmed, abort on
unreadable sibling; liveness filter in every scope). Suites green throughout:
retrieval 145, orchestrator 36, embeddings-index 28, e2e/warm/reconcile 19,
reader-lane 12, pool 7, plus the earlier 304-test sweep. WS4 is COMPLETE —
every HIGH/MEDIUM correctness finding from the review is now fixed except the
repro-gated WS3.5.

**2026-07-01 — Phase-4 tail committed:** `d0fd7802` (ATLAS-first gate:
slice.build/context/repo.overview meaningful again — the 8/35 red gate suite
was a REAL behavioral regression, not test rot: the slimmed set silently
raised the unlock bar; suite green 35/35), `1b4d2a78` (WS8: one prune rebuild
per full warm — prune-to-view with the sibling union SUBSUMES the stale-hash
prune and is more correct than the current-view-only filter; keep-set
scan-cap churn guards; persistent telemetry buffered 64-line/250ms with
{flush:true} write-through for recovery events + read-side drain; ONNX ops
wait out closes BEFORE registering inflight; on-demand guard key carries the
scan limit), `3a0dffc8` (D7: repo.status surfaceMemories seeds real recent
anchors — pinned; VERSIONED/GIT_STATE dead cache policies deleted).

**2026-07-02 — REVIEW INITIATIVE CLOSED.** Final commits: `579a26f1` (WS3.5:
owner-hot sessionless live-channel calls refuse loudly — repro'd via a
two-call gateway test showing the session-scoped call retrieving its own
job's nudge and the sessionless call refused instead of leaking it),
`236b10bc` (D6: context.build hydrates memorySurface anchors through
memory.get, reviving the whole designed-but-dead memories branch, confidence
verified internal; D3: ledger runs in WAL — the Ledger header claimed it all
along; legacy DBs upgrade on first readwrite open, read-only opens serve WAL,
concurrency suite green), `b99f794d` (deleted the prod-dead
AsyncEmbeddingIndex/EMBEDDING_INDEX_GATE layer + the pre-v2
normalizeSurfaceMemory/nonStaleSurfaceMemories helpers along with the tests
that existed only to test them).

Every finding from the six-reviewer deep review is now FIXED except three
explicitly parked items:
- Legacy ledger memories_fts / ensureMemoryEvidenceColumns — ledger schema
  surgery; wants its own pass with a migration test.
- ONNX boot warm in the CONDUCTOR realm — needs a conductor protocol warm op;
  the current boot warm only pre-heats the OS page cache.
- FTS count-diff rebuild at ledger open — severity dropped materially now
  that 90-day feedback retention bounds the scanned table; revisit only if
  boot profiles still show it.
