# Posse (claude-org v4)

Posse is a SQLite-backed job orchestrator for repository work. It queues work
items, decomposes them into jobs, routes jobs to the configured provider, runs
mutating work in isolated git worktrees, and records scheduling, attempts,
reviews, artifacts, prompts, outputs, events, and costs in SQLite.

The npm package name is still `claude-org`, but the current system name is
`Posse`. The package exposes both `posse` and the legacy `claude-org` command
names.

## Architecture

```text
work item
  -> preflight
  -> researcher
  -> planner
  -> delegator (optional, when multiple providers are enabled)
  -> dev / artificer / promote / human_input
  -> assessor
  -> fix or human review when needed
```

Key behavior:

- Lease-based scheduling with expired-lease recovery.
- Dependency-aware execution and deadlock cancellation.
- Per-work-item git worktrees for mutating jobs.
- File-scope locking so non-overlapping mutating jobs can run in parallel.
- Provider routing across Claude, OpenAI, Codex, Grok, and Copilot.
- ATLAS semantic search with optional local ONNX embeddings:
  [setup](docs/atlas/embeddings-local-setup.md).
- Artifact workflows for reports, content, images, and intake processing.
- Human-input and review gates when automation should pause.

## Repository Map

- `orchestrator.js`: CLI entry point and command bootstrap.
- `lib/catalog/`: canonical domain enums and pure catalog data.
- `lib/domains/`: domain packages with `classes/` and `functions/` tiers.
- `lib/shared/`: cross-domain primitives, storage, telemetry, scope, policies,
  and shared tools infrastructure.
- `lib/domains/queue/functions/index.js`: SQLite-backed state transitions and
  queue logic.
- `lib/domains/scheduler/classes/Scheduler.js`: poll loop, leasing, deadlock
  checks, and dispatch.
- `lib/domains/worker/classes/Worker.js`: job execution engine.
- `lib/domains/worker/classes/roles/`: role handlers for researcher, planner,
  developer, assessor, delegator, artificer, preflight, fix, and summary.
- `lib/domains/handoff/functions/index.js`: deterministic prompt/context
  assembly.
- `lib/domains/providers/functions/`: provider entry points and routing helpers.
- `lib/domains/git/functions/`: worktree, commit-scope, merge, and recovery
  helpers.
- `lib/domains/runtime/functions/paths.js`: runtime root, DB, resources, and log
  paths.
- `lib/shared/tools/`: deterministic toolkit contracts, MCP/native tool owners,
  daemon supervision, and hash-ref tool context storage.
- Runtime prompt pieces: fetched from `posse-remote` with
  `GET /v1/prompts/bundle` and kept in process memory only.
- `test/`: core regression suite, focused suite wrappers, and root-level
  integration tests.

## Remote Tool Authority

`posse-remote` is authoritative for the resolved role, exact tool allowlist,
web-access maximum, project database capability, and broad read/write/shell/test
policy. Posse treats that response as a ceiling. Runtime availability, task
mode, file scope, and operator settings may remove capabilities but never add
them.

Missing or mismatched issuance fails closed. Provider contracts intersect base
and attached tools with the exact remote list; MCP owner tokens carry the same
suite-scoped allowlist and server-derived policy facts. Unsigned boot payloads
cannot widen signed claims. `project_db_query` additionally requires the issued
`read` or `write` capability and the repository's configured SQL grants. Web
tools require both the issued role grant and the operator kill switch. Internal
ATLAS orchestration actions, including `edit.plan` and `workflow`, are excluded
from provider and MCP surfaces even if a caller asserts them.

## Runtime Paths

By default, Posse stores runtime state inside the target project:

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
  .posse-worktrees/
    wi-{id}/
