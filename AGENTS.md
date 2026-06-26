# AGENTS.md

This file is the shared source of guidance for Claude Code, Codex, and other
repo-aware assistants working under this `/tools` workspace. `CLAUDE.md` files
should reference this file instead of duplicating instructions, so every
assistant pulls from the same source.

Unless the user explicitly says otherwise, the active project here is
`posse/`. The sibling `sdl-mcp/` directory is not part of this project. It is a
separate project kept in the workspace only as reference material for comparing
SDL/MCP ideas against ATLAS; do not inspect, edit, migrate, test, or include it
in Posse cleanup work unless the user explicitly asks for reference-only
research.

This guidance is for local development only. Posse runtime jobs do not read
this file; runtime prompt pieces come from the authenticated `posse-remote`
prompt bundle and stay in process memory only.

## Repository Layout

Posse spans four local repos (you are in the **Orchestrator**):

| Component | Path | Git remote | Role |
|-----------|------|-----------|------|
| **Orchestrator (Node)** | `C:/development/claude/tools/posse` | `mtstedman/posse` | SQLite job-queue orchestrator — the `posse` CLI. Git root: `C:/development/claude/tools`. |
| Encoder (Rust) | `C:/development/claude/posse/posse-encoder-rust` | `mtstedman/posse-atlas-encoder` | Native worker binaries (`posse-git`, `posse-atlas`, `posse-remote`). |
| Remote server (Rust) | `C:/development/claude/posse/posse-remote` | `mtstedman/posse-remote` | Control plane: prompt bundle, model catalog, heartbeat auth. |
| Remote control (Expo) | `C:/development/claude/posse/posse-remote-control` | `mtstedman/posse-remote-control` | Phone app to puppet Posse instances. |

## Directives

- **[Rules](posse/claude/rules/rules.md)**: coding standards, architecture, scope,
  and error handling.
- **[Workflow](posse/claude/rules/workflow.md)**: planning, testing, and git
  conventions.
- **[Frontend Design](posse/claude/skills/frontend-design.md)**: frontend UI/UX
  implementation guidance.
- **[Security](posse/claude/skills/security.md)**: secure implementation and review
  guidance.
- **[Bugfix](posse/claude/skills/bugfix.md)**: root-cause debugging and
  regression-safe fixes.

## Runtime Prompt Source

Runtime role prompts, contracts, and skill bodies live in
`posse-remote/prompts/`. Local Posse fetches those pieces at boot via
`GET /v1/prompts/bundle`; it does not keep a prompt or skill mirror on disk.

## Project Overview

Paths below are relative to `posse/` unless they are explicitly rooted at the
workspace.

Posse (claude-org v4) is a SQLite-backed job queue orchestrator that coordinates
multiple LLM providers to execute development tasks in parallel. It decomposes
user work items through a preflight -> researcher -> planner -> delegator ->
dev/artificer/promote -> assessor pipeline, with lease-based scheduling, model
tier escalation, scoped file mutation, artifact workflows, and a split-screen
terminal UI.

## Architecture

### Structural Invariant

Within `posse/`, the class/function split is a hard structural boundary:

- `lib/classes/`: stateful domain objects with lifecycle and explicit
  construction.
- `lib/functions/`: stateless helpers, transforms, queries, and procedural
  orchestration helpers.
- `lib/catalog/`: domain enums (job/work-item statuses, types, tiers,
  assessor verdicts, ATLAS modes, etc.) and their derived SQL/Set forms. Pure
  data: no I/O, no DB, no logic beyond derived forms of the canonical array.
- `lib/domains/`: domain facades that organize existing class/function modules
  behind stable domain entrypoints.
  Remote prompt/encoder and key-gated remote service integrations belong under
  `lib/domains/remote/`.
- `lib/shared/`: shared helpers, primitives, and contracts that are genuinely
  cross-domain. Cross-domain infrastructure such as concurrency gates and
  thread worker lifecycles belongs under `lib/shared/concurrency/`, not under
  `lib/domains/`. Logging and run telemetry belong under
  `lib/shared/telemetry/`, with logging as a telemetry subsection. Database
  storage helpers belong under `lib/shared/storage/`. Format helpers belong
  under `lib/shared/format/functions/`. Scope and mutation policy primitives
  belong under `lib/shared/scope/`. Skills registry helpers belong under
  `lib/shared/skills/functions/`.

