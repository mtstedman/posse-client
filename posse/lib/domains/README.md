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
  The semaphore-backed parse pipeline remains a test/debug orchestration
  utility; the live ParseEngine uses its own intake/conductor path.
- The synchronous `ToolExecutor` and provider handler-map API are compatibility
  and test utilities. Production execution uses the async MCP owner/server.
  Live feedback delivery has a separate module; it does not import the embedded
  handlers. Compatibility callers own their returned handler registry's
  lifetime. Shared scope waits and the tool gate belong to
  `LegacyEmbeddedToolState`.
- Persisted Atlas `shadow`/`preferred` settings still normalize to the native
  enabled mode. They no longer expose dual-backend operational switches.

Remove a compatibility facade only after checking package/CLI entrypoints,
tests and scripts, dynamic imports and URL-loaded workers, and supported deep
imports. An empty static inbound-reference count is insufficient. Keep an
intentional wrapper when it preserves a public API, formatting contract, or
separate lifecycle; deduplicate the mechanism behind it instead.

Run `node scripts/check-installation-policy.mjs` from the package to verify
bootstrap projections, including installer literals needed before Node exists.
When the native workspace is available, run
`node scripts/check-git-native-policy.mjs` to compare Node's read classification
and argv policy with the native method catalog and classifier. The latter is a
development contract check, since public Node CI does not check out that private
sibling. Canonical CI lives in the deployment repository; update its GitHub
mirror in the same change.