```

Important defaults:

- `ORCHESTRATOR_DB`: `.posse/db/orchestrator.db`
- `POSSE_RUNTIME_DIR`: `.posse`
- `POSSE_RESOURCES_DIR`: `.posse/resources`
- Worktree path: `.posse-worktrees/wi-{id}`
- Work item branch: `posse/wi-{id}-{slug}`

Older slugged worktree directories are detected and migrated to the canonical
`wi-{id}` path when possible.

## Requirements

- Node.js with npm.
- Git.
- ripgrep (`rg`) for deterministic MCP `search_files`.
- Tesseract OCR (`tesseract`) for image text extraction.
- ImageMagick (`magick`) and FFmpeg (`ffmpeg`) for image/video conversion
  fallbacks.
- Python 3.9+ plus `requirements.txt` packages for file and image helper tools.

The Posse + ATLAS installers attempt to install first-run host tools
automatically. On Linux they use the detected package manager (`apt-get`,
`dnf`, `yum`, `pacman`, or `zypper`). On Windows they use `winget` packages
for ripgrep, Tesseract OCR, ImageMagick Q16, and FFmpeg. If `rg` is installed
outside `PATH`, set `POSSE_RIPGREP_PATH` or `POSSE_RG_PATH`.

## Quick Start

From the Posse package directory:

```bash
npm install
npm link
posse add "Build user auth"
posse plan
posse run
```

Or run planning and execution together:

```bash
posse go
```

Use `node orchestrator.js help` for the full CLI reference.

## Upgrade Notes

- Admin-set global model overrides act as defaults; explicit per-job model names
  and delegator/escalation choices take precedence.

## Core Commands

- `add`: queue a work item.
- `queue`: list work items.
- `plan`: research queued items and create jobs.
- `run`: execute pending jobs.
- `go`: run `plan` and `run` together.
- `status [--active] [--limit N|all] [--json]`: show bounded job/work-item status, filter to active work, or emit JSON.
- `health`: show stuck-job and failure signals.
- `dashboard`: show the TUI dashboard.
- `review`: generate review output and collect approval decisions.
- `inject`: add work while a run is in progress.
- `ask`: answer waiting human-input jobs.
- `image`: generate an image directly.
- `events`, `timeline`, `cost`, `fanout`, `audit`, `calls`, `prompts`,
  `usage`, `atlas-smoke`, `mcp-status`, `codex-models`: inspection commands.
- `local-models [list|download]`: inspect the signed local-model catalog or
  select a pinned bundle for a confirmed, resumable download.
- `admin`: open stats and settings tooling.
- `merge`: merge approved work.
- `prune`, `purge`, `cleanup`, `clear`: maintenance and reset commands.

## Local Model Downloads

Run `posse local-models` for an interactive selector, or use
`posse local-models list` to inspect the verified catalog without downloading.
Every model entry shows its signed download size, minimum and recommended
memory, recommendation summary, intended use cases, runtime profile, and
license. `posse local-models download <shorthand>` selects a model directly.

Before any bundle bytes are requested, Posse presents a second confirmation
containing both the human-readable and exact byte size. The default answer is
No, and `--yes` or non-interactive input cannot bypass the prompt. Confirmed
downloads show percentage, transferred bytes, throughput, and ETA while the
native Remote client performs resumable transfer and SHA-256 verification.
Verified bundles are stored below `~/.posse/artifacts/llm-models/`.

## ATLAS SCIP Languages

`atlas_scip_languages` controls which Posse-managed SCIP indexers are eligible
for ATLAS v2 warmup. Edit it from `posse admin` to use the checkbox selector; on
save, Posse runs the matching dependency setup for the selected languages.

You can run the same setup explicitly:

```bash
posse atlas-v2 scip install --lang typescript --lang python
posse atlas-v2 scip install --all --dry-run
```

Supported selectors are `typescript`, `python`, `php`, `go`, and `rust`.
`typescript` and `python` install the bundled npm indexers, `php` runs the
bundled Composer setup, `go` installs `scip-go` into `scip/bin`, and `rust`
creates a `scip-rust` wrapper around `rust-analyzer scip`.

## Testing

Run the default regression suite:

```bash
npm test
```

Run static checks plus tests:

```bash
npm run check
```

## Continuous Integration and Deployment

Operator deployment definitions live in
`/home/mason/repos/deployment/posse/CI`. The repository-root
`.github/workflows/ci.yml` is the GitHub-required mirror of the canonical
workflow there. Run
`/home/mason/repos/deployment/shared/CI/sync-workflow-mirrors.sh --check` to
verify that every repository mirror is current.

Native deployment and clean-client synchronization run directly from the
centralized `CI/` directory; there are no repository-local deployment
launchers. Only committed work can be published: pushing or synchronizing
reconstructs the client from the pushed source and does not preserve
uncommitted, in-flight changes.

`npm test` first runs `scripts/clean-test-artifacts.mjs`, then
`scripts/run-tests.mjs`. The runner executes `test/core.test.js` plus every
root-level `test/test-*.test.js` file.

Focused suites are available when you only need a specific area:

```bash
npm run test:core-only
npm run test:quick
npm run test:scheduler
npm run test:atlas
npm run test:providers
npm run test:handoff
npm run test:planning
npm run test:toolkit
npm run test:artifacts
npm run test:git
npm run test:ui
npm run test:slow
```

Estimated runtimes from recent local Windows runs are below. Use the
allocation column for CI and automation timeouts; add more buffer on colder or
slower hosts. Focused suites do not run `pretest`, so run `npm run test:clean`
first when stale artifacts matter.

| Command | Covers | Recent local time | Suggested allocation |
|---------|--------|-------------------|----------------------|
| `npm test` | Default regression run: `pretest`, `test/core.test.js`, and root-level `test/test-*.test.js` files | ~13m | 15m |
| `npm run test:core-only` | All correctness-critical core suites in `test/core.test.js` | ~6m 10s | 8m |
| `npm run test:quick` | Non-slow core suites | ~5m 15s | 7m |
| `npm run test:scheduler` | Lease, deadlock, scheduler, and runnable-job core suites | ~25s | 1m |
| `npm run test:atlas` | ATLAS integration, smoke, and routing core suites | ~45s | 2m |
| `npm run test:providers` | Provider-tagged core suites plus provider OOP coverage | ~20s | 1m |
| `npm run test:handoff` | Handoff and file-request core suites | ~40s | 2m |
| `npm run test:planning` | Planner and researcher-tagged core suites | ~10s | 1m |
| `npm run test:toolkit` | Deterministic toolkit, tool runtime, and image resize suites | ~20s | 1m |
| `npm run test:artifacts` | Artifact routing, assessment, fix, and manifest suites | ~10s | 1m |
| `npm run test:git` | Git, worktree, pre-push, dirty-worktree, and merge-safety coverage | ~5m 15s | 7m |
| `npm run test:ui` | Queue rendering, admin TUI, and timeline UI-adjacent suites | ~25s | 1m |
| `npm run test:slow` | Slow-tagged core suites | ~5m | 7m |

## Runtime Prompts And Local Docs

`CLAUDE.md` is for local development on Posse itself. Runtime jobs do not read
it.

Runtime behavior comes from the authenticated `posse-remote` prompt bundle:
role prompts, shared contracts, role-contract mappings, and skill bodies are
fetched at boot and kept in process memory only. Do not add a local
`prompts/` mirror; edit `posse-remote/prompts/` when changing agent behavior.

The remote prompt and compiler service is an intentional fail-closed boundary.
`run` and `go` should not continue from a persisted "last good" prompt bundle
when `posse-remote` is unavailable: paid prompt, skill, contract, and routing
logic belongs behind the authenticated remote service or in native binaries.
Persist only diagnostic metadata such as versions or timestamps, not reusable
prompt/skill bodies that would let a run proceed offline.

## Task Modes And Artifacts

Jobs default to `task_mode: "code"`. Non-code work uses scoped artifact roots
under `.posse/resources`.

| Mode | Purpose | Writable roots |
|------|---------|----------------|
| `code` | Repo edits | Declared file scope |
| `report` | Reports, summaries, exports | `artifacts/wi-{id}/` |
| `content` | Assets and creative deliverables | `artifacts/wi-{id}/` |
| `image` | Generated images | `artifacts/wi-{id}/` |
| `intake_processing` | Process user-provided inputs | `workspace/wi-{id}/`, `artifacts/wi-{id}/` |

Promote jobs deterministically copy approved artifacts from
`.posse/resources/artifacts` into repository paths.

## Git And Recovery

Mutating jobs run in per-work-item git worktrees. Successful dev/fix/promote
jobs are committed on the work-item branch. Failed or interrupted work is
snapshotted before cleanup when possible.

Recovery snapshots are stored as local refs under `refs/posse/snapshots/*` with
metadata in `refs/notes/posse-snapshots`.

Normal pushes (`git push`, `git push origin main`) do not publish these refs.
Avoid broad ref pushes such as:

- `git push --all`
- `git push --mirror`
- custom push refspecs that include `refs/*`

Those can unintentionally publish local recovery snapshots.

## Linux Installer Package

To build a portable Linux installer bundle for ATLAS-enabled Posse:

```bash
bash scripts/package-linux-installer.sh
```

That creates a versioned tarball under `dist/` containing:

- `install-posse-atlas.sh`
- installer README with usage

Installer source lives in `installers/linux/install-posse-atlas.sh`.