Every domain package keeps the second-tier class/function split:

```text
lib/domains/{domain}/
  index.js
  classes/index.js
  functions/index.js
```

That line is intentional and must survive the migration. A domain folder is
not a mixed dumping ground: stateful objects, lifecycle owners, constructor
heavy code, and `this`-bound behavior belong under `classes/`; stateless
helpers, transforms, queries, policy functions, and procedural orchestration
belong under `functions/`. If code is moved from the top-level
`lib/classes/` or `lib/functions/` trees into a domain, preserve that identity
at the second tier instead of blending the two categories.

Rules:

1. No module-level mutable state in `lib/functions/` unless it is a narrow,
   documented cache or test hook.
2. No class definitions or `this`-bound lifecycle logic outside `lib/classes/`.
3. Mixed domains are split across both stateful/stateless trees. For example,
   provider state lives in `lib/domains/providers/classes/`, while provider
   entry points and utilities live in `lib/domains/providers/functions/`.
4. New stateful behavior belongs in `lib/classes/<domain>/` and should be
   wired into callers through existing functional surfaces.
5. Domain facades must not merge class and function exports at the domain root;
   expose the two tiers as namespaces.
6. `lib/shared/` follows the same `classes/` and `functions/` split. Shared
   subpackages such as `lib/shared/concurrency/`, `lib/shared/telemetry/`,
  `lib/shared/storage/`, `lib/shared/format/`, `lib/shared/scope/`, and
  `lib/shared/skills/`, and `lib/shared/policies/` also keep `classes/` and
  `functions/` at the second tier.
7. Do not add tools or toolkit surfaces to `lib/domains/` during the initial
   migration; that area is being worked separately.
8. `lib/catalog/` imports from nothing else under `lib/`; both `lib/classes/`
   and `lib/functions/` may import from it freely. Adding a new domain enum
   (status, type, tier, role, mode) goes in the appropriate catalog file
   first, and the schema / runtime guards / display layer all derive from
   that single source.

### Entry Point

`orchestrator.js` is the CLI entry point. Command metadata lives in
`lib/domains/cli/functions/command-registry.js`, and command implementations
are split through `lib/domains/cli/functions/` plus the domain modules they
call.

Primary commands:

- Workflow: `add`, `plan`, `run`, `go`.
- Manage and inspect: `queue`, `status`, `health`, `dashboard`, `review`,
  `events`, `timeline`, `cost`, `fanout`, `calls`, `prompts`, `usage`,
  `sdl-smoke`, `mcp-status`, `codex-models`, `audit`, `admin`.
- Git lifecycle: `merge`, `prune`, `purge`, `cleanup`, `clear`.
- Mid-run and artifacts: `inject`, `ask`, `image`.

Run `node orchestrator.js help` for the full CLI reference.

### Core Surfaces

- `lib/functions/runtime/paths.js`: runtime root, database, resources, and log
  path resolution. Defaults are `.posse/`, `.posse/db/orchestrator.db`,
  `.posse/resources/`, and `.posse/logs/` under the target project.
- `lib/domains/queue/functions/`: SQLite state transitions for work items,
  jobs, attempts, artifacts, events, settings, locks, reviewable items, and
  history.
- `lib/domains/scheduler/classes/Scheduler.js`: poll loop, expired lease recovery,
  runnable-job selection, deadlock cancellation, leasing, and dispatch.
- `lib/domains/worker/classes/Worker.js`: job execution engine and shared
  worker state.
- `lib/domains/worker/classes/roles/`: role handlers for preflight,
  researcher, planner, delegate, developer, fix, assessor, artificer, and
  summary.
- `lib/domains/worker/functions/`: worker helpers for execution, planning,
  verdicts, artifact output, scope checks, mutation guards, hooks, diagnostics,
  and continuation.
- `lib/domains/handoff/functions/index.js`: deterministic routing packet and
  prompt assembly, including scope preflight, contract loading, context
  attachment, ATLAS context rendering, and file-request parsing.
