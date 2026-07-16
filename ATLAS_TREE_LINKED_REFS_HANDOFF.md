# ATLAS tree linked refs handoff

## Repository and worktree

Apply and commit this work from the source repository:

`/home/mason/repos/posse`

Do not make the source change in `posse-client`; that directory is generated/rebuilt for users.

The source worktree already contains other uncommitted ATLAS and runtime work. Do not discard, reset, or overwrite unrelated changes. Review and stage the files for the desired commit deliberately.

## Goal

Reduce the token cost of `tree.scope` without losing ranked candidates or creating a second retrieval mechanism.

The intended response sequence is:

1. `tree.scope` returns ranked candidates 1–10 inline.
2. Its `nextCandidateFiles` field exposes one ordinary universal hash ref for ranks 11–20.
3. Passing that ref to `fetch_ref` returns ranks 11–20 and another `nextCandidateFiles` ref.
4. Fetching the second ref returns ranks 21–40 and ends the sequence.

Refs remain generic aliases such as `#a3f9`. Do not add typed prefixes or teach prefix meanings. Do not pass these refs to `tree.expand`, `code.survey`, or other ATLAS tools; `fetch_ref` is the universal data retrieval path.

## Implemented changes

### `posse/lib/shared/tools/functions/hash-adder.js`

Added `compactTreeScopeResult()`.

- Parses successful stringified `tree.scope` envelopes.
- Keeps candidates 1–10 inline.
- Materializes structured ranked pages 11–20 and 21–40 in the existing scoped hash store.
- Builds the pages back-to-front so only the immediate next page is exposed.
- Adds `candidateFilesTotal` and `nextCandidateFiles` to the visible envelope.
- Fails open to the original complete result if parsing or ref creation fails.
- Leaves results unchanged without a valid hash-ref scope.
- Currently leaves requests returning more than 40 candidates unchanged, preventing inaccessible candidates past rank 40.

### `posse/lib/domains/providers/functions/shared/tool-runtime.js`

Runs `compactTreeScopeResult()` before the generic major-result hash adder. A successfully compacted response is delivered directly; fallback results retain the existing `appendHashRefIfMajor()` behavior.

### `posse/lib/catalog/atlas-tools.js`

Updated the canonical `tree.scope` description to explain candidates 1–10, `nextCandidateFiles`, `fetch_ref`, and the linked next-page behavior.

### `posse/test/test-hash-store.test.js`

Added coverage proving:

- only candidates 1–10 remain inline;
- the first visible ref is ranks 11–20;
- fetching it exposes the ranks 21–40 ref;
- the second fetch contains ranks 21–40;
- page boundaries do not leak candidates from the next page.

## Contract follow-up before commit

The canonical catalog contract is updated, but the shorter deterministic MCP summary still needs matching wording:

`posse/lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js`

Update the `tree.scope` summary so provider-facing/generated contract surfaces also mention that candidates 1–10 are inline and `nextCandidateFiles` is fetched sequentially with `fetch_ref`.

It is also reasonable to clarify the canonical and deterministic `fetch_ref` descriptions: fetched structured payloads may themselves contain `nextCandidateFiles`, which should be followed only when deeper ranked results are needed. Avoid tree-specific parsing or routing inside `fetch_ref`; it should remain universal.

## Validation already run

The new linked-page test passes:

```sh
node --test --test-name-pattern='keeps tree.scope top 10' posse/test/test-hash-store.test.js
```

Catalog and tool-contract tests pass (37 tests total):

```sh
node --test posse/test/test-tool-catalog.test.js posse/test/test-tools-class-contract.test.js
```

Whitespace validation passes:

```sh
git diff --check
```

During an earlier full run of `test-hash-store.test.js`, the new test passed but an unrelated eviction/rematerialization test failed. That eviction test passed when rerun independently, indicating existing order sensitivity or flakiness. Run the whole hash-store file again before committing and investigate only if the failure reproduces consistently.

## Suggested final verification

```sh
node --test posse/test/test-hash-store.test.js
node --test posse/test/test-tool-catalog.test.js posse/test/test-tools-class-contract.test.js
git diff --check
git diff -- posse/lib/shared/tools/functions/hash-adder.js \
  posse/lib/domains/providers/functions/shared/tool-runtime.js \
  posse/lib/catalog/atlas-tools.js \
  posse/lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js \
  posse/test/test-hash-store.test.js
```

## Likely next extension

Reuse the linked structured-page pattern selectively for ranked or naturally paged results such as symbol search and broad tree branches. Do not replace the existing general character paging for arbitrary text, and do not create tool-specific expansion semantics inside `fetch_ref`.
