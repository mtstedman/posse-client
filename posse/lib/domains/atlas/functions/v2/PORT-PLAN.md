# ATLAS v2 — Posse-Native Port Plan

Living record for the posse-native ATLAS implementation. Cutover is complete:
the external sidecar/runtime path has been removed, and the public integration
surface now targets the in-tree v2 ledger/view backend.

---

## 1. Why we're doing this

Posse's worktree model creates `.posse-worktrees/wi-{id}/` for each work
item. The old external integration keyed symbols by **absolute filesystem
paths**, so every worktree generated its own index even
though 99% of the bytes are identical to main. The locking pain that
shows up in `test-atlas-seed-locks.test.js` is the symptom — concurrent
workers fighting a single shared writer lock on a kuzu graph DB while
re-doing work that should have been shared.

Beyond the lock contention, ATLAS today is an external MCP server with no
visibility into posse's pipeline. It can't know that "researcher just
finished, a dev job is about to spawn a worktree on a branch off main"
— so it can't pre-warm. Embedding it gives us that signal for free.

**End state:** ATLAS is part of posse. No MCP server boundary, no shared
writer lock, no per-worktree re-indexing of unchanged code, and pipeline
events drive what gets warmed and when.

---

## 2. Load-bearing principles

These are the decisions that everything else falls out of. They are
**locked** at Phase 0.5 and committed as comments in
`contracts/schemas.js`. Changing one requires an RFC, not a contract
bump.

### 2.1 — Content-addressed symbol identity

Every symbol is keyed by `(content_hash, local_id)` where
`content_hash` is the SHA-256 of the file bytes and `local_id` is a
zero-based index assigned during parse. Same bytes parsed in two
different worktrees produce the same identities. This is what makes the
parsed result **shareable** without coordination.

### 2.2 — File-level ledger, symbol-level derivation

The ledger is append-only at *file* granularity — one row per changed
file per branch. Symbol-level diffs are computed at view-build time by
comparing `blob_symbols(before)` against `blob_symbols(after)`. Keeps
the append rate low and lets one commit produce one row per file
regardless of how many symbols moved inside it.

### 2.3 — view-local `global_id`

The view layer assigns `global_id` autoincrement integers for fast
denormalized queries. **`global_id` is local to the owning view DB and
never persisted across views.** Stable cross-view identity is always
`(content_hash, local_id)`.

### 2.4 — Repo-relative paths everywhere

Forward slashes, no `./` prefix, no trailing `/`, never absolute, never
`..`, never empty. Matches `normalizeRepoPath()` already used in
`worktree-lifecycle.js`. Producers normalize at the boundary; consumers
may assume the form.

### 2.5 — Ledger is truth, views are caches

One ledger DB per repo at `<repo>/.posse/atlas/ledger.db`. One view DB
per consumer (worktree or warmed slot). **Views can always be rebuilt
from the ledger** — if anything looks wrong, blow it away and replay.

### 2.6 — Module path

`lib/domains/atlas/functions/v2/...` for stateless helpers and contracts.
`lib/domains/atlas/classes/v2/...` for stateful classes. No other path is
permitted. Matches posse's two-tree boundary (CLAUDE.md).

---

## 3. Architecture

### 3.1 — Storage layout

```
<repo>/.posse/atlas/
├── ledger.db                       Single source of truth. Append-only.
└── views/
    ├── main.view.db                Always-warm view of main, maintained by warmer.
    └── warmed/
        └── wi-{id}.view.db         Pre-warmed for upcoming dev jobs.

<repo>/.posse-worktrees/wi-{id}/
└── .posse/atlas/view.db              The mounted view the worker reads from.
                                    Renamed in from warmed/, or copied from main.
```

### 3.2 — Ledger semantics

- One writer at a time globally (better-sqlite3 serializes; WAL allows
  concurrent readers). Workers append only to their **own branch's
  partition**, so semantically there is no cross-worktree write
  contention.
- Branches are records with `(name, parent_branch, parent_seq)`.
  Forking is metadata-only — no data is copied. Reads walk the lineage.
- Merge-to-main replays the child branch's partition onto main's
  partition; each replayed delta gets a fresh seq on main.

### 3.3 — View semantics

- Materialized projection of `(branch, ledger_seq)`. Denormalized for
  read speed — every symbol row has its name, kind, and path inline.