- `lib/domains/providers/classes/`: provider classes and registry.
- `lib/domains/providers/functions/`: provider routing entry points, model
  catalog, API resilience helpers, abortable response helpers, tool runtime,
  and image generation internals.
- `lib/functions/git/`: worktree lifecycle, target branch resolution,
  commit-scope enforcement, snapshots, branch cleanup, merge helpers, and git
  utilities.
- `lib/functions/artifacts/index.js`: task modes, artifact roots, artifact
  protocols, manifest building, and artifact cleanup.
- `lib/domains/integrations/functions/`: deterministic MCP and ATLAS
  integration glue.
- `lib/domains/ui/classes/display/Display.js` and
  `lib/domains/ui/functions/display/`: terminal UI and formatting helpers.
- ATLAS semantic search can use local ONNX embeddings with the Jina code model.
  See `docs/atlas/embeddings-local-setup.md`; WI views default to lazy
  first-search encoding via `atlas_wi_embeddings=on_demand`.

### Monitor Agents UX Direction

Future agent-observability work should add **Monitor Agents** as its own UX
section instead of burying it inside logs or generic status output. The goal is
to let an operator select a running agent/job and see what it is doing, what
prompt/context it is currently operating from, and whether any operator nudges
are pending or acknowledged.

Design expectations:

- Use `posse/docs/monitor-agents-mockup.html` as the visual interaction
  reference: compact Posse mark, operator-console masthead, fleet roster with
  `live`/`ASK`/`nudge` state tags, focused agent timeline, prompt lens drawer,
  and a command bar that makes delivery semantics visible.
- In the live terminal TUI, Monitor Agents is opened with `m`. The first
  implementation should support cycling agents with `<` / `>`, jumping with
  `1`-`9`, and nudging the selected agent with `n`.
- Treat the assembled prompt as a read-only prompt lens, broken into source
  sections such as role contract, work item, scoped context, prior results,
  tool/runtime notes, and operator feedback. Do not make raw prompt text
  directly editable in place.
- Operator guidance should enter as a structured feedback/nudge block with
  metadata (`job_id`, `work_item_id`, author/source, timestamp, body,
  acknowledgement state), then be included at the next safe prompt/checkpoint.
- Agent feedback should expose operational state, not hidden chain-of-thought:
  current phase, gear changes, decisions worth surfacing, blockers, test/verify
  transitions, and finalization status.
- Store feedback/nudge activity durably in queue/event state so the terminal
  TUI, admin TUI, timeline/events views, and remote control surfaces can render
  the same audit trail.
- A clean conversation-mode loop should use explicit nudge availability,
  retrieval, and acknowledgement semantics rather than smuggling user guidance
  through arbitrary tool-response text.
- Monitor Agents should support focused actions first: select agent/job, view
  prompt lens, send suggestion/correction/scope-change request, request status,
  pause/resume/cancel where existing lifecycle controls allow, and show when
  the agent consumed the nudge.

## Runtime Files

Default runtime layout under a target project:

```text
<project>/
  .posse/
    db/orchestrator.db
    logs/
    resources/
      inputs/
      workspace/
      artifacts/
      context/
    recovered-worktrees/
    worktree-locks/
  .posse-worktrees/
    wi-{id}/
```

Important runtime paths:

| Path | Default |
|----------|---------|
| Runtime DB | `.posse/db/orchestrator.db` |
| Runtime directory | `.posse` |
| Resources directory | `.posse/resources` |
| Log directory | `.posse/logs` |

## Job Lifecycle

```text
queued
  -> leased
  -> running
  -> awaiting_assessment
  -> succeeded / failed / dead_letter / canceled
```

Assessment failures can spawn fix jobs and rewire downstream dependencies to
the fix. Human-input jobs move work into `waiting_on_human`. Assessor verdicts
can move work into `waiting_on_review` when human judgment is required.

## Git Branch Lifecycle

Each work item gets an isolated git branch and worktree for mutating jobs.

- Worktree path: `.posse-worktrees/wi-{id}`.
- Branch name: `posse/wi-{id}-{slug}`.
- Worktrees are created on the first dev/fix/promote job, not during
  research or planning.
- Legacy slugged worktree paths are detected and migrated to the canonical
  `wi-{id}` path when possible.
