# ATLAS Effectiveness Assessment — Codebase Navigation, Token Savings, Context

**Date:** 2026-07-02
**Repos under test:** `C:\development\claude\mike` (PHP + Python stock screener, 404 indexed files / 11,363 symbols) and `C:\development\claude\streaming` (PHP + TypeScript live-streaming platform, 243 indexed files / 4,609 symbols)
**Method:** three independent evidence streams — (1) mining the real orchestrator + ATLAS databases in both repos, (2) a controlled six-arm A/B (three navigation work items × {ATLAS-only, grep/Read-only}), (3) hands-on manual probing of every ATLAS retrieval tool.
**Model:** Claude Fable 5 for all agents, both arms, read-only.

---

## TL;DR (the honest headline)

- **Token savings: not demonstrated — the opposite.** In the controlled A/B, the ATLAS arm cost **+18% to +41% more tokens** than the plain grep/Read arm on the same task (aggregate **+29%**). Production telemetry shows agent contexts of **540k–800k input tokens** whether or not ATLAS is in play. ATLAS does **not** shrink context; it changes *what is in it*.
- **Navigation quality: genuinely good in two specific modes, with two real traps.** Semantic `symbol.search` reliably ranks the right symbol first across languages with zero config, and `symbol.overview` call-graph is *more precise than grep* (it excludes the definition and comment hits). But `code.lens` is AST-only and **silently misses string literals** — a real hazard in the procedural / `if ($action === '…')` PHP both repos are built on — and for *exhaustive enumeration* tasks you still read every file, so ATLAS layers cost on top of the reads.
- **Context improvement: the real mechanism is the handoff *prefetch*, which my A/B could not exercise.** The designed value is a warm, cached, task-scoped context (`tree.scope` + `memory.surface` + slice) seeded into the prompt *before the agent's first turn*. ~~Rated "relevant" 78%/92% by the agents' own feedback~~ — **RED-TEAM CORRECTION (2026-07-02): that number is produced by a pre-run system heuristic, not agent feedback** (see addendum, finding R1). Prefetch relevance has never actually been measured. My A/B tested ATLAS in its **weakest** mode (manual mid-task pull), so these numbers bound the floor — but the prefetch ceiling is currently unmeasured, not "78–92%."
- **Net:** ATLAS earns its keep as a *push-time context seeder* and a *structural query engine* (symbols, call graphs, task-scoped trees). It does **not** currently earn its keep as a token-reduction layer, and the "token savings" framing should be dropped or heavily qualified.

---

## 1. Controlled A/B: three work items, ATLAS vs. baseline

Each work item was run twice with identical prompts and the same model, differing only in the navigation policy. ATLAS arms were **forbidden grep/Glob** and pushed to the ATLAS index; baseline arms used **only Grep/Glob/Read**. Both arms were graded against ground truth I established by reading the source directly.

| Work item | Arm | Output tokens | Tool calls | Wall-clock | Answer vs. ground truth |
|---|---|--:|--:|--:|---|
| **WI-1** add_holding duplicate guard (mike) | ATLAS | 81,628 | 31 | 895 s | Correct |
| | Baseline | 68,868 | 25 | 288 s | Correct |
| **WI-2** recording double-booking (streaming) | ATLAS | 79,084 | 18 | 286 s | Correct |
| | Baseline | 63,483 | 22 | 198 s | Correct |
| **WI-3** API auth/CSRF audit (mike) | ATLAS | 124,401 | 52 | 964 s | Correct |
| | Baseline | 88,493 | 40 | 301 s | Correct |
| **Totals** | ATLAS | **285,113** | 101 | — | — |
| | Baseline | **220,844** | 87 | — | — |

**ATLAS token overhead: +18.5%, +24.6%, +40.6% (aggregate +29.1%).**

### What the numbers mean (and don't)