- FTS5 over symbol names + qualified names for `symbol.search`.
- Edges resolved or unresolved; unresolved edges carry `to_name` so a
  newly-declared symbol can rebind latent references.
- Trivially rebuildable: drop the file and replay from the ledger.

### 3.4 — Warming strategy

**Two levels** that collapse to one primitive: `build_view(at_seq, hint?)`.

**Passive — "main is always hot":**
A background job keeps `main.view.db` current with main. New worktree
that branches from main = `cp main.view.db wi-{id}.view.db`. Sub-second
filesystem copy on any modern disk. Eliminates most cold-start cost.

**Active — "researcher just told us what's coming":**
On `ATLAS_RESEARCH_COMPLETE`, enqueue a low-priority `atlas_warm` job that:
1. Stamps the current main ledger seq for consistency.
2. Pre-warms the symbol neighborhood for files in
   `context/wi-{id}/planner/full/` (callers, callees, type hierarchies,
   blast-radius 1-2 hops).
3. Parks the result at `views/warmed/wi-{id}.view.db`.

When the dev job leases the worktree, the warmer atomically renames the
warmed view into place. If warming hasn't completed, the worker falls
back to the cp-from-main path. Warming is **strictly best-effort
prefetch** — never blocks pipeline work.

### 3.5 — Pipeline integration via transactional outbox

Same DB transaction that records each pipeline state change:
1. Writes a row to the existing `events` table (`actor_type='atlas'`,
   `event_type='atlas.dev_committed'`, etc.) for audit/observability.
2. Enqueues an `atlas_warm` job into `jobs` with the appropriate payload.

Restarts can't drop notifications because the job survives in the
queue. The warmer is just a posse role — it gets retry, dead-letter,
telemetry, and the entire scheduler infrastructure for free.

### 3.6 — `atlas_warm` job

| Property | Value |
|---|---|
| `job_type` | `atlas_warm` |
| `assessable` | false |
| `mutating` | false |
| `escalating` | false |
| `max_attempts` | 1 (fail-silent; re-emission re-enqueues) |
| `max_runtime_ms` | 60_000 |
| `priority` | low |
| `work_item_id` | nullable (main-* purpose has no WI) |
| `provider` / `model_*` | null (not an LLM call) |

Purposes: `wi` (per-WI warming from researcher hint),
`main-incremental` (reindex paths changed since last main warm),
`main-full` (full reindex; rare, admin-triggered).

### 3.7 — Public tool surface (43 actions)

Frozen at Phase 0.5 in `contracts/tool-params.js` and
`contracts/tool-results.js`. Mirrors the existing posse
`ATLAS_TOOL_DEFS` and the atlas-mcp gateway schemas. Bumping
`ATLAS_TOOL_RESULT_SCHEMA_VERSION` is required for any incompatible
change.

| Namespace | Actions |
|---|---|
| `repo.*` | `status`, `overview` |
| `symbol.*` | `search`, `getCard` |
| `slice.*` | `build`, `refresh`, `spillover.get` |
| `code.*` | `getSkeleton`, `getHotPath`, `needWindow` |
| (top-level) | `context`, `agent.feedback`, `delta.get`, `pr.risk.analyze`, `pr.risk`, `file.read` |

---

## 4. Phase 0 + 0.5 — Contracts (SHIPPED)

Committed at `f84ea98`. Lives under
`lib/domains/atlas/functions/v2/contracts/`:

| File | Purpose |
|---|---|
| `schemas.js` | `SymbolRow`, `EdgeRow`, `LedgerEntry`, `BranchRecord`, `ViewMeta`, `ParseResult` |
| `api.js` | `Ledger`, `View`, `ViewQuery`, `ViewBuilder`, `ParserAdapter`, `Indexer` |
| `events.js` | `ATLAS_EVENTS` constants + `AtlasEventPayload` per-event typedefs + `AtlasOutboxRow` |
| `jobs.js` | `AtlasWarmJobPayload`, `AtlasWarmJobResult`, `ATLAS_WARM_JOB_POLICY` |
| `tool-params.js` | Current tool input typedefs + `ATLAS_TOOL_ACTIONS` + `ToolCall` discriminated union |
| `tool-results.js` | Current tool result typedefs + `ToolResultEnvelope` + `AnyToolResult` discriminated union |
| `embeddings.js` | `EmbeddingRow`, `EmbeddingHit`, `EmbeddingIndex`, `EmbeddingEncoder` |
| `ddl/ledger.sql` | Ledger DB schema (blobs, blob_symbols, blob_edges, branches, symbol_deltas, interning tables) |
| `ddl/view.sql` | View DB schema (path_to_blob, symbols, edges, symbols_fts + sync triggers) |
| `ddl/index.js` | DDL loader + `LEDGER_SCHEMA_VERSION` / `VIEW_SCHEMA_VERSION` |
| `ddl/host-migrations/001-add-atlas-warm-job-type.sql` | jobs CHECK adds `atlas_warm` + work_item_id becomes nullable |
| `ddl/host-migrations/002-add-atlas-actor-type.sql` | events.actor_type CHECK adds `atlas` |
| `ddl/host-migrations/index.js` | `HOST_MIGRATIONS` ordered array |
| `index.js` | Barrel + Phase 1 conventions (`@ts-check` requirement) |

