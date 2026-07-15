# Rust migration relics and drift-surface audit

**Date:** 2026-07-15

**Scope:** Posse orchestrator plus the Rust/native, remote-server, and remote-control boundaries named by the workspace architecture. The unrelated `sdl-mcp/` project was not inspected.

**Mode:** audit plus a bounded Node-side cleanup of the four cutover seams selected for remediation. No Rust file was changed, and no Rust test, compile, check, Clippy run, or Rust executable was run. Rust observations remain source-level fix notes only.

## Executive verdict

The migration is functionally well defended in several important places, but it is not cleanly finished. The sweep found contradictory authority surfaces that can direct operators or coding agents into obsolete paths, an incomplete native Remote capability seam, and a sizeable cleanup tail.

The initial audit misclassified `edit.plan` as a live regression. It was intentionally removed from provider-facing surfaces while its final retirement is undecided. That leaves a contract decision to close, but it is not a capability restoration bug and this cleanup did not surface or delete it. The most urgent remaining cross-repo issue is the control protocol: all three copies differ, the locally declared canonical copy documents putting a QR credential in a URL while the implementations use an authorization header, and the retry-delivery wording disagrees with the relay implementation.

| ID | Priority | Classification | Finding |
|---|---:|---|---|
| F1 | P2 | Intentional hiding, unresolved retirement | `edit.plan` is intentionally absent from provider-visible ATLAS surfaces, but gateway/catalog/test intent has not been fully reconciled. |
| F2 | P1 | Confirmed cross-repo drift | The three control-protocol copies disagree with each other and with source comments. |
| F3 | P1 | Operator/release hazard | Rust source and deployment authority is split between `posse-bin` and legacy Encoder/Vector paths. |
| F4 | P1 | Automation guidance drift | Live assistant directives describe nonexistent pre-domain, local-prompt, SDL, and environment-config architecture. |
| F5 | Cut over in Node; coordinated release required | OAuth tool-surface requests now route through native Remote. Deployment requires the next binary version with body-sensitive `mcp_oauth.requested` classification. |
| F6 | Resolved | Native parser cutover | Node extractor/fallback code and the duplicate pre-native hash/decode work were removed. |
| F7 | Partly resolved | Executable/test-preserved relics | The 1,581-line legacy proxy was deleted; other zero-production-import scaffolds remain for separate classification. |
| F8 | Resolved | Dormant broken path | The unreferenced pre-ML CodeRank encoder was deleted. |
| F9 | P2 | Security-relevant drift surface | Git read/mutate authority policy is hand-mirrored across Node, tests, and Rust without a cross-repo oracle. |
| F10 | P3 | Migration hygiene | “One release” aliases, retired shadow APIs, old telemetry names, and seven permanently skipped native-cutover tests remain. |

Priorities mean: **P1** address before relying on the affected contract or release workflow; **P2** bounded today but likely to become a defect during the next cutover/refactor; **P3** cleanup that mainly reduces misleading surface area.

## Method and evidence standard

The sweep searched migration vocabulary (`legacy`, `compat`, `fallback`, `shadow`, `dual`, `retired`, old binary/repository names), traced static importers and runtime callers, compared duplicated Node/Rust route and tool catalogs, compared the three control-protocol copies, and ran focused drift/ownership tests. A module was not called a deletion candidate solely because its name looked old. Findings below distinguish:

- a **confirmed defect**, reproduced by a guard or runtime-surface inspection;
- a **drift surface**, currently aligned or protected but independently maintained;
- a **relic candidate**, with no production importer but still subject to external/dynamic compatibility checks; and
- a **durable migration**, which should remain until old persisted state is outside the support window.

## Findings and adversarial review

### F1 — `edit.plan` is intentionally provider-hidden but not fully retired (P2)

**Evidence.** `edit.plan` remains in raw query/code gateway catalogs and schema declarations, while its membership in the internal-action list causes the provider-surface filter to remove it from gateway enums and the standalone surfaced inventory. The checked-in provider inventory and its exact-gateway test still describe the earlier surfaced state.

**Impact.** The provider omission itself is intentional, so no provider capability was restored in this cleanup. The remaining risk is ambiguity: future catalog generation or a well-meaning “drift fix” could accidentally resurface it, while a broad deletion could remove an action whose final retirement has not been decided.

