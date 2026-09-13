# Posse (claude-org v4)

Posse is a SQLite-backed job orchestrator for repository work. It queues work
items, decomposes them into jobs, routes jobs to the configured provider, runs
mutating work in isolated git worktrees, and records scheduling, attempts,
reviews, artifacts, prompts, outputs, events, and costs in SQLite.

The npm package name is still `claude-org`, but the current system name is
`Posse`. The package exposes both `posse` and the legacy `claude-org` command
names.

For first-time setup, start with the [installation walkthrough](installers/README.md).

## Architecture

```text
work item
  -> preflight
  -> researcher
  -> planner
  -> delegator (optional, when multiple providers are enabled)
  -> dev / artificer / promote
  -> assessor
  -> fix or an internal human gate when needed
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
- Durable typed human-input and review gates with one authoritative,
  idempotent resolution per original job and recovery kind.
- Independent per-implementation assessment retry accounting: assessor
  transport/tool failures preserve completed implementation and escalate
  assessment only; a new implementation attempt starts a fresh assessment
  retry budget.
- Handoff-owned creation materialization: planners declare exact
  `files_to_create`, but writing providers receive existing
  `files_to_modify` paths and no generic creation authority.
- Manifest-root-aware verification readiness with explicit `passed`,
  `failed`, and `unavailable` outcomes.

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

## Codex MCP batching

Restricted Codex researcher, planner, assessor, and developer sessions default
to native MCP batching. Several ready calls may share a model turn. Researcher
reads may run concurrently; planner, assessor, and developer operations execute
in order, including writes. Scope approvals, sub-agent control, dependent
decisions, and terminal handoff remain separate. An explicit
`nativeBatching: false` provider option retains the previous transport.

Native batching creates a temporary transport catalog from the selected Codex
CLI's `debug models --bundled` output, preserving the selected model's other
metadata. The CLI must contain that exact model. An explicitly supplied
`nativeBatchingCatalog` provider option is validated. The legacy
`POSSE_CODEX_RESEARCH_MODEL_CATALOG` configures the researcher catalog only;
it is not needed to enable batching. Temporary catalogs are cleaned up when the
provider invocation ends. The user's Codex configuration is not rewritten.

These restricted batching sessions suppress Codex host utilities, including
plain sleep and native collaboration. Posse-issued sub-agent tools retain their
concurrent dispatch, `wait_all`, and status waits. Explicit native-tool sessions
retain their host coordination and sleep capabilities.

### Initial research routing

For repository work that should always start with a researcher, set
`intake_routing_mode=research_first` with `posse admin set intake_routing_mode research_first`.
This bypasses preflight and direct-plan intake decisions for new work items;
validated one-shot and web-only requests keep their specialized routes. The
default is `auto`. This setting does not reroute jobs already queued.

### Experimental planner dispatch

Set repository settings `planner_dispatch_mode=planner` and
`agent_coordination_mode=subagents` to enable planner-led intake. The default
`router` retains the existing upfront research/preflight flow. On the gated route,
the planner can plan simple work directly or call one tool:

```json
{"agent_type":"code","question":"Find the request validation path and its tests","budget":{"reasoning_effort":"medium","max_turns":12}}
```

`dispatch_agent` accepts `agent_type: "code" | "web"`. Code children investigate
the repository with read-only tools; web children use online research. Each call
blocks and returns a compact evidence-backed report. Child calls do not receive
the parent's transcript or dispatch tools. Existing citation-only `sub_agent`
behavior remains available to its existing callers; gated planners receive only
`dispatch_agent` for delegation.

Repository settings bound total children per planner call (default 2), child
turns (24), timeout (1200 seconds), effort (high), and returned report size
(12000 characters). The triage turn setting is prompt guidance; child limits are
runtime-enforced. The separate dispatch MCP timeout (1500 seconds) reserves time
to return results. Existing child cancellation and stall handling are reused.

Monitor Agents shows code/web child rows with their question, progress, tool
history, provider/model/effort, and completion state. Select a running child and
press `n` to send guidance to that exact call. Parent and sibling nudges remain
separate. Agent-call records and planner completion events retain child lineage,
usage, questions, and the zero-child decision.

Testing requires the matching `feat/planner-dispatch-framework` remote branch
for the code-child prompt and capability contract. Use both workbranches with an
isolated test repository and enable the two settings there. Test a simple direct
plan, a code investigation, a web investigation, a child nudge, and a canceled
parent. The feature remains off by default. Oneshot and web-only intake retain
their existing routes; red-team/synthesis and assessment loopbacks cannot dispatch.

## Assessment replanning

An assessor's `needs_replan` verdict returns directly to the standard planner.
The planner receives the failed task, its success criteria and test command,
assessor reasons, original scope/commit, and a record of retained work. Local
preparation selects a read-only work-item branch snapshot and supplies the commit
diff when available. Prior research remains historical context; the planner
checks the affected current source before revising the remaining plan.

Both researcher-dispatch tools are disabled on this route, independently of
`planner_dispatch_mode`. Stale queued branches are canceled transactionally;
completed work and implementations awaiting assessment are retained. The existing
`posse_max_replans` limit counts direct planner cycles and legacy research cycles.
Already-queued research loopbacks continue through their existing continuation.

## Scope approval

Use `posse run --scope-mode=auto` or `posse go --scope-mode=auto` to approve
file-scope expansion requests automatically while keeping the run interactive.
This includes requests triggered by out-of-scope edits, one-shot file requests,
high-risk file requests, and fix scope gates that spawn the proposed fix.
Existing waiting scope gates for the selected work items are resumed through
the same approval policy.

The flag applies only to that run. Omitting it, or using `--scope-mode=default`,
preserves the existing `scope_auto_approval` policy and interactive or
non-interactive behavior. Scope mode does not change plan approval, publication,
assessment, or clarification decisions. Approved paths still pass the normal
scope validation, protected-path, and file-lock checks. This flag does not
enable the proposed one-shot claim/release workflow.

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

## Install, sign up, and start

Follow the [installation walkthrough](installers/README.md) for obtaining a
Posse key, requirements, key storage, and your first task. Platform guides:

- [Windows](installers/windows/README.md): hidden key input, automatic Node/npm,
  winget host tools, and a verified Node ZIP fallback.
- [Linux and containers](installers/linux/README.md): automatic Node/npm,
  unattended installs, and setup-only image builds.

> **Windows scripts disabled?** The [Windows guide](installers/windows/README.md)
> includes notes for execution policy, `Unblock-File`, and refreshing PATH.

Node **24+ with npm** is required and automatically installed by the scripts.
You need a Posse access key and a configured model provider to run work.

After installation, run commands in the Git project you want Posse to work on:

```bash
cd /path/to/your/git-project
posse doctor
posse admin
posse add "Describe the change you want"
posse go
```

`posse go` plans and runs queued work. Boot checks required dependencies,
attempts doctor repair when unhealthy, and stops if verification still fails.
Use `posse help` for the full CLI reference.

## Upgrade Notes

- Admin-set global model overrides act as fallbacks; explicit per-job model
  names and cheap/standard/strong tier routing take precedence.

## Core Commands

- `add`: queue a work item.
- `queue`: list work items.
- `plan`: research queued items and create jobs.
- `run`: execute pending jobs.
- `go`: run `plan` and `run` together.
- `status [--active] [--limit N|all] [--json]`: show bounded job/work-item status, filter to active work, or emit JSON.
- `serve [--pair]`: expose this clone's queue and controls to paired phone/web clients.
- `pair [host|join|status|leave]`: collaborate from separate clones through a shared Git side trunk and see bounded, read-only peer work-item/job summaries outside the local queue.
- `health`: show stuck-job and failure signals.
- `dashboard`: show the TUI dashboard.
- `review`: generate review output and collect approval decisions.
- `gate answer <gate-job-id> <action> [--feedback ...]`: resolve a parked human gate from a headless shell.
- `inject`: add work while a run is in progress.
- `ask`: queue a research-only question.
- `image`: generate an image directly.
- `events`, `timeline`, `cost`, `fanout`, `audit`, `calls`, `prompts`,
  `usage`, `atlas-smoke`, `shared-trunk-smoke`, `mcp-status`, `codex-models`:
  inspection and disposable smoke commands.
- `local-models [list|download]`: inspect the signed local-model catalog or
  select a pinned bundle for a confirmed, resumable download.
- `admin`: open stats and settings tooling.
- `merge`: merge approved work.
- `prune`, `purge`, `cleanup`, `clear`: maintenance and reset commands.

### Native provider and admin JSON

`posse usage --json` emits one bounded `posse.provider_usage.v1` document on
stdout. Use `--refresh` for a normal provider refresh and `--force-refresh` for
an operator-forced probe; diagnostics remain on stderr. The payload preserves
finite, unlimited, and unknown capacity windows, budget configured-vs-unset
state (including numeric zero), and measured-vs-unavailable spend without raw
provider responses or credentials. Human `posse usage` output is unchanged.

`posse admin describe --json` emits the generated `posse.admin.v1` settings
catalog, including type, scope, numeric/options metadata, editability, and
source/default state. Sensitive rows expose presence only. Mutations use
`posse admin set <key> <value> --json` and `posse admin clear <key> --json`;
callers handling secrets should use `posse admin set <key> --json --stdin-value`
so the value never enters argv. JSON errors are stable envelopes; the existing
human admin commands remain compatible.

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

Runs report only what needs reading. A passing file prints nothing (a terminal
gets one overwriting progress line); a failing file prints the moment it
finishes, with its failed test names, errors and captured output; and each pass
closes with the counts and a command that re-runs exactly the files that
failed:

```text
FAIL test/test-waiting-lane-demand.test.js  (1 of 12 failed, 0.4s)
  waiting lane demand > counts only unclaimed jobs
      Expected values to be strictly equal: 3 !== 2
      at TestContext.<anonymous> (file:///.../test/test-waiting-lane-demand.test.js:88:12)
concurrent pass: 1 of 236 files failed: 2913 passed, 1 failed in 61.2s
failed files:
  test/test-waiting-lane-demand.test.js
re-run: node scripts/run-tests.mjs files test/test-waiting-lane-demand.test.js
```

`node scripts/run-tests.mjs files <file>...` runs just the named files, each in
the pass (concurrent or serial) it belongs to, with the sandbox environment a
bare `node --test` would not set. To narrate every passing test again, set
`POSSE_TEST_REPORTER=spec` (or `tap`, `dot`) for node's own reporters.

Off Windows the two passes run together, and the serial pass runs four files at
a time rather than one. Measured on this suite (Linux, 16 cores): the serial
pass alone takes 315s at width 1, 122s at width 4 and 112s at width 8, always
with identical results; running both passes together as well brings a full run
from 524s to about 285s. Nothing in the serial list collides with anything else
in it — sockets and pipes already carry per-process unique names and fixture
repositories are `mkdtemp`'d — so the pass is capping how many heavy files run
at once rather than keeping conflicting pairs apart.

Windows keeps the original shape: one serial file at a time, strictly after the
concurrent pass drains. That is where the EPERM/EBUSY flakiness the split
exists for was seen, and none of the above was measured there. To try it:

```bash
POSSE_SERIAL_CONCURRENCY=4 POSSE_OVERLAP_PASSES=1 npm test
```

Both knobs work everywhere, so `POSSE_OVERLAP_PASSES=0` restores the sequential
passes on any platform.

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

Test discovery, serial/resource classification, nested core membership, and
the `ci_portable` / `ci_windows` workflow partitions share
`test/test-catalog.json`. Run `npm run test:catalog:check` after adding or
moving a test. The check fails for missing, duplicate, unclassified, or
catalogued-but-deleted files; it also verifies every nested core suite is
actually imported by `test/core.test.js`.

Each `scripts/run-tests.mjs` invocation also writes a unique run directory
under `.posse-test-runs/`. Its atomic lane fragments and final `run.json`
record the commit/tree identity, OS and Node version, lane configuration,
catalog hash, per-file durations, categorized skips, stable failure
fingerprints, and directly runnable reproduction commands. The timing ledger
remains only a derived scheduling cache.

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

### Verification time policy

Posse runs a repository's frozen test command and its canonical verification
command under a declared time policy instead of a fixed 120-second cap:

| Setting | Scope | Default | Meaning |
|---------|-------|---------|---------|
| `verification_wall_timeout_ms` | repository | 120000 | Wall-clock limit for a frozen test or canonical verify run. Set it to the window this table documents for the repository's own harness (for Posse itself, 900000). |
| `verification_idle_timeout_ms` | repository | disabled | Kill a run that produces no output for this long. Enable only for harnesses that print progress while healthy; `npm test` here prints a heartbeat every 30s when headless, so it qualifies. |
| `verification_wall_timeout_max_ms` | account | 1800000 | Administrator ceiling. Repository values above it are clamped, so a repository cannot pin a worker indefinitely. |
| `verification_dependency_network_policy` | repository | cache_only | Dependency repair may use only existing caches, may use the network (`allow`), or is disabled. Repairs always require a repository lock and frozen/no-script flags. |

Every receipt records normalized argv/cwd, the limits that applied, clean-tree
identity, the policy fingerprint, runtime versions, lockfile digests, and the
environment profile. Timeout and infrastructure receipts are diagnostic
history and are never executable cache hits. Passing and known-baseline-debt
receipts may be reused across jobs only for the same repository, commit, plan,
tree, policy, and toolchain; the new receipt points back to its source artifact.

Without a legacy planner `test_command`, Posse derives a versioned ordered plan
from known `package.json` test/lint/typecheck scripts. Repositories can instead
commit `posse.verification.json`:

```json
{
  "schema_version": 1,
  "checks": [
    { "id": "lint", "command": "npm run lint", "intent": "lint", "stage": "required" },
    { "id": "test", "command": "npm test", "intent": "test", "stage": "canonical", "depends_on": ["lint"] }
  ]
}
```

Check stages are `fast`, `required`, and `canonical`; intents are `test`,
`lint`, `typecheck`, and `contract`. Commands and working directories pass the
same direct-spawn safety validation as legacy frozen tests. Planner input may
select optional check IDs but cannot remove required checks or invent commands.

The same policy applies to the git verify hooks and the configured
`canonical_verify_cmd` / `pre_assess_cmd` path. Every verification result is
also projected onto one typed outcome (`passed`, `product_failed`,
`baseline_debt`, `no_applicable_suite`, `invalid_plan`, `unsafe_command`,
`dependency_unavailable`, `runner_unavailable`, `timed_out`,
`side_effect_detected`, `cancelled`) with an actionability class. An
infrastructure outcome on the pre-development baseline requeues the job with
backoff up to twice without consuming an implementation attempt, then fails
closed with a `verification_blocked` diagnostic and rerun command. It never
opens a human gate.

Child test processes do not receive `POSSE_KEY`. The verifier instead starts
a per-command local capability broker and passes its locator in
`POSSE_VERIFICATION_PULSE_CAPABILITY`, so key-gated native routes still work
inside a verification run while the secret stays with the parent.

Queue decisions that rely on merge/reopen evidence or deduplicated lock notices
use compact durable state independent of the 20-row telemetry tail. Event
readers continue to combine the SQLite tail with JSONL history. Batch event
flushes defer during open transactions so rollback cannot leave phantom mirror
entries.

A successful implementation commit is recorded before cross-WI synchronization.
If required synchronization fails, the attempt retains its commit hash and fails
with the sync diagnostic; the provider is not automatically rerun. The branch
and pending synchronization remain available for repair.

### Skips are named and classified

The default reporter lists every skipped test with its reason at the end of
each pass, and `scripts/run-tests.mjs` classifies each skip against
`test/support/skip-expectations.json` as `platform`, `capability`, or
`retired`. A skip no rule explains is `unexpected` and fails the run; add a
rule (with a category) or restore the missing capability. Set
`POSSE_TEST_STRICT_SKIPS=0` to report without failing. The rules are keyed by
reason text and platform rather than a frozen count, because the same suite
legitimately skips different tests on a laptop, in CI, and inside Posse's own
worker, which strips `POSSE_KEY` from the child environment.

Headless runs (no TTY) print a heartbeat on stderr every 30 seconds naming the
files still running and how long each has been going
(`POSSE_TEST_HEARTBEAT_MS` adjusts it; `0` disables). The heartbeat public-key
fetch at startup is bounded to 10 seconds (`POSSE_TEST_KEY_FETCH_TIMEOUT_MS`).

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

The Admin **Repo → git & merge → git_commit_style** setting controls generated
commit subjects. **off** preserves the original message. **conventional** and
**gitmoji** each make exactly one narrow classification call over the scoped
diff using the configured assessor provider at its standard model tier, then
pass the structured result to posse-git. Gitmoji mode retains the
machine-readable Conventional Commit prefix. Invalid or unavailable classifier
output blocks the commit before staging.

Recovery snapshots are stored as local refs under `refs/posse/snapshots/*` with
metadata in `refs/notes/posse-snapshots`.

### Shared side trunk for separate Posse instances

Shared-trunk mode lets any number of independent Posse installations collaborate
through one remote side branch. Each person must use a separate clone and a separate
`.posse/` database. Never point two instances at one clone, one worktree, or a
SQLite database on a network filesystem.

The host opens a persistent shared session from a clean named branch:

```bash
posse session host
```

For a GitHub origin, Posse uses the authenticated `gh` CLI to create a private
throwaway repository, installs a host deploy key through repo-local SSH
configuration, pushes a unique side branch, and prints a reusable 10-character
code plus a `posse://session` invite link. GitHub is the only provisioning
adapter in v1; other providers are refused instead of exposing the origin
repository to members. Any number of members can request admission from their
own clean clone:

```bash
posse session join ABCDE-FG234
# invite links are accepted directly too
posse session join 'posse://session?token=ABCDE-FG234'
```

The joiner displays a four-character countersign. The host confirms it from the
hosting clone (a second terminal is fine):

```bash
posse session admit AB23
```

The joiner creates its own session SSH key. Only after admission does the host
install that public key as a named write deploy key and the member independently
prove noninteractive fetch and leased dry-run push access. The private key never
leaves the member clone; the host's origin credentials and all Git credentials
stay out of the relay. The pending bearer is stored by the relay only as a hash
and is unusable for session work until the host admits it. A failed Git preflight
uses that bearer to leave rather than lingering as an active member. Kick and
close remove the corresponding deploy keys; repository cleanup reports a manual
action when the host lacks delete rights.

Hosts can manage the live policy and roster from another terminal:

```bash
posse session pending
posse session kick <member-id>
posse session invite open       # or: close
posse session policy each-member  # capability-routing | host-only
posse session scope <member-id> '{"files":["README.md"],"roots":["lib/"]}'
```

Scope is deny-by-default for unknown paths and is enforced both by the Node
write barrier and the native commit/push/CAS boundary. Scope changes and kicks
invalidate cached native authentication on the next five-second session
heartbeat. If the member monitor is not running, a previously minted envelope
can remain usable only until its normal pulse TTL expires.

`posse pair` remains a compatibility alias for `posse session`; `posse unpair`
remains an alias for `posse session leave`.

The host and member commands remain connected, like `posse serve`. A live run
adopts the session monitor, so the TUI remains the sole raw-input owner. Its
Pipeline pane shows session phase, roster, invite/policy state, peer work, and
delegated jobs; press `u` for the host session command line. It accepts `admit`,
`kick`, `scope`, `policy`, `invite`, `drain`, `close`, `keep`, and `inject`.

On the standalone host monitor, press `g` for a graceful close: Posse freezes
new jobs, lets active jobs finish, closes every member, synchronizes the side
trunk, and integrates it into the repository's default branch. `posse session close` (aliases: `posse session
leave`, `posse pair leave`, and `posse unpair`) performs the same graceful
close. Press Ctrl-C for a forced close; schedulers receive a
stop request before integration proceeds. Members restore their own original
branch and exact prior shared-trunk settings after acknowledging either close.

Use `posse session close --keep-branch` (or `keep` in the TUI) to preserve the
throwaway trunk without creating an integration journal. If an integration
crashes, recovery stops at the candidate and requires `posse session integrate`;
`posse session abandon-integration` preserves the candidate ref and clears the
journal for manual recovery.

Hosting must start on the remote's advertised default branch so the integration
target is unambiguous. A hard-killed process leaves a durable local recovery
journal. The next non-help Posse command repairs the session, waits for peers to
stop, and resumes the exact leased integration before allowing more mutable work.
Restoration safely pauses if the shared checkout is dirty, so commit or stash the
work and run Posse again.

While the session monitor is connected, bridge snapshots, `posse dashboard`, and the live TUI's
default log view show each peer's active work with a `read-only` label. Press
`p` for the detailed Pipeline pane. Peer work is held in a short-lived local
status snapshot; it never enters the local queue and cannot be scheduled,
claimed, or changed by this Posse instance. Background preparation jobs such as
ATLAS warmup stay local and are not relayed as paired work or app status.
Unknown shared-trunk commits are not absorbed: Posse compares only the recorded
session baseline through the fetched tip and accepts an operation trailer or a
known member committer identity. Anything else creates a typed repository
recovery gate for accepting that exact tip or rejecting it for manual review.

With `capability-routing`, a throttled or unavailable local provider can offer a
bounded work packet through `refs/posse/handoff/*`; `host-only` routes member
work to the host. The winner is selected by CAS in `refs/posse/jobs/*`.
Transient relay failures pause session routing while local dispatch continues;
a later successful heartbeat resumes routing. Invalid authorization or session
identity drains the scheduler. Graceful drain interrupts parked human gates and
still applies worker runtime limits. Close reports a timeout if workers remain
wedged, preserving the scheduler lock until they exit.

Unreachable transport runs locally, unclaimed offers are recalled, executor-side
human gates remain with the executor, and origin work completes only after the
shared trunk contains its `Posse-Origin-Work-Item` trailer. Model-call cost rows
retain both originator and executor instance identifiers.

During the compatibility rollout, `posse serve --pair` still pairs a
phone/client to the durable Remote bridge. It does not bypass session admission
or enroll another Posse clone.

Manual configuration remains available for long-lived administrator-managed
trunks. Create the branch once, push it, then enable the feature last:

```bash
git switch -c posse/shared
git push -u origin posse/shared

posse admin set target_branch posse/shared --json
posse admin set shared_trunk_branch posse/shared --json
posse admin set shared_trunk_remote origin --json
posse admin set shared_trunk_enabled true --json
posse pairing-preflight
```

`main`, `master`, and the remote's detected default branch are refused. The
configured shared branch must equal `target_branch`, and the native Git helper
must advertise the complete shared-trunk contract. Authentication must already
work non-interactively for the configured remote.

Pairing runs `posse pairing-preflight` automatically in every participating
clone. For a manually configured trunk, run it yourself. It fetches the
exact shared branch and performs a no-change, leased dry-run push to verify that
member's read access and noninteractive write transport. When advisory claims
are enabled, it also creates and CAS-deletes a unique probe claim ref. The
probe does not distribute credentials and cannot certify hosting-provider
branch-protection rules without a real branch update; normal publication keeps
the authoritative exact-OID lease and fast-forward checks.

Successful WI and iterative merges are published automatically to the exact
side branch. Posse still runs committed-conflict checks and `pre_push_gate`, but
does not create a human push-offer gate for that automatic publication.
When the host closes the session, Posse squash-integrates the frozen side trunk,
runs the normal push gate, refreshes the default branch, and publishes with an
exact remote lease. If validation, conflicts, branch protection, or network
availability blocks publication, the preserved promotion journal prevents a new
pairing and retries on a later Posse invocation.

The scheduler fetches before dispatch and polls while a run is alive. An
inactive clone catches up when its next run starts; v1 does not keep an exited
scheduler resident solely to poll. A divergence or unresolved publication is
persisted in bridge instance status and halts further trunk writes. Inspect the
two histories before recovery:

```bash
git fetch origin posse/shared
git status
git log --left-right --graph --oneline posse/shared...origin/posse/shared
```

Do not hard-reset the side branch casually. Posse's retry reset is
compare-and-swap guarded and only runs when `HEAD`, the fetched remote-tracking
OID, checkout state, and operation journal all match.

Advisory cross-instance file claims are separately opt-in:

```bash
posse admin set shared_trunk_claims_enabled true --json
```

Claims publish bounded JSON blobs under `refs/posse/claims/*`. They reduce
predictable duplicate work but never grant exclusivity and always fail open;
Git merge/push remains the correctness backstop. Claim paths and old blobs may
remain discoverable in the remote's object database after a claim ref is
deleted, and permissive ref fetches can expose claim-ref churn. Leave claims
disabled unless that metadata/noise is acceptable for the collaboration
remote.

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