- Mutating jobs run with the worktree as `cwd`.
- File-level locking allows non-overlapping mutating jobs to run concurrently.
- Jobs without a declared file list are treated conservatively.
- Successful dev/fix/promote jobs are committed to the work-item branch.
- Failed or interrupted jobs snapshot dirty work before cleanup when possible.

Merge target resolution uses persisted settings first, then `main`/`master`.
The work item `merge_state` tracks `pending_review`, `merged`, and
`merge_failed`.

### Commit Messages

Do not append AI attribution trailers to commits or PR bodies in this
workspace — no `Co-Authored-By: Claude ...`, no `Generated with Claude Code`
footers. Write plain commit messages describing the change.

### Public Client Sync

After committing and pushing Posse changes to `origin`, run
`node scripts/sync-clean-client.mjs` from `posse/` to update the clean public
client repo (`mtstedman/posse-client`). This script mirrors committed `main`
into the `clean-main` branch, strips internal scripts/tests, verifies the tree,
and pushes `clean-main` to the `clean` remote's `main` branch.

### Native Binary Deployment

Native Rust binaries (`posse-git`, `posse-atlas`, `posse-remote`) are deployed
with `node scripts/deploy-native.mjs` from `posse/`, not by hand. It pushes the
`posse-encoder-rust` repo (test-gated by its pre-push hook), rebuilds + stages
binaries into `posse/lib/bin/`, commits them here, and cleans up build relics.
The full procedure and flags are documented in the encoder repo's `AGENTS.md`
(the single source of truth for the Rust workspace). Run `--dry-run` to preview.

## Task Modes

| Mode | Purpose | Writes allowed |
|------|---------|----------------|
| `code` | Repo edits | Declared file scope |
| `report` | Reports, summaries, exports | `artifacts/wi-{id}/` |
| `content` | Assets and creative deliverables | `artifacts/wi-{id}/` |
| `image` | Generated images | `artifacts/wi-{id}/` |
| `intake_processing` | Process uploads | `workspace/wi-{id}/`, `artifacts/wi-{id}/` |

Artifact roots live under `.posse/resources`:

- `inputs/wi-{id}/`: read-only user-provided source material.
- `workspace/wi-{id}/`: mutable scratch space.
- `artifacts/wi-{id}/`: final deliverables.
- `context/wi-{id}/planner/fast/`: researcher-curated brief context.
- `context/wi-{id}/planner/full/`: source files selected by research.
- `context/wi-{id}/job-{id}/`: per-job scoped context.

Promote jobs deterministically copy approved artifacts from
`.posse/resources/artifacts` into repository paths. They do not call an AI
provider and they do not run assessment.

## Provider Architecture

Posse supports Claude, OpenAI, Codex, Grok, and Copilot through provider-neutral worker
interfaces.

- `model_tier` is provider-neutral (`cheap`, `standard`, `strong`).
- `model_name` stores the provider-specific model.
- `provider` stores the selected provider for the job.
- Provider routing is configured through the account settings database/admin UI.
  Do not add provider routing environment variables.
- When multiple providers are configured for a role, the delegator assigns
  provider and model per job.

Provider modules expose a common call surface through
`lib/domains/providers/functions/` and class-backed implementations through
`lib/domains/providers/classes/`.

## SDL/MCP Reference Material

The sibling `sdl-mcp/` workspace directory is not part of Posse. It is a
separate reference project for comparing SDL/MCP ideas against ATLAS. Do not
inspect, edit, migrate, test, or include it in Posse cleanup work unless the
user explicitly asks for reference-only research.

## Configuration Policy

The account settings database is the source of truth for Posse configuration.
Use `lib/functions/settings/catalog.js` for new settings and route them through
the admin UI / account DB. Do not introduce environment-variable backed
configuration for SDL, provider routing, model selection, timeouts, paths,
feature flags, or one-off debug switches.

Environment variables are allowed only for AI/provider credentials. Child
processes may inherit ordinary OS process state like `PATH` when needed to
launch tools, but Posse must not read or create environment variables for
configuration. Credential environment variables currently include:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API key |
| `CODEX_API_KEY` | Optional Codex CLI API-key auth |
| `XAI_API_KEY` | xAI API key |