**Red-team challenge.** The contradictory raw catalogs and tests initially made this look like an accidental regression. Operator clarification changes the verdict: those are uncut contract seams around an intentional visibility decision, not evidence that providers should currently receive the action.

**Recommendation.** Keep `edit.plan` provider-hidden. Add an explicit visibility/ownership state that distinguishes “internal but retained” from “retired,” then align the raw gateway declarations, generated provider inventory, remote-issued surface, and tests once the retirement decision is made. Do not infer either resurfacing or deletion from the current contradiction.

### F2 — Control-protocol drift includes security-sensitive credential transport (P1)

**Evidence.** `scripts/check-control-protocol-drift.mjs:2-4` says the three files are one canonical wire contract and drift silently breaks the system. `npm run check:protocol` currently fails for both sibling copies.

- Local `docs/control-protocol.md:703-706` tells the phone to poll with `?qr_token=...`.
- Remote-control uses `Authorization: Bearer <qr_token>` in both its protocol copy and implementation (`posse-remote-control/src/domains/relay/functions/relay.ts:178-188`).
- The remote relay requires a bearer token (`posse-remote/rust/domains/control/functions/routes.rs:436-464`).
- The remote protocol copy additionally documents retry-stable credential delivery. The implementation deterministically derives tokens and reuses stored expiries on retry (`routes.rs:499-575`), but its own function comment at lines 439-442 still says subsequent polls receive no credentials.

The drift guard is a standalone package script (`package.json:74`); the normal `npm run check` chain at line 24 does not invoke it. The script also treats the local file as authoritative and tells the operator to copy it outward (`check-control-protocol-drift.mjs:62-77`), which would overwrite the bearer-token and retry-safe wording with the least accurate copy.

**Impact.** Runtime phone and relay code currently agree on the safer bearer transport, so this is not evidence that production presently leaks QR tokens. It is nevertheless a security-significant contract hazard: following the declared canonical document or its automatic repair advice would reintroduce a credential-in-URL design and erase current retry semantics.

**Red-team challenge.** Documentation drift alone does not prove an exploitable runtime defect. The implementation check downgrades the immediate runtime claim: live code is aligned on bearer transport. It does not downgrade the contract/source-of-truth failure because this document is explicitly used as the wire contract across three repositories.

**Recommendation.** Reconcile against implementation rather than blindly copying the local file, select one owner (or generate the copies), update stale source comments and remote-control “exactly once” comments, and put the drift check in the default/CI verification path.

### F3 — Consolidated Rust ownership and legacy release commands conflict (P1)

**Evidence.** The consolidated repository says it “owns all Rust binaries used by Posse” (`posse-bin/AGENTS.md:3-5`) and that Encoder is no longer a version or deployment unit (`posse-bin/docs/DESIGN-SPEC.md:29-30`). Its release design explicitly calls for replacing the separate Encoder/Vector deploy scripts and only retiring previous repositories after adoption gates pass (`DESIGN-SPEC.md:184-190`). Its current deployment command is `cargo run -p posse-xtask -- prepush` (`posse-bin/docs/DEPLOYMENT.md:7-25`).

The active workspace guidance instead names `posse-encoder-rust` as the owner of Git, Atlas, and Remote (`C:/development/claude/tools/AGENTS.md:23-28`) and tells operators to use `deploy:native:encoder` and `deploy:native:vector` (`AGENTS.md:375-383`). Those package scripts remain advertised (`package.json:77-84`):

- `scripts/deploy-native.mjs:205-221` resolves and pushes `posse-encoder-rust` only;
- `scripts/deploy-vector-native.mjs:226-236` resolves the old `posse-vector` checkout, which is not present in this workspace;
- `scripts/rebuild-rust-binaries.mjs:350-376` correctly prefers `posse-bin` but retains Encoder fallbacks;
- `lib/bin/README.md:76-96` likewise identifies `posse-bin` as the current source.

**Impact.** An operator or repo-aware agent can follow first-party instructions and commit/push a superseded source repository, while another first-party document points at the consolidated source. This is more dangerous than stale prose because the legacy commands are executable and perform versioning, commits, and pushes.

**Red-team challenge.** It is not yet safe to conclude that every legacy deploy path is deletable. `posse-bin/docs/MIGRATION-STATUS.md:66-82` says remote-builder orchestration and artifact publication remain to be connected, and line 39 explicitly says the old repositories were not deleted. The evidence proves split authority, not completed production adoption.