**Verified end-to-end:**

- `npm run typecheck` passes.
- Both host migrations apply cleanly against current `schema.sql`.
- Ledger + view DDL coexist with the migrated host schema.
- Pre-state correctly rejects `atlas_warm` job_type, NULL `work_item_id`,
  and `'atlas'` actor_type; post-state accepts all three and still
  rejects unknown values.
- All 8 jobs indexes and 5 events indexes recreated.

---

## 5. Phase 1 — Parallel workstreams

Each workstream has its own posse work item, its own branch under
`atlas-v2/*` (NOT `posse/*` — that namespace is for runtime WI
branches), and merges into a shared `atlas-v2` integration branch. The
integration branch lands on `main` only after Phase 3 cutover.

Every workstream's first commit should be `// @ts-check` headers on
every new file in its scope, plus contract typedef imports. This forces
the conformance check from day 1.

### Workstream A — Ledger ⭐ (start first)

**Owns:**
- `lib/domains/atlas/classes/v2/Ledger.js`
- `lib/domains/atlas/functions/v2/ledger/append.js`
- `lib/domains/atlas/functions/v2/ledger/read.js`
- `lib/domains/atlas/functions/v2/ledger/fork.js`
- `lib/domains/atlas/functions/v2/ledger/partition.js`
- Host migration application mechanism (see Open Question 2).

**Depends on:** Phase 0/0.5 schemas + DDL only.

**Tests:** unit tests with synthetic deltas; concurrent-writer-per-branch
stress test (the thing failing today); the eventual replacement for
`test-atlas-seed-locks.test.js`.

**Effort:** 4-5 days.

**Deliverable:** `<repo>/.posse/atlas/ledger.db` openable; append, tail,
fork, replay-partition all working; concurrent append on different
branches does not contend semantically.

### Workstream B — View builder & reader

**Owns:**
- `lib/domains/atlas/classes/v2/View.js`
- `lib/domains/atlas/classes/v2/ViewBuilder.js`
- `lib/domains/atlas/functions/v2/view/build.js`
- `lib/domains/atlas/functions/v2/view/apply.js`
- `lib/domains/atlas/functions/v2/view/query.js`

**Depends on:** Phase 0/0.5 contracts. Uses fixture ledger entries during
dev — no hard dep on Workstream A's implementation.

**Tests:** hand-crafted ledger fixtures → view DB → assert query results.
FTS5 search, callers/callees, `unresolvedReferencesTo`, slice,
blastRadius.

**Effort:** 4-5 days.

**Deliverable:** any caller can `View.mount(path).query.findSymbol("foo")`
and the result is correct.

### Workstream C — Parser adapter

**Owns:**
- `lib/domains/atlas/functions/v2/parser/adapter.js`
- `lib/domains/atlas/functions/v2/parser/normalize.js`
- `lib/domains/atlas/functions/v2/parser/languages/` — per-language extractors.
- Language-specific dispatchers for ts, js, py, go, rs, java, cs, cpp, c, php, kt, sh.

**Depends on:** Phase 0/0.5 `SymbolRow` / `EdgeRow` / `ParseResult`
shapes only.

**Key task:** rewrite the path-keying layer so every symbol/edge is
keyed by canonical repo-relative path, not absolute. The path-rewriting
is the load-bearing change.

**Implementation reality (shipped):** the per-language extractors are now
tree-sitter-backed through `parser/treesitter/spec-*.js`. The remaining
gap is per-spec depth and parity with atlas-mcp's richer adapters, not a
regex-to-AST migration. The `extract()` signature remains the swap-in seam:
each language file exposes `extract({ source, content_hash, repo_rel_path })`
without touching the adapter or any consumer. Current depth caveats are
documented in v2.1 follow-ups:
  - Call, import, and type edges are language-specific and still need
    parity hardening in several specs.
  - Class-method `parent_local_id` wiring is per-language; see the
    tree-sitter spec headers for current depth.