If a new runtime choice feels like it wants an environment variable, add an
admin setting instead. If a child process needs structured runtime context,
prefer a DB row, config file, command argument, or explicit IPC payload over a
new environment variable.

## Testing

Prefer targeted tests for the code paths changed. During normal iteration, run
the relevant `fast` suite first. Run `slow` only when the change touches
slow-covered integration/lifecycle behavior, when a fast result is inconclusive,
or when specifically validating a slow path. Use `full` for broader pre-merge
confidence or when both shards need to be exercised together.

Avoid running the full npm suite unless it is truly needed for confidence. It
is still allowed when a change crosses shared test infrastructure,
routing/catalog surfaces, persistence boundaries, or otherwise cannot be
validated safely with targeted tests.

Default suite:

```bash
npm test
```

`npm test` runs `scripts/clean-test-artifacts.mjs`, then
`scripts/run-tests.mjs`. The runner executes `test/core.test.js` plus every
root-level `test/test-*.test.js` file.

### What to run for a change

Targeted core suites run via `node scripts/run-core-suite.mjs <selector> <mode>`
(`mode`: `fast` | `slow` | `full`). A selector is a **shard** tag, a suite-name
substring, `re:<regex>`, `all`, `quick` (everything not tagged `slow`), or `slow`;
combine with commas/spaces. Use this table first instead of discovering by hand —
start at `fast`, escalate to `slow`/`full` when the change touches
integration/lifecycle behavior or a `fast` result is inconclusive.

| You changed (under `lib/domains/` unless noted) | Run |
|---|---|
| `ui/**` (TUI, display, monitor) | `run-core-suite.mjs ui fast` |
| `queue/**`, `scheduler/**` (leases, deadlock, dispatch) | `run-core-suite.mjs scheduler fast` |
| `handoff/**` (handoff context, file requests) | `run-core-suite.mjs handoff fast` |
| `providers/**` (routing, catalog, health, capacity) | `run-core-suite.mjs provider fast` |
| `atlas/**` (retrieval, warm, gate) | `run-core-suite.mjs atlas fast` |
| `git/**` (worktree, push, dirty guard) | `run-core-suite.mjs git fast` + the serial git/worktree root tests (see below) |
| `artifacts/**`, `assessment/**` | `run-core-suite.mjs artifact fast` |
| `planning/**`, `research/**` | `run-core-suite.mjs planning fast` |
| `functions/toolkit/**`, deterministic image/tool runtime | `run-core-suite.mjs toolkit fast` |
| `integrations/**` (deterministic MCP server/tools) | `run-core-suite.mjs re:deterministic fast` |
| `observability/**` (observations, telemetry) | `run-core-suite.mjs re:observ fast` |
| Cross-cutting / shared infra / not sure | `npm test` (both lanes) |

Some suites carry no shard tag (e.g. `Deterministic MCP server`, `Project context
and observations`) — target those by name substring or `re:<regex>`. When a change
shells out to real `git`, a daemon, or a socket, its root-level test lives in the
**serial lane**; run it with `node scripts/run-tests.mjs serial` (or the whole file
via `node --test test/<file>.test.js`).

The `npm run test:<group>[:fast|:slow|:full]` aliases under **Focused suites**
below are thin wrappers over these selectors.

### Discovering suites and shards

When the table above doesn't cover a change, list what exists instead of guessing:

```bash
node scripts/run-core-suite.mjs --list        # shard tags (with counts) + every suite and its shards
node scripts/run-core-suite.mjs --list-json    # machine-readable { modes, selectors, groups, suites }
```

The same data is exported as `listCoreSuites()` from `scripts/run-core-suite.mjs`
for tooling — importing the module does not run any tests.

### Test execution model

`node --test` runs each file in its own process and runs those files
concurrently. `scripts/run-tests.mjs` splits the root-level files into two
passes for that reason:

- **Concurrent pass** — the default, for files that are isolated (in-memory
  SQLite or unique `mkdtemp` sandboxes).