**Recommendation.** Publish a single source-to-artifact authority matrix with the deployed artifact provenance and current release owner for each binary. Until adoption is proved, label legacy commands explicitly as transitional and make ambiguous aliases fail with a pointer to the matrix. After the remote builder consumes `posse-bin`, remove the legacy deploy scripts, old repository fallbacks, and obsolete environment overrides together.

### F4 — Assistant directives are live but describe a removed architecture (P1)

**Evidence.** The root guidance explicitly routes assistants to `posse/claude/rules/rules.md` and `workflow.md` as active directives (`C:/development/claude/tools/AGENTS.md:30-35`). Those files instruct changes through paths that do not exist:

- `lib/queue.js` (`claude/rules/rules.md:27-29`);
- `lib/provider/*` and `lib/worker/worker.js` (`rules.md:58-62`, `workflow.md:33-42`);
- local `prompts/*.md` (`rules.md:49-54`, `workflow.md:36`);
- retired SDL modules and `POSSE_SDL_*` environment configuration (`rules.md:64-101`).

The current root guidance says prompts come from the authenticated remote bundle (`AGENTS.md:15-17`), provider routing comes from the account database (`:417-423`), and environment-backed configuration/feature flags must not be introduced (`:436-442`). It also points new settings at `lib/functions/settings/catalog.js` (`:438-440`), another nonexistent path.

**Impact.** This is a live automation drift surface: every repo-aware assistant is told to consult mutually incompatible instructions. The likely failure modes are edits in the wrong architectural tier, reintroduction of local prompts/environment configuration, or attempted resurrection of SDL-era code.

**Red-team challenge.** If the `claude/rules` files were merely archival, their content would be harmless. The root `AGENTS.md` makes them active, so the archival defense fails. Conversely, individual timeless rules inside them may still be valid; wholesale deletion without extracting those rules would also be careless.

**Recommendation.** Make `AGENTS.md` the single architectural authority, update or archive the two linked directives, and add a cheap documentation test that asserts every backticked architectural path in active guidance exists (with an allowlist for illustrative paths).

### F5 — Native Remote OAuth cutover is staged for the next binary version

**Change.** `RemotePromptClient.resolveToolSurface` no longer diverts OAuth-minting requests to Node HTTP. Both ordinary and `mcp_oauth.requested === true` tool-surface requests now use native Remote. The general feature gate, environment/settings gates, CLI `--no-native` switch, and OAuth compatibility exception are all gone. Authenticated default-fetch Remote requests fail closed if the native artifact is missing.

**Coordinated Rust dependency.** The next `posse-remote` binary version must classify `POST /v1/catalog/tool-surface` by body: `mcp_oauth.requested === true` requires `prompts:compile`; all other bodies require `catalog:read`. That Rust change and focused coverage are being delivered with the next binary version. No Rust file was edited and no Rust command was run in this Node cleanup.

**Deployment constraint.** Publish/issue the corrected binary before or atomically with this Node patch. Running this Node revision against an older issued Remote binary will fail OAuth tool-surface resolution closed because the old binary requests the `catalog:read` capability.

**Red-team challenge.** This is now a release-order hazard rather than a hidden fallback. The Node contract is unambiguous and fully native, but successful OAuth minting depends on the promised binary floor being the one actually issued by the remote artifact catalog.

### F6 — Native parser cutover completed on the Node side (resolved)

**Change.** `parseBuffer` now validates the canonical path, resolves native language metadata, and delegates directly to `parseBufferNative`. The unreachable JavaScript extraction branch, duplicate pre-native decode/hash work, line-range/body-identifier helpers, and A/B migration oracle were removed. Language descriptors now contain metadata only; there is no `native` transition flag or `extract` callback. Tests now guard the all-native ownership invariant.

**Red-team challenge.** Node still owns path/language resolution and native result validation; that is an intentional process-boundary contract, not a parser fallback. This cleanup does not claim that base64 transport or Node-side orchestration has moved into Rust.

### F7 — The legacy proxy was removed; smaller relics remain (partly resolved)

**Change.** `lib/domains/integrations/functions/atlas-v2-legacy-proxy.js` was deleted after confirming it had no production importer. The only live test was changed from preserving source-text behavior to asserting that the retired adapter is absent.

Other zero-production-import or test-only remnants still requiring separate classification include:

