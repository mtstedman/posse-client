# Atlas local keeper patch list

This ledger separates proven local keepers from experiments. A keeper needs direct test or benchmark evidence.

## Proven keepers

### Pre-fusion zero-weight directories

- Removes complete path segments `test/tests`, `example/examples`, and `demo/demos` before backend fusion, file selection, and symbol expansion.
- Exempts only the matching category when that singular word appears in the query.
- Uses segment matching: `contest.rs` is not classified as `test`.
- Code: `crates/atlas/components/runtime/src/domains/atlas/classes/runtime.rs`.
- Test: `zero_weight_directories_are_filtered_before_fusion_with_exact_category_exemptions`.
- Proof: test passes. Current real-20 baseline has 80/80 semantic top-result provenance classified as source. Earlier production-question A/B moved source results 43.9%→88.4%, tests 46.5%→4.8%, MRR .409→.539, and mean semantic latency 860→475 ms.
- Decision: keep enabled.

### Source-aware file admission before symbol expansion

- Reserves most hierarchical file slots for production source and caps example/generated files before expansion.
- Tests: `file_admission_reserves_production_and_caps_examples_before_expansion` and `file_ranking_collapses_duplicate_test_evidence_before_source_policy`.
- Proof: both pass; real-20 baseline returns 80/80 source top results and contains 69/80 expected files in its top ten.
- Decision: keep.

### File-evidence aggregation and backend agreement

- Collapses repeated symbols to file evidence, caps repetition from one backend/file, and rewards independent backend agreement.
- Tests: `file_ranking_rewards_backend_agreement_over_single_backend_repetition` and `file_ranking_collapses_duplicate_test_evidence_before_source_policy`.
- Decision: keep.

### Hierarchical file-first ranking

- Ranks files, expands symbols within admitted files, and deterministically interleaves files. Exact literal identifiers bypass the semantic lane.
- Tests: `hierarchical_output_round_robins_ranked_files` and `exact_identifier_lane_requires_the_entire_query_to_be_literal`.
- Decision: keep the architecture; the new file-count control remains experimental.

### Candidate-depth control and diagnostics

- `vectorCandidateLimit` requests an exact ANN delivery depth through posse-client.
- Reports requested, bridge-delivered, observed, and admitted depths so a harness cannot silently test only 20 candidates.
- Tests: `candidate_depth_is_decoupled_from_output_limit` and `candidate_diagnostics_report_native_backend_and_post_fusion_ranks`.
- End-to-end proof: ESLint smoke reports `requested.ann=160`, `vectorBridgeCandidateLimit=160`, and `vectorBridgeHitCount=160`.

| ANN delivery | Semantic hits | Expected files | Exact symbols | MRR | p50 |
|---|---:|---:|---:|---:|---:|
| Default | 71/80 | 69/80 | 28/80 | .6156 | 794 ms |
| 40 | 72/80 | 71/80 | 27/80 | .6065 | 808 ms |
| 80 | 72/80 | 70/80 | 27/80 | .6129 | 815 ms |
| 160 | 73/80 | 70/80 | 24/80 | .5783 | 822 ms |

- Decision: keep knob and diagnostics. Do not default to 160.

### Task-query seeding in the harness

- `--seeded` passes the user query as `taskText`.
- Proof: recall/MRR remain 71/80 and .6156, while exact-symbol support improves 28/80→31/80; p50 increases 794→875 ms.
- Seed + depth 80: 72/80 hits, 31/80 exact symbols, .6129 MRR, 909 ms p50.
- Decision: keep the capability; do not universally enable it without accepting its latency.

### Correct multi-answer grading

- `acceptableAnswers` supports parallel legitimate implementations such as Zod v3/v4.
- Files: `rich-benchmark.py`, `build-real-corpus-20.py`, and `ground-truth-20.json`.
- Proof: real-20 completes 120/120 graded cases with zero infrastructure errors.
- Decision: keep.

### Persistent native runtime and paired A/B

- Uses Rust Atlas/ML/Vector through the Node orchestrator, refreshes native heartbeat/capability, reuses persisted indexes, and writes independent per-repository OFF/ON reports.
- Proof: all 20 repositories completed paired query executions with zero native errors.
- Decision: keep as the comparison protocol.

## Keep only as experimental knobs

### `filterToolingPaths`

- Complete-segment filter for `harness`, `tool(s)`, `tooling`, and `script(s)`, with query exemptions.
- Test: `optional_declaration_and_tooling_filters_have_query_exemptions`.
- Isolated result: neutral—71/80 hits and .6159 MRR versus .6156.
- Decision: retain for noise testing, not as an accuracy default.

### `hierarchicalFileLimit`

- Controls files admitted before symbol interleaving to test breadth versus multiple symbols per file.
- Default behavior is unchanged.
- Rust tests, client syntax checks, and harness compilation pass. Corpus A/B is pending.

### `filterDeclarationFiles`

- Mechanically tested, but unsafe as a hard filter.
- Proof: Type-fest symbol recall fell 2/2→0/2 because declaration files are its real implementation surface.
- Decision: replace with sibling-aware implementation preference; never default-enable the hard filter.

### `genericSymbolFrequencyThreshold`

- Test: `generic_symbol_frequency_filter_uses_distinct_candidate_files`.
- Isolated result regresses 71/80→70/80 hits and .6156→.5987 MRR.
- Decision: retain only for experiments.

## Explicitly rejected defaults

- Hard `.d.ts` removal.
- Generic-name filtering at threshold 3.
- ANN depth 160 everywhere.
- The combined four-knob preset.
- Calling tooling filtering an accuracy improvement without a dedicated noise metric.

## Evidence

- `results/real20-ab-off.json`
- `results/real20-isolated-candidate40.json`
- `results/real20-isolated-candidate80.json`
- `results/real20-isolated-candidate160.json`
- `results/real20-isolated-seeded.json`
- `results/real20-seeded-candidate40.json`
- `results/real20-seeded-candidate80.json`
- `results/real20-isolated-tooling.json`
- `results/real20-isolated-generic3.json`
- `results/paired-*-off.json`
- `results/paired-*-combined.json`

Verification snapshot: `cargo test -p atlas_runtime` passes 18/18. Client JavaScript syntax checks and Python harness compilation pass.

This list claims only the patches named above. Other dirty files in posse-bin or posse-client are not implicitly included.
