# Prompt and catalog change policy

This policy is the shared change contract between `posse` and
`posse-remote`.

- `posse` owns executable tool definitions, model-facing schemas, runtime
  validation, result semantics, and the generated
  `test/fixtures/agent-tool-contract.json`.
- `posse-remote` owns the prompt text that teaches models how to use those
  contracts.

The generated Posse fixture is the single machine-readable review artifact.
Do not create or vendor a second copy in `posse-remote`, and do not make either
repository's GitHub CI depend on a sibling checkout.

## 1. Changes that require paired review

Treat a change as cross-repository when it:

- adds, removes, or renames a model-facing field, alias, enum value, or profile;
- changes a hard or recommended limit named in prompt text;
- changes what is required or rejected by schema or runtime validation;
- changes a semantic gate the prompt must disclose;
- changes the model-visible meaning of a tool result.

A change that affects only internal callers, non-rendered catalog audit data, or
implementation details with no model-facing consequence does not require prompt
text churn. Record that determination in the commit or handoff.

## 2. Lightweight paired workflow

For a cross-repository change:

1. Update the canonical Posse schema, runtime policy, or result owner.
2. Regenerate `test/fixtures/agent-tool-contract.json` with
   `npm run contract:agent-tools:write`.
3. Read the affected `prompt_contract` policy and exact
   `tools[].role_variants` schema in that fixture.
4. Update every affected live prompt variant in `posse-remote`.
5. Give both repository commits the same stable `Change-ID`.
6. After both commits exist, record their final hashes together in the
   cross-repository handoff or release record. One commit may reference an
   already-existing counterpart hash; final hashes are not required
   circularly in both commit messages.

This workflow is deliberately review-based. It does not add a vendored contract
copy, a prose-scraping parity test, or a new cross-repository GitHub CI chain.

## 3. Reading fields and limits

The generated contract distinguishes these surfaces:

- `tools[].role_variants`: the exact schema issued to each role and compact
  variant;
- `prompt_contract.limits.hard`: canonical runtime ceilings;
- `prompt_contract.limits.recommendations`: non-rejecting targets;
- `prompt_contract.semantic_gates`: runtime rejection rules that prompt text
  must disclose;
- `tools[].enum_visibility`: values accepted internally but withheld from the
  model-facing schema.

A prompt may call a value a hard maximum only when the exact issued role variant
or its runtime semantic gate enforces that maximum. Generic runtime ceilings do
not automatically apply to every profile. Recommendations must be described as
targets, never as rejection thresholds.

Review the assembled prompt, not an isolated Markdown fragment.

## 4. Existing checks

Before committing the Posse side:

- `npm run contract:agent-tools:check`
- `node --test test/test-agent-tool-contract.test.js`
- focused schema/runtime tests for the changed behavior

Before committing the remote side:

- bump `PROMPT_VERSION` in the same commit as prompt-text changes;
- regenerate the matching `docs/generated-prompts/` snapshot;
- run `cargo test --offline prompt`;
- diff affected assembled prompts against the preceding snapshot and compare
  their contract statements with the regenerated Posse fixture.

Keep each repository's GitHub CI self-contained. The existing centralized
pre-push/deployment compatibility check may read the sibling Posse checkout; it
is an operator/deployment guard, not a replacement for repository-local tests.

## 5. Compatibility and rollout

Every paired change must name the ship order and compatibility window.

- Optional request fields: remote accepts them first; Posse sends them second.
- Schema tightening or alias removal: remote teaches the canonical form first;
  Posse tightens only after the prompt deployment is available.
- Additive result formats: the result owner ships compatibility support first;
  consumers opt in second.
- Prompt-only clarification may ship independently only when the currently
  issued schema and runtime already support exactly what it teaches.

Use `prompt_contract.aliases.advertised` and `.accepted` as separate review
categories. An accepted-only alias must not be taught to models. Retiring one
requires an explicit deprecation change backed by existing operational
evidence; this policy does not require blanket shadow telemetry.

A commit is not permission to push, deploy, bump a native product version, or
publish a release.

## 6. Prompt snapshots

Whenever `PROMPT_VERSION` changes, regenerate
`docs/generated-prompts/<PROMPT_VERSION>-<label>/` in the same commit using
the preceding snapshot's requests, changing request fixtures only when the
contract itself requires it.

Keep the current and immediately preceding snapshot so reviewers can compare
assembled output, digests, and per-section sizes. Older snapshots may be removed
only as an explicit snapshot-maintenance change.