- the `lib/domains/atlas/functions/v2/parse/{pipeline,discover,parse-runner,merge-runner}.js` scaffold; only `pipeline.js` is imported, by `test/atlas-parse-pipeline.test.js`;
- `lib/domains/atlas/functions/v2/view-fts.js`, whose `normalizeSearchScope` has a separate active implementation in `retrieval/search.js:467-470`; the existing cutover plan already records it as zero-import (`ATLAS-GIT-CUTOVER-FIX-PLAN.md:219-224`);
- the uncalled `viewDb()` escape-hatch helper (`retrieval/repo.js:670-678`);
- unused native storage exports `buildViewNativeAsync`, `applyViewNativeAsync`, `cloneViewNativeAsync`, and `patchViewMetaNativeAsync` (`native/storage.js:41-82`);
- test-only `work-item-languages.js`, native parity/SCIP moniker helpers, and other migration oracles still located under production `lib/`.

The proxy plus the small scaffold files measured in this sweep account for roughly 1,800 lines before counting unused exports inside otherwise active modules.

**Impact.** Removing the proxy eliminates the largest misleading executable relic. The remaining items still expand review/search surface, but they were not part of the four requested cutovers and should not be bulk-deleted without caller/compatibility evidence.

**Red-team challenge.** Static zero-import evidence cannot rule out external consumers using undocumented deep imports or dynamically constructed paths. The proxy also expressly claims compatibility intent. Deletion therefore needs an export/package-consumer check and, ideally, a deprecation/support-window decision rather than an immediate bulk removal.

**Recommendation.** Classify each remaining item as external compatibility, parity fixture, or dead. Move required parity fixtures under `test/support`, add an explicit compatibility test for any supported deep import, then delete the rest in small changes with focused ATLAS tests.

### F8 — Dormant pre-ML CodeRank route removed (resolved)

**Change.** The unreferenced `CodeRankEmbeddingEncoder` was deleted. It called the retired/nonexistent Atlas method `coderank-encode`; current CodeRank ownership belongs behind the ML `ml.embed` contract.

**Red-team challenge.** Deletion is safer than silently redirecting the dormant class because no live selector or shape contract defined how it should choose the CodeRank model. A future selector should be implemented against the active ML catalog with explicit capability and output-shape coverage.

### F9 — Git authorization policy is aligned today but has no real cross-repo guard (P2)

**Evidence.** Node hand-maintains `GIT_READ_ONLY_METHODS` and Git argument-policy tables (`lib/domains/git/functions/native/invoke.js:254-384`) to select `git:read` versus `git:mutate` (`:503-520`). Rust independently owns the authoritative dispatch classification (`posse-bin/crates/git/app/src/domains/git/classes/runner.rs:420-518`) and repeats read/mutate inventories in Rust tests (`:757-903`). The Node pulse test calls its list an exhaustive Rust mirror (`test/test-native-pulse-broker.test.js:258-262`) but hard-codes that list and only compares it to Node source (`:349-380`); it does not read a Rust-generated manifest or the Rust source.

The focused pulse suite passes 29/29, and manual comparison found the current inventories aligned. The existing cutover plan independently calls out the same “one git route classifier” work (`ATLAS-GIT-CUTOVER-FIX-PLAN.md:184-190`).

**Impact.** A future Rust method/policy change can leave Node minting the wrong route while both repositories' local tests stay green. Under-classifying a read as mutate grants more privilege than needed; classifying a mutation as read should fail closed in Rust, producing an availability failure rather than unauthorized mutation.

**Red-team challenge.** This is a drift surface, not observed drift. Rust validation and default-to-mutate behavior substantially reduce exploitability. That is why it remains P2 despite touching authorization.

**Recommendation.** Have Rust emit a machine-readable method/capability manifest (including payload-aware cases) and make Node generate or validate its classifier from it. Keep fail-closed defaults on both sides.

### F10 — Compatibility labels and retired tests have outlived the cutover narrative (P3)

**Evidence.** `Warmer` says it remains “for one release” (`lib/domains/atlas/classes/v2/Warmer.js:3-8`), yet production still imports/constructs it in `atlas.js:18,1170,1832` and `atlas-v2-boot-worker.js:10,136`; `ParseEngine.js` retains many `Warmer.*` log labels. `shouldRunDualBackends`, `shadowAuthorityMode`, and `isAtlasShadowEnabled` are retired behavior shims used only by their contract test (`atlas-v2-mode.js:72-106`; `test/test-atlas-v2-native-contract.test.js:19-39`). Seven tests are permanently skipped specifically because the Node ONNX/embedding backend is retired: three in `test-run-session-boot.test.js:469,2458,2692` and four in the warmer shards (`test-atlas-v2-warmer-1.test.js:270`; `test-atlas-v2-warmer-3.test.js:726,762,804`).

