# Shared

Shared is for cross-domain helpers, primitives, and contracts that are not
owned by a single domain. Prefer placing behavior in a domain package first.

Shared keeps the same class/function distinction:

```text
lib/shared/
  index.js
  classes/index.js
  functions/index.js
  concurrency/
    index.js
    classes/index.js
    functions/index.js
  telemetry/
    index.js
    classes/index.js
    functions/index.js
    classes/logging/index.js
    functions/logging/index.js
  storage/
    index.js
    classes/index.js
    functions/index.js
  format/
    index.js
    classes/index.js
    functions/index.js
  scope/
    index.js
    classes/index.js
    functions/index.js
  skills/
    index.js
    classes/index.js
    functions/index.js
  tools/
    index.js
    classes/index.js
    functions/index.js
```

Shared is not a place to blur the boundary. Stateful shared primitives belong
under `classes/`; stateless shared helpers, transforms, predicates, and
procedural utilities belong under `functions/`.

Concurrency primitives are shared infrastructure, not a domain. Keep thread
worker lifecycle classes under `lib/shared/concurrency/classes/` and async gate
helpers under `lib/shared/concurrency/functions/`.

Telemetry is shared infrastructure. Logging lives under telemetry as a
subsection, while still preserving the split: log stateful classes belong under
`lib/shared/telemetry/classes/logging/`, and stateless logging/telemetry helpers
belong under `lib/shared/telemetry/functions/`.

Storage is shared infrastructure. Database connections, schema setup, and
migrations belong under `lib/shared/storage/functions/`.

Format helpers are shared utility functions. Keep ANSI/color, JSON, slug, unit,
and prompt literal helpers under `lib/shared/format/functions/`.

Scope is shared infrastructure used by queue, git, worker, and toolkit. Scope
value objects and mutation policy classes belong under
`lib/shared/scope/classes/`; stateless scope helper exports belong under
`lib/shared/scope/functions/`.

Skills registry helpers are shared policy/data helpers used by multiple
domains. Keep them under `lib/shared/skills/functions/`.

Tool contracts, deterministic toolkit helpers, native binary owners, daemon
supervisors, MCP owners, and hash-ref tool context stores are shared
infrastructure. Keep stateful owners under `lib/shared/tools/classes/` and
stateless tool/toolkit helpers under `lib/shared/tools/functions/`.