**Tests:** per-language smoke fixtures asserting expected symbol names
+ key edges. Golden snapshots locked in `test/fixtures/atlas-v2-corpus/`
(self-snapshots; atlas-mcp parity is gated on Phase 3 shadow mode per
§7 §3.1).

**Effort:** Per-spec parity hardening (v2.1): 4-6 days.

**Deliverable:** `parseFile({ absPath, repoRoot })` returns
`ParseResult` with all paths in canonical form; same input → same
output regardless of where the repo is mounted. ✓ Shipped.

### Workstream D — Retrieval port

**Owns:**
- `lib/domains/atlas/functions/v2/retrieval/search.js`
- `lib/domains/atlas/functions/v2/retrieval/slice.js`
- `lib/domains/atlas/functions/v2/retrieval/blast-radius.js`
- `lib/domains/atlas/functions/v2/retrieval/rank.js`
- Per-tool query dispatch for the 16 frozen actions.

**Depends on:** Phase 0/0.5 tool param/result contracts + Workstream B's
View query API.

**Tests:** parity tests against existing atlas-mcp retrieval — fixture
repo, same query, compare results. Diffs flagged as either port bugs or
acceptable drift. Tolerance documented per-tool.

**Effort:** 5-7 days.

**Deliverable:** retrieval surface ≥95% parity with atlas-mcp output on
fixture corpus.

### Workstream E — Pipeline integration

**Owns:**
- `lib/domains/atlas/classes/v2/PipelineHooks.js`
- Edits to `lib/domains/worker/functions/helpers/worktree-lifecycle.js`
  (mount/unmount view at worktree create/destroy).
- Edits to `lib/domains/worker/classes/Worker.js` (commit emission around
  the existing ATLAS kick points near lines 1440 and 2308; add
  `atlas_warm` to `_dispatch` and `_workerTypeFor`).
- Edits to `lib/domains/cli/functions/git-workflows.js` (merge emission
  around line 893).
- New role: `lib/domains/worker/classes/roles/atlas-warm.js` (`AtlasWarmRole`).
- Registration in `lib/domains/worker/classes/role-classes.js`.
- Updates to `lib/domains/worker/functions/helpers/job-type-sets.js`
  (NOT in `ASSESSABLE_JOB_TYPES`, NOT in `MUTATING_JOB_TYPES`).
- Touch `lib/domains/integrations/functions/atlas-post-commit.js` (or its
  successor) so commit-hook reindexing emits via the outbox.

**Depends on:** Phase 0/0.5 event names + view-mount API stub. Implements
the outbox-write side of each emission point. The warmer side (consumer)
is Workstream F's domain.

**Tests:** posse integration tests asserting events fire in the right
order across a synthetic WI lifecycle. Pipeline tests should pass even
when the ATLAS backend is fully stubbed.

**Effort:** 3-4 days.

**Deliverable:** every pipeline event fires with the correct payload;
flipping `atlas_v2=true` swaps between old and new with no
role-handler changes.

### Workstream F — CLI & observability

**Owns:**
- `lib/domains/cli/functions/commands/atlas-v2.js` (`status`, `rebuild`,
  `ledger tail`, `view info`, `warm-now`, `purge-views`).
- Registration in `lib/domains/cli/functions/command-registry.js` AND
  dispatch/help wiring in `lib/domains/cli/functions/orchestrator-app.js`
  (around line 2997 — the registry alone is not enough).
- Metrics: ledger size, view freshness, warmer queue depth.

**Depends on:** Phase 0/0.5 API stubs.

**Effort:** 2-3 days.

**Deliverable:** operator can observe and intervene without touching
code; `posse atlas-v2 status` is the single inspection entry point.

### Workstream G — Compatibility shim

**Owns:**
- `lib/domains/integrations/functions/atlas.js`

**Depends on:** Phase 0/0.5 view-read API stub.

**Builds:** exposes the existing
`lib/domains/integrations/functions/atlas.js` exported surface (everything
that `worktree-lifecycle.js` and the role handlers currently call) but
routes to new ATLAS when `atlas_v2=true`. **Critical:** this is what
lets the rest of posse keep compiling and testing throughout Phase 1.