**Impact.** This is mainly comprehension and coverage noise. It makes a completed cutover look reversible and leaves dead test bodies in the default suite.

**Red-team challenge.** Persisted settings aliases and externally documented class exports can require longer compatibility than internal call sites. Remove internal use and stale tests first; retain narrowly defined external aliases until a stated support boundary is met.

**Recommendation.** Migrate internal callers/log labels to `ParseEngine`, remove test-only shadow APIs and retired test bodies, and put an expiry/version on every remaining compatibility alias.

## Red-team exclusions: things that looked old but should not be deleted blindly

The adversarial pass rejected several tempting false positives:

1. **Durable schema/data migrations are not relics.** SDL-to-ATLAS column/status migrations, legacy hook-marker cleanup, old worktree-path migration, and persisted setting-value aliases protect upgrades from older installations. Keep them until the supported upgrade window and telemetry prove they are unnecessary.
2. **The old Rust repositories may still be part of artifact production.** `posse-bin` explicitly says publication wiring is deferred. F3 calls for resolving authority and provenance, not deleting repositories on the strength of source layout alone.
3. **`symbol.cards` is a bounded compatibility alias.** It is hidden from providers and normalized to `symbol.card`; this is a healthier compatibility shape than the large legacy proxy.
4. **The `claude-org` package/CLI alias is explicitly documented and tested.** Its old name alone is not migration debris.
5. **An old cleanup plan is evidence, not current authority.** For example, it proposes removals around SQLite write gates that current code may still rely on. Every old-plan item still needs a fresh caller/concurrency trace.

## Verification results

| Command | Result |
|---|---|
| Node syntax checks for the changed parser, binary-manager, and Remote client modules | **Pass**. |
| `node --test test/atlas-parse-pipeline.test.js test/atlas-system-call-boundary.test.js test/test-native-binary-manager.test.js test/test-native-artifact-download.test.js test/test-native-pulse-broker.test.js` | **96 pass / 0 fail**. |
| `node --test test/test-pulse-token-manager.test.js` | **16 pass / 0 fail**. |
| `node --test test/test-deterministic-mcp-remote-catalog.test.js` | **7 pass / 0 fail**; the subprocess guards confirm the retired HTTP catalog route is not restored when native Remote is unavailable. |
| `node --test test/test-posse-remote-composer.test.js` | **63 pass / 0 fail** after removing tests for the already-deleted Remote Atlas encoder and repairing its stale pulse fixture. |

The real-binary parser/parity suites were deliberately not run because they launch a Rust debug executable. No Cargo command, Rust test, Rust compile/check, or Rust executable was run. The full Node suite was not run because it includes those real-native suites; verification stayed on focused Node/stub/source boundaries.

## Recommended order of work

1. **Restore contract truth:** encode the intentional provider-hidden state of F1 without deciding retirement by accident; reconcile F2 from running code and put its guard in `npm run check`/CI.
2. **Resolve authority before deleting:** produce the per-binary source-to-artifact matrix for F3 and update active assistant/operator instructions in F4.
3. **Coordinate the Remote release:** publish/issue the next body-sensitive Rust Remote binary before or atomically with this Node cutover. The Node OAuth compatibility request is already removed. F6 and F8 are also complete on the Node side.
4. **Delete with compatibility evidence:** classify and remove/quarantine the smaller remnants still listed in F7; the legacy proxy itself is gone.
5. **Generate cross-language policy:** replace the Git authorization mirrors in F9 with a Rust-emitted manifest.
6. **Close the narrative:** remove expired aliases, stale names, and permanently skipped test bodies in F10; document explicit expiry for anything retained.

## Bottom line

The strongest theme is not “too much old code”; it is **multiple sources of truth surviving after ownership moved**. This cleanup removed the selected Node-side relic routes, including the final OAuth HTTP exception, and made missing native Remote fail closed. Full Remote operation now depends on issuing the next binary version with the promised body-sensitive classifier. The broader protocol/release/tool-visibility authority issues remain and should be resolved contract-first rather than by indiscriminate deletion.
