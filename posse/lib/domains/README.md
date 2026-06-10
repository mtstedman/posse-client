# Domain Packages

This directory is the migration target for Posse's domain-oriented layout.
Domain packages are facades first: they gather the current `classes/` and
`functions/` modules behind stable domain entrypoints while the existing import
paths remain valid.

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

Do not add tools or toolkit surfaces here during the initial migration. That
area is being worked separately.

Remote is a first-class domain. Current Posse remote prompt/encoder helpers live
there now, and future key-gated remote service integrations should grow under
`lib/domains/remote/`.

Do not add cross-domain infrastructure here just because many domains use it.
Concurrency helpers and thread-worker lifecycle utilities belong under
`lib/shared/concurrency/`.

Logging and run telemetry are also shared infrastructure. Keep those under
`lib/shared/telemetry/`, with logging as a telemetry subsection that still
preserves `classes/` and `functions/`.

Database storage helpers are shared infrastructure too. Keep DB connections,
schema setup, and migrations under `lib/shared/storage/functions/`.