**Tests:** every existing ATLAS test in `test/` runs against the shim
with the flag flipped. Most will fail because backend is stubbed —
that's fine, the shim is structurally correct.

**Effort:** 3-4 days.

**Deliverable:** `atlas_v2=true npm test` runs (with expected
backend-stub failures).

### Workstream H — Embeddings

**Owns:**
- `lib/domains/atlas/classes/v2/EmbeddingIndex.js`
- `lib/domains/atlas/classes/v2/EmbeddingEncoder.js`
- `lib/domains/atlas/functions/v2/embeddings/ingest.js`
- `lib/domains/atlas/functions/v2/embeddings/search.js`
- Integration with Workstream D's `symbol.search` when `semantic=true`.

**Depends on:** Phase 0/0.5 embedding contracts.

**First sub-task — library choice.** rules.md requires explicit user
discussion before adding a new npm dependency. Candidates:
- `hnswlib-node` — common, native, well-tested, but Windows native
  builds can be fragile.
- `usearch` — newer, native, faster install, smaller surface.
- Pure-JS HNSW — fully portable, slower; viable for repos < 100k symbols.

For the encoder: similar question — local (`@xenova/transformers` /
ONNX runtime) vs remote API. Probably defer local-encoder until v2.1
and start with a remote-API encoder behind a simple adapter.

**Effort:** 4-6 days once library is chosen.

**Deliverable:** `symbol.search` with `semantic=true` returns
reranked results; new embedding rows ingested as views are built.

---

## 6. Phase 2 — Integration (1-2 engineers, 3-5 days)

### 2.1 — Warmer daemon

**Files:** `lib/domains/atlas/classes/v2/Warmer.js` + scheduler hooks in
`lib/domains/scheduler/classes/Scheduler.js`.

**Depends on:** A + B + C + E.

**Wiring:**

| Event | Action |
|---|---|
| `ATLAS_MAIN_ADVANCED` | enqueue incremental main reindex job |
| `ATLAS_RESEARCH_COMPLETE` | enqueue `atlas_warm(purpose=wi)` at low priority |
| `ATLAS_DEV_LEASED` | atomically rename warmed view into worktree path; else fork from main |
| `ATLAS_DEV_COMMITTED` | parse changed files, append ledger entries, incremental-apply to live view |
| `ATLAS_MERGED_TO_MAIN` | replay branch partition onto main; dispose WI view |
| `ATLAS_WI_CLEANUP` | delete WI view file; ledger partition stays for audit |

**Tests:** end-to-end WI lifecycle — submit WI, advance through
pipeline, assert correct view files exist with correct ledger
positions at each stage.

### 2.2 — Shadow mode

Removed during cutover. Historical `atlas_v2=shadow` and `preferred` values now
normalize to v2-on behavior; there is no dual-backend execution path.

### 2.3 — End-to-end smoke

**File:** `test/test-atlas-v2-e2e.test.js`.

Submits a small fixture repo through `add → research → plan → dev (no-op)
→ commit → merge`, asserts ledger and views end in expected shape.

### 2.4 — v2 concurrency tests (replaces seed-locks)

**File:** `test/test-atlas-v2-concurrency.test.js`.

Replaces `test-atlas-seed-locks.test.js`. The old shared-writer-lock
problem is gone, but v2 still has concurrency surface that needs
coverage:

- WAL writer serialization under burst append.
- Branch-partition independence (writes to different branches do not
  block each other semantically).
- Atomic view rename under live readers (warmer renames a view file
  while a worker has it mounted).
- FTS5 sync trigger correctness under concurrent inserts.

**Deletion of `test-atlas-seed-locks.test.js` is gated on this test
landing first.** No exceptions.

---

## 7. Phase 3 — Cutover

**3.1 Shadow burn-in.** Complete.

**3.2 Authority swap.** Complete. `atlas_v2=on` is the normal authoritative
mode; `required` keeps fail-closed behavior.

**3.3 Delete.** Complete for the integration/runtime/class stubs. The remaining
`lib/domains/atlas/classes/v2` and `lib/domains/atlas/functions/v2` trees are the native
implementation.

---

## 8. Dependency graph

