# Domain Packages

This directory owns Posse's domain behavior. Domain entrypoints gather
`classes/` and `functions/` modules behind the domain's public facade.

Each domain keeps the class/function split firm:

```text
lib/domains/{domain}/
  index.js
  classes/index.js
  functions/index.js
```

Do not collapse this split while reorganizing by domain. Stateful objects,
lifecycle owners, constructor-heavy code, and `this`-bound behavior belong in
`classes/`; stateless helpers, transforms, queries, policy functions, and
procedural orchestration belong in `functions/`.

The domain `index.js` should expose the two tiers as namespaces. Do not merge
class and function exports at the domain root.

Tool integration belongs in its owning domain; reusable tool policy and
execution mechanisms belong under `lib/shared/tools/`.

Remote prompt and service integrations belong under `lib/domains/remote/`.

Do not add cross-domain infrastructure here just because many domains use it.
Concurrency helpers and thread-worker lifecycle utilities belong under
`lib/shared/concurrency/`.

Logging and run telemetry are also shared infrastructure. Keep those under
`lib/shared/telemetry/`, with logging as a telemetry subsection that still
preserves `classes/` and `functions/`.

Database storage helpers are shared infrastructure too. Keep DB connections,
schema setup, and migrations under `lib/shared/storage/functions/`.

Canonical settings definitions and keys belong in `lib/catalog/`. Runtime
settings code may overlay validated remote model defaults, but must not create
a second registry. Provider capabilities, role/turn policy, verification
vocabulary, traversal profiles, and tool schemas follow the same direction:
catalog data first, domain execution second. Catalog imports must not reach
domains, shared runtime mechanisms, or Node I/O modules. Exported membership
tables use `readonlySet`/`readonlyMap`; callers needing mutable state copy them.

Compatibility utilities remain available through their original import paths:

- Atlas's Node resolver, parse registry/display, one-shot parity oracle, and
  work-item language inference delegate to explicitly named `legacy/` owners.
  Native Atlas remains the production parse/query owner. Import-context and
  language-adapter registration are live utilities, outside that quarantine.
  ParseEngine owns the live intake/conductor path.
- Production tool execution uses the async MCP owner/server. Historical
  synchronous executor and handler-map regression helpers live only under
  `test/support/legacy-tools/`; production modules do not export them.
- Persisted Atlas `shadow`/`preferred` settings still normalize to the native
  enabled mode. They no longer expose dual-backend operational switches.

Remove a compatibility facade only after checking package/CLI entrypoints,
tests and scripts, dynamic imports and URL-loaded workers, and supported deep
imports. An empty static inbound-reference count is insufficient. Keep an
intentional wrapper when it preserves a public API, formatting contract, or
separate lifecycle; deduplicate the mechanism behind it instead.

Handoff source lineage, exact server slices, and disjoint source-window
coordinates are owned by `handoff/functions/helpers/evidence-provenance.js`.
Packet materialization and validation stay behind `agent-handoff.js`.
Observation recording keeps its existing `observations.js` entry point;
tool summaries live in `tool-observation-summary.js`, and both projection and
recording share the `ObservationContextScope` async-context owner. Research
membership and tool outcomes come from the observation and unit-test catalogs.

Atlas retrieval's `request-values.js` owns its permissive query-path cleanup
and finite-number clamping. Those helpers preserve their existing query
semantics; filesystem authority checks use the scope/path-policy owners.
Artifact execution and assessment share `artifacts/functions/expected-file-path.js`
for manifest-target mapping.

Frozen test receipts keep lineage, persistence, reuse, and worktree cleanup in
the worker. `frozen-test-plan.js` resolves inherited selections and repository
obligations; `frozen-test-execution.js` runs bounded checks and shares file-result
projection; `test-receipt-evidence.js` owns comparison, attribution, and rendering.
Verification owns `planner-test-command.js`, `test-runner-failure.js`, and
`receipt-fingerprint.js`, so planning and merge checks can use validation without
importing the receipt coordinator. Existing receipt exports remain compatible.
Command flags, receipt policy, dependency network modes, and compact Atlas
projection identities are registered in the catalog.

Run `node scripts/check-installation-policy.mjs` from the package to verify
bootstrap projections, including installer literals needed before Node exists.
When the native workspace is available, run
`node scripts/check-git-native-policy.mjs` to compare Node's read classification
and argv policy with the native method catalog and classifier. The latter is a
development contract check, since public Node CI does not check out that private
sibling. Canonical CI lives in the deployment repository; update its GitHub
mirror in the same change.