- **Serial pass** — files listed in the `SERIAL_ONLY` manifest in
  `scripts/run-tests.mjs`, run with `--test-concurrency=1` after the concurrent
  pass drains. A file belongs here when it shells out to real `git` (worktree
  add/remove locks `.git` on Windows), spawns the orchestrator / a daemon / an
  MCP child, or binds a real socket. Run concurrently these race on shared OS
  resources and surface as flaky Windows `EPERM`/`EBUSY` failures. Run only the
  serial or concurrent pass with `node scripts/run-tests.mjs serial` /
  `... parallel`.

The runner also sets `POSSE_TEST_RUN=1` for every test process and every child
it spawns. The account-settings layer (`AccountSettings.isUnderTest()`) treats
that — or `NODE_TEST_CONTEXT` — as a signal to redirect an unset
`POSSE_ACCOUNT_DB_PATH` to a per-process temp DB, so **no test or spawned child
ever opens the operator's real `~/.posse/account.db`**. Opening the real path
under test context throws (a tripwire). A test that needs specific account
settings must seed its own sandbox (set `POSSE_ACCOUNT_DB_PATH` for children, or
`setAccountSettingsPathForTests` in-process); it cannot rely on the real DB.

Large test files are sharded by splitting at `describe` boundaries (each shard
is self-contained). Files that are one big `describe` of flat, **independent**
`it`s can also be grouped into `… (part N/M)` shards. Files whose tests are
order-dependent, share mutable state across `it`s, or contain a coverage
meta-test that introspects the whole suite (e.g. "every action is covered by
this suite") are **not** mechanically shardable and are left whole.

### Per-file run times and timeout estimates

Every `npm test` records each file's wall-clock time (via
`test/support/timing-reporter.mjs`) into `.posse-test-timings.json` (gitignored,
last 20 runs per file). Surface the rolling averages with:

```bash
npm run test:timings                 # all files, slowest first
node scripts/test-timings.mjs --lane serial    # only the serial pass
node scripts/test-timings.mjs --k 3            # average the last 3 runs
```

It prints per-file avg/max/last plus a suggested per-file timeout (worst recent
run + 50%), and a collective estimate per lane — the serial lane as the sum of
file times, the concurrent lane bounded by the pool — to size suite timeouts.

Focused suites:

```bash
npm run test:core-only
npm run test:core-only:fast
npm run test:core-only:slow
npm run test:core-only:full
npm run test:quick
npm run test:scheduler
npm run test:scheduler:fast
npm run test:scheduler:slow
npm run test:scheduler:full
npm run test:atlas
npm run test:atlas:fast
npm run test:atlas:slow
npm run test:atlas:full
npm run test:providers
npm run test:providers:fast
npm run test:providers:slow
npm run test:providers:full
npm run test:handoff
npm run test:handoff:fast
npm run test:handoff:slow
npm run test:handoff:full
npm run test:planning
npm run test:planning:fast
npm run test:planning:slow
npm run test:planning:full
npm run test:toolkit
npm run test:toolkit:fast
npm run test:toolkit:slow
npm run test:toolkit:full
npm run test:artifacts
npm run test:artifacts:fast
npm run test:artifacts:slow
npm run test:artifacts:full
npm run test:git
npm run test:git:fast
npm run test:git:slow
npm run test:git:full
npm run test:ui
npm run test:ui:fast
npm run test:ui:slow
npm run test:ui:full
npm run test:slow
```

For docs-only changes, run at least `git diff --check` and a targeted grep for
the stale text being removed.

## Design Decisions

- Jobs are leased with compare-and-swap tokens to prevent double execution.
- Expired leases are requeued by the scheduler.
- Work item branches isolate mutating work.
- File-scope locks prevent overlapping writes across concurrent jobs.
- Dev/fix/promote jobs commit scoped changes and record attempt metadata.
- Assessor failures spawn fix jobs when automation can continue.
- Deadlocked dependency chains are canceled deterministically.
- File requests let dev jobs ask for out-of-scope files through gated follow-up
  jobs instead of silently escaping scope.
- Recovery snapshots are stored locally under `refs/posse/snapshots/*` with
  notes in `refs/notes/posse-snapshots`.

Avoid broad pushes such as `git push --all`, `git push --mirror`, or custom
refspecs that include `refs/*`, because they can publish local recovery refs.