```
            ┌─────────────┐
            │  Phase 0/0.5│  (shipped: f84ea98)
            │  Contracts  │
            └──────┬──────┘
        ┌─────────┼─────────┬─────────┬────────┬────────┬────────┬────────┐
        ▼         ▼         ▼         ▼        ▼        ▼        ▼        ▼
       [A]       [B]       [C]       [D]      [E]      [F]      [G]      [H]
     Ledger    View     Parser    Retrieval Pipeline  CLI     Shim   Embeddings
        │         │         │         │        │        │        │        │
        └────┬────┘         │         │        │        │        │        │
             │              │         │        │        │        │        │
             └──────┬───────┘         │        │        │        │        │
                    │                 │        │        │        │        │
                    ▼                 │        │        │        │        │
              [2.1 Warmer]◀───────────┘        │        │        │        │
                    │                          │        │        │        │
                    └────────────┬─────────────┘        │        │        │
                                 ▼                      │        │        │
                          [2.2 Shadow]◀─────────────────┴────────┴────────┘
                                 │
                                 ▼
                          [2.3 E2E smoke] + [2.4 v2 concurrency]
                                 │
                                 ▼
                          [Phase 3 Cutover]
```

**Critical path:** Phase 0/0.5 → A → 2.1 → 2.2 → 2.3/2.4 → 3.
Everything else is slack. C (parser) is the unknown — strongest hands,
starts day 1 of Phase 1.

---

## 9. Suggested team allocation

| Engineer | Phase 0/0.5 | Phase 1 (parallel) | Phase 2 |
|---|---|---|---|
| E1 (senior) | Owned | A (Ledger), then 2.1 Warmer | Integration lead |
| E2 | Reviewed | B (View) + D (Retrieval) | 2.3 E2E |
| E3 | Reviewed | C (Parser) — biggest unknown | 2.2 Shadow |
| E4 | — | E (Pipeline) + G (Shim) + F (CLI) | Phase 3 cutover lead |
| E5 (optional) | — | H (Embeddings) | — |

**Wall-clock estimate:** 3-4 weeks to flag-flip, +1-2 weeks burn-in,
+a few days to delete. **~5-6 weeks total** with the team above. With
one engineer, roughly double — call it 10-12 weeks but the same
workflow shape.

---

## 10. Open questions / pending decisions

These need owners and answers before or during Phase 1.

1. **Embedding library choice (Workstream H, blocking that workstream).**
   `hnswlib-node` vs `usearch` vs pure-JS. rules.md requires explicit
   user discussion before adding any native npm dependency.

2. **Host-migration application mechanism (Workstream A, blocking
   migration 001/002 actually running).** Options:
   - (a) Embed end-state schema directly into `schema.sql` and bump
     a sentinel.
   - (b) Add a one-shot migration runner that detects old CHECK via
     `sqlite_master` and runs idempotently.
   - (c) Manual one-time fixup documented for existing installs.

3. **Embedding encoder strategy (Workstream H).** Local (transformers.js
   / ONNX) vs remote API behind an adapter. Defer local to v2.1?

4. **Fixture corpus for Workstream D parity tests.** Need an actual
   small repo picked before Phase 1 starts so retrieval has something
   to validate against. Suggest a posse-internal fixture or a small
   public repo with diverse languages.

5. **Shadow mode result diff retention.** How long do we keep the diff
   logs? Where do they live? Probably under
   `<repo>/.posse/atlas/shadow-diffs/` with rotation.

6. **Future issue: HTML/CSS indexing.** Current v2 parity target matches
   atlas-mcp, which treats HTML/CSS as non-indexed files available through
   file reads rather than first-class symbol graph inputs. Revisit after
   cutover with a lightweight extractor for HTML ids, classes, forms,
   scripts, links, CSS selectors, custom properties, media queries, and
   cross edges from JS selectors/fetches and PHP endpoints. This is
   especially useful for web-heavy repos like `gov-notice`, but should
   stay out of the current critical path.

---

## 11. References

- Commit `f84ea98` — Phase 0 + 0.5 contracts.
- `lib/domains/atlas/functions/v2/contracts/` — all locked typedefs, DDL, and
  constants.
- `posse/CLAUDE.md` — repo-wide architecture and two-tree boundary.
- `posse/claude/rules/rules.md` — coding rules including no-new-deps
  and ATLAS design rules.
- `posse/schema.sql` — host schema; the migrations target this.
- `atlas-mcp/src/gateway/schemas.ts` — authoritative source for tool
  param shapes (mirrored in `tool-params.js`).
- `posse/lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js`
  — current ATLAS tool surface posse consumers depend on.