- **The token penalty is directionally real (3/3 pairs positive), but the causal story needs a correction.** The table measures **output** tokens, while the cited mechanism — verbose JSON envelopes (one `tree.branch` on a single directory was **5,672 tokens**, one `tree.scope` **2,622 tokens**) — lands in the *input* context, not output. The envelope cost is real but a different line item; the output-token gap reflects more calls and more reasoning over noisier results. WI-2 is the tell: its ATLAS arm made *fewer* tool calls (18 vs 22) yet spent +24.6% more output tokens — that gap is agent work digesting verbose results plus run-to-run variance, not envelope size. The ATLAS agents also *still* fell back to `Read` for the actual code (WI-3's ATLAS arm did **34 Reads on top of 27 `code.lens` calls** — note this count conflicts with the table's 52 total tool calls; the two figures come from different counters and were not reconciled), so they paid for the navigation layer **and** the raw reads. Future runs must use priced accounting: uncached input + cache reads + output (see addendum R3 — cache reads *dominate* production cost at 700k contexts).
- **The wall-clock gap is mostly a harness artifact — discount it.** My standalone probe boots a fresh Node process per ATLAS call (~2–6 s each). In production ATLAS runs **in-process** through the shared conductor with warmed views and a dispatch cache, so per-call latency is tens of ms. WI-1's 895 s is ~19 cold boots, not ATLAS being slow.
- **Quality was a tie, not a win.** On all three tasks both arms reached the same correct conclusion with the same key evidence. Examples of things *both* arms independently found: the two colliding `0002` portfolio migrations (one has `UNIQUE(portfolio_id, ticker)`, one doesn't, both `CREATE TABLE IF NOT EXISTS` so the constraint never lands); the dead-code `catch(PDOException 'UNIQUE')` recovery block that can never fire; the soft-delete partial-index nuance (WI-1). For WI-2 both found the blind `INSERT` in `Config::create_recording_schedule` and the silent-preemption `SchedulerDecision`. For WI-3 both produced the full endpoint×guard matrix and flagged the same unauthenticated global-mutation endpoints (`weights`, `runs`, `scans`, `settings-templates`).

### The load-bearing caveat

My A/B ran ATLAS in **manual-pull mode**: agents started cold and drove every ATLAS call by hand. That is **not** how ATLAS is designed to deliver value. In production the dominant mechanism is the **handoff prefetch** — `tree.scope` + `memory.surface` + a slice are computed once at spawn and **baked into the system prompt** before turn 1 (measured render: ~2,415 chars under a 12,000 cap). My A/B agents got none of that. So these results bound ATLAS's **worst** operating mode; they do not measure its intended one.

---

## 2. Production telemetry (mined from the live databases)

### Index freshness — healthy

| Repo | View built | Git HEAD date | Dirty files | Symbols / edges / tree nodes |
|---|---|---|--:|---|
| mike | 2026-06-24 07:20 | 2026-06-23 | 0 | 11,363 / 60,935 / 11,800 |
| streaming | 2026-06-27 04:19 | 2026-06-26 | 0 | 4,609 / 23,136 / 4,957 |

Both indexes are current with HEAD — no drift, no staleness at the graph level.

### Prefetch relevance — CORRECTED: a system heuristic, not agent grading

**Original claim (wrong):** agent calls carry an `atlas_prefetch_status` "the agent's own feedback sets" — 91.8% relevant (streaming), 78.4% (mike).

**What the code actually does** (`lib/domains/handoff/functions/index.js:1558-1584`, `helpers/atlas-context.js:1694-1735`): the status is computed **at handoff time, before the agent's first turn**, by `classifyAtlasPrefetchRelevance`, and no code path ever updates it from agent output. The classifier is generous by construction:

- **assessor:** unconditionally "relevant" whenever the baseline prefetch succeeded.
- **researcher:** "relevant" whenever the research context fetch returned anything.
- **dev/planner with scoped files:** "relevant" if the slice contains a file it was *seeded with* — near-circular.
- **otherwise:** ≥2-token lexical overlap between task text and slice evidence — but the slice was built *from* that task text.

So 78–92% is a **pipeline-health metric** ("prefetch ran and returned something on-topic-shaped"), not evidence agents found the context useful. The mike/streaming gap and the `ok_unhelpful` tail are still weakly informative (the heuristic *can* fail), but the headline "the push side works" is **unsupported until a real post-run relevance signal exists** — agent-graded at task end, or outcome-linked. That instrumentation is the top follow-up item.

### Usage volume and cost (mike ledger, lifetime; zero failures across all actions)

| Action | Calls | Avg result bytes | ≈ tokens/call |
|---|--:|--:|--:|
| code.getSkeleton | 138 | 1,300 | ~325 |
| code.getHotPath | 132 | 5,507 | ~1,377 |
| symbol.search | 47 | 7,327 | ~1,832 |
| slice.build | 17 | **91,312** | **~22,828** |
| tree.scope | 5 | 35,974 | ~8,994 |
| tree.overview | 3 | 49,650 | ~12,413 |

`slice.build` at ~23k tokens/call is the elephant: whether it beats reading the files raw depends entirely on whether the slice is more targeted than the files would have been — and that is exactly what the A/B suggests it often is **not**, because agents read the files anyway.

### Context size — ATLAS does not make contexts small

Average **input tokens per dev call in production: streaming 681k, mike 543k–798k**, with **~99% cache-hit** (677k of 681k cached on streaming). Takeaway: ATLAS's contribution is not a smaller context — it's a **warm, cached, relevance-ranked** one. Two corrections from the red team: (1) cache reads are **not** "nearly free" — at ~0.1× input price, 677k cached tokens ≈ tens of cents *per call*, dollars per multi-turn job; context size × turn count is the **dominant** production cost lever, which strengthens rather than weakens the "drop the token-savings framing" conclusion. (2) The claim that contexts sit at 540–800k "whether or not ATLAS is in play" was written without a non-ATLAS cohort — one exists and should be mined: `admin-atlas-report.js` already groups `agent_calls` by `COALESCE(atlas_method, 'baseline')` with per-method tokens/cost, and its `token_usage` savings estimator (including negative-savings tracking) is a production-native answer to "does the slice beat raw reads."

### Memory store — the staleness loop works

mike holds 31 task-context memories (2 flagged stale), streaming 26. In manual testing, `memory.get` returned only the **non-stale** memories for a file and filtered the two stale ones — and those two had been correctly stale-flagged by prior agent feedback. The self-correcting memory loop is functioning.

---

## 3. Manual probing — per-tool verdicts

| Tool | Probe | Result | Verdict |
|---|---|---|---|
| `symbol.search` | "portfolio holdings valuation" (mike) | Top hit `get_portfolio` in `src/repo/portfolios.py` | ✅ Right symbol first, cross-language, zero config |
| `symbol.search` | "featured broadcast decision" (streaming) | `FeaturedBroadcastDecision` exact top hit | ✅ Strong |
| `symbol.overview` | `require_authed_account_id` callers (mike) | **3 callers** (alerts, auth_change_password, portfolios) | ✅ **More precise than grep** — grep's 4th hit was the definition in `helpers.php`; ATLAS excluded it |
| `symbol.overview` | `shouldRun` (streaming) | 0 usages | ✅ Correct — it's an orphan root-copy file |
| `code.skeleton` | portfolios.php | 647 chars / 162 tokens, function signatures only | ✅ Compact; ⚠️ ladder-policy warning fired |
| `tree.scope` | "recording scheduler overlap" (streaming) | Correct area map (Recording classes, high confidence) | ✅ Good scoping; 💰 2,622 tokens |
| `tree.branch` | htdocs/api (mike) | Symbol aggregates + centrality | ✅ Rich; 💰 **5,672 tokens for one directory** vs. ~20 for `ls` |
| `code.lens` | portfolios.php identifiers `create`, `add_holding` | **Reported both MISSING** though both are present | ❌ **Confident false "missing" on string-dispatch code** (`$action === 'create'`) — worse than silence, because agents trust it. Deliberate design (AST skips strings/comments to suppress lexical noise), and the non-AST fallback path behaved differently. **FIXED 2026-07-02:** a capped text-tier rescue pass now returns string hits as `matchKind:"text"` + `identifiersFoundInText`; `identifiersMissing` now means "appears nowhere" |
| `code.window` | raw window | Rejected without `reason` **and** `identifiersToFind` | ✅ Policy gate works as designed |
| `memory.get` | portfolio files (mike) | 2 valid memories, stale ones filtered | ✅ Correct filtering |

**Ladder-policy note:** nearly every manual `code.skeleton`/`code.lens` call emitted "requested before `symbol.card`" warnings. **Red-team caveat:** those probes never called `symbol.card` first *by construction*, so this observes the probe, not production agents — production skip rate was unmeasurable at assessment time (nothing recorded `ladderPolicy`). **Also:** enforcement is not currently a viable option — `enforce` is dead code, ladder state is per-process (split-brain between the conductor and the in-process fallback), and without `sessionId` injection all agents share the `"default"` session key. **ACTION TAKEN 2026-07-02:** ladder skips are now extracted into observation telemetry (`ladder_skipped` in `tool.atlas` observation response detail), so the production skip rate is measurable; the enforce/strip/drop decision is deferred until that data exists.

---

## 4. Where ATLAS wins, and where it loses

**Wins**
- **Handoff prefetch** — task-scoped context seeded pre-turn-1, ~78–92% rated relevant. This is the feature with the best evidence and the one my A/B couldn't test.
- **Structural / call-graph queries** — `symbol.overview` is more precise than grep (filters definitions/comments); `symbol.search` is a strong zero-config semantic entry point across languages.
- **Caching** — ~99% cache-hit on large contexts makes re-reads cheap; the "savings," where real, are here.
- **Memory with a working staleness loop** — surfaces prior findings and self-corrects.

**Losses**
- **Token count** — verbose JSON envelopes; +29% aggregate in the A/B; contexts stay at 600–800k regardless.
- **Exhaustive enumeration** (WI-3) — you must read every file, so ATLAS is pure overhead on top of the reads.
- **String-literal / config-dispatch code** — `code.lens` AST-only miss is a real correctness hazard for the procedural PHP both repos use.
- **Small repos** — at 243–404 files, grep is instant and cheap; ATLAS's edge should grow with repo size, but neither test repo is big enough to show it.

---

## 5. Recommendations (revised after red team, 2026-07-02)

1. **Reframe the value proposition away from "token savings."** Unchanged, and *strengthened*: priced accounting makes cache reads the dominant cost, so context size × turn count is the real lever. Sell ATLAS as *structural queries + warm cached context*, not token reduction.
2. ~~Lean into prefetch~~ → **Instrument prefetch relevance for real, then decide.** The 78–92% figure was a pre-run system heuristic (see §2 correction); prefetch is cheap (~2.4k chars, capped at 12k) and *plausibly* useful, but its relevance has never been measured. Build a post-run signal (agent-graded at task end, or outcome-linked) before marketing the push path.
3. **Fix `code.lens` string-literal matching** — ✅ **DONE 2026-07-02** (capped text-tier rescue: `matchKind:"text"`, `identifiersFoundInText`; comments count for presence but don't emit match lines). Follow-up still open: `atlas-auto-feedback.js` marks any lens `symbolId` arg "useful" regardless of hit/miss, so lens spam pollutes the feedback ledger.
4. ~~Enforce or drop the ladder~~ → **Measure first; enforce is unsound today.** Skip telemetry added 2026-07-02 (`ladder_skipped` in observations). Enforcement preconditions if data ever justifies it: shared ladder state across conductor/in-process dispatch + real `sessionId` injection. Otherwise strip or drop once skip rate is known.
5. **Before any new A/B: mine the in-product data and reprice.** `admin-atlas-report`'s baseline cohort (`COALESCE(atlas_method,'baseline')`) and its `token_usage` savings estimator already answer parts of this assessment's questions with production data. Then re-run the A/B: prefetch enabled, gated-vs-native arms (production is ATLAS-first gated by default — a whole-run grep ban overstates but the gate is real), ≥3 paired repeats per work item, priced metrics (uncached input + cache reads + output), tasks hard enough that arms can *fail* (all six runs succeeding = ceiling effect, quality parity unproven), and a >2k-file repo. Envelope baseline also changed 2026-07-02: agent-facing results are now compact JSON (was 2-space pretty-printed), so historical envelope token counts overstate the current cost.

Protocol, prompts, queries, and pitfalls for the re-run are captured in `docs/atlas/quality-testing.md` so this doesn't get rebuilt from scratch.

---

## Appendix — methodology & reproduction

- **A/B harness:** six `general-purpose` subagents, identical prompts per WI, one arm ATLAS-only (grep/Glob forbidden), one arm grep/Read-only. Read-only throughout; no files modified. Token/tool/duration figures are the harness-reported per-agent usage.
- **Standalone ATLAS access:** the agent-facing tools were driven through the real owner path (`executeEmbeddedAtlasTool` in `lib/domains/integrations/functions/atlas-embedded.js`) via a small runner, so probes exercised production dispatch/validation. Probes ran in a read-only *reader lane* (usage events counted as drops), so **this assessment did not pollute either repo's real usage telemetry**.
- **Ground truth** for grading was established by reading source directly (e.g. `htdocs/api/portfolios.php:206–247`, `src/repo/portfolios.py:99`, `migrations/**/0002_portfolio*.sql`, `www/includes/classes/Config.php:893`, `www/includes/classes/Recording/SchedulerDecision.php`).
- **Confounds to keep in mind:** manual-pull mode (no prefetch) understates ATLAS; cold-boot Node per call inflates ATLAS wall-clock only; small sample (3 tasks × 2 repos); both repos small enough that grep is cheap.

---

## Red-team addendum (2026-07-02)

A reviewer critique plus an independent adversarial pass were run against this assessment and against each other. Corrections were applied in place above (marked "CORRECTION"/"ACTION TAKEN"). Summary of what survived, what fell, and what shipped:

**Findings against the assessment**
- **R1 (biggest):** the prefetch-relevance headline (78–92% "agent-rated") was factually wrong about its mechanism — `atlas_prefetch_status` is set pre-turn-1 by `classifyAtlasPrefetchRelevance`, a partially circular heuristic (assessor: auto-relevant on fetch success; researcher: relevant if anything returned; dev/planner: slice contains a seeded file; else ≥2-token lexical overlap with the task text the slice was built from). Nothing ever updates it from agent output. §2 rewritten.
- **R2:** the +29% A/B figure measured *output* tokens while blaming *input*-side envelope verbosity; WI-2 (fewer calls, more tokens) shows run variance in the number. Direction survives (3/3 paired positive, sign-test p=0.125); magnitude does not.
- **R3:** "cache reads nearly free" (reviewer) and "540–800k regardless of ATLAS" (doc) both fell: cache reads ≈ 0.1× input price *dominate* production cost at ~700k contexts, and a baseline (non-ATLAS) cohort was mineable all along via `admin-atlas-report`.
- **R4:** the grep-ban critique (reviewer) was overstated: production defaults to the ATLAS-first tool gate (`atlas_tool_gate_enabled=true`), which mandates ATLAS calls before native tools unlock — closer to the A/B's ATLAS arm than to free-mix. The gate also institutionalizes a minimum paid ATLAS call count per job: unmeasured cost, worth quantifying.
- **R5:** quality "tie" is a ceiling effect — six correct runs on tasks too easy to differentiate arms proves nothing about quality parity on hard tasks.
- **R6:** WI-3's tool-call table (52) vs text (34 Reads + 27 lens = 61+) is unreconciled; "zero failures" covers only the ATLAS ledger, not MCP-transport failures (gateway-attach class).

**Shipped as a result (2026-07-02, all atlas retrieval/corpus/auto-feedback tests green)**
1. `code.lens` text-tier rescue (`hotpath.js`): string-literal hits return as `matchKind:"text"` capped at 5 lines/identifier; comment-only hits reported via `identifiersFoundInText` without match entries; `identifiersMissing` now means "appears nowhere." Contract + tool description updated; 3 new tests.
2. Compact JSON rendering of all agent-facing ATLAS results (`atlas-embedded.js`, `AtlasToolExecutor.js`) — was 2-space pretty-printed; double-digit-percent envelope reduction for zero information loss.
3. Ladder skip telemetry (`signal-extraction.js`): non-compliant calls now surface `ladder_skipped` (+ `ladder_required_rung`) in `tool.atlas` observation detail, making production skip rate measurable for the first time.
4. Evidence-ladder reframe of all model-facing gate language (`atlas-context.js` retrieval-order/prefetch lines, `ToolGate.js` locked-tool errors, `tool-descriptors.js` contract lines): "unlock fallback"/"N more calls before standard tools" tollbooth framing replaced with "ATLAS is the inspection path; native reads are the exception for a named evidence gap (stale/empty/conflicting evidence, non-indexed config/data/docs, mutated files, exact text ATLAS could not provide) — state the gap when you use one; never call ATLAS merely to make native tools available." Gate mechanics unchanged; targets the "ATLAS, then Read anyway" double-pay pattern (WI-3) at the mental-model level.

**Parked follow-ups (in priority order)**
1. Real prefetch relevance signal (post-run agent grade or outcome-linked) — replaces the R1 heuristic as evidence.
2. Auto-feedback pollution: don't mark lens-miss symbols "useful" (`atlas-auto-feedback.js:159-162`).
3. Mine `admin-atlas-report` baseline cohort + `token_usage` savings rows before designing any new A/B.
4. Ladder decision (strip/drop/enforce) once skip-rate data accumulates; enforcement requires shared state + sessionId injection first.
5. `tree.branch` default payload (aggregates on, limit 100) — measure before changing; the `ls` comparison was apples-to-oranges but the default density is still worth an A/B.
