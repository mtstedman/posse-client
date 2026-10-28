# Posse (claude-org v4)

Posse is a SQLite-backed job orchestrator for repository work. It queues work
items, decomposes them into jobs, routes jobs to the configured provider, runs
mutating work in isolated git worktrees, and records scheduling, attempts,
reviews, artifacts, prompts, outputs, events, and costs in SQLite.

The npm package name is still `claude-org`, but the current system name is
`Posse`. The package exposes both `posse` and the legacy `claude-org` command
names.

For first-time setup, start with the [installation walkthrough](installers/README.md).
Application integrations use the [registered agent bridge](REGISTERED-AGENT.md).

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
- Provider routing across Claude Code, the Anthropic API, OpenAI, Codex, Grok,
  and Copilot.
- ATLAS semantic search with native Jina embeddings; install the model with
  `posse atlas-v2 models pull`.
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
- Deterministic checks display as `audit` without model or reasoning-effort badges.
  Actual model assessments retain the `assessor` label.
- Manifest-root-aware verification readiness with explicit `passed`,
  `failed`, and `unavailable` outcomes.

## Planner research

Planners can dispatch code and web researchers together with one
`dispatch_agent({ requests: [...] })` call. Independent children run concurrently;
the call returns all results after they settle. The account setting
`planner_research_max_children` defaults to 5 and accepts 1–8. It counts children
across the entire planner call, including follow-up batches. Explicit account
settings continue to override the default. The shared child runtime admits up
to 8 active children and queues batches when capacity is occupied.

Each research batch collects child reports and evidence selectors in one
response. Code evidence is deduplicated into a bounded source brief for that
batch; web findings, reports, and nominated source snapshots have durable refs.
The planner reconciles findings and carries supporting refs into its plan.
There is no separate automatic synthesis pass across batches.

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
- `test/`: catalogued core regression members and integration tests, with
  shared fixtures and runner support.

## Remote Tool Authority

`posse-remote` is authoritative for the resolved role, exact tool allowlist,
web-access maximum, project database capability, and broad read/write/shell/test
policy. Posse treats that response as a ceiling. Runtime availability, task
mode, file scope, and operator settings may remove capabilities but never add
them.

Missing or mismatched issuance fails closed. Provider contracts intersect signed
agent and attached job grants with the exact remote list; MCP owner tokens carry the same
suite-scoped allowlist and server-derived policy facts. Unsigned boot payloads
cannot widen signed claims. `project_db_query` additionally requires the issued
`read` or `write` capability and the repository's configured SQL grants. Web
tools require both the issued role grant and the operator kill switch. Internal
ATLAS orchestration actions, including `edit.plan` and `workflow`, are excluded
from provider and MCP surfaces even if a caller asserts them.

Gate and prompt requests advertise runtime support, not a second local role
permission table. The authenticated Remote catalog supplies the tool list;
`agent_tools_disabled` and the Atlas exclusions subtract from it. An installed
handler is not a grant. Unsupported tools fail before an agent token is minted.
Authenticated MCP execution preserves Remote role assignments while enforcing
the signed capabilities, current job binding, file scope, and runtime prerequisites.
Legacy role tables remain compatibility metadata for older internal callers;
they do not cap the authenticated agent surface.

The local owner signs a transport credential derived from the Remote grant; it
does not independently choose role permissions. Gates and operator exclusions
are frozen at mint time. Remote policy changes apply to newly minted gates;
expanding an existing token is rejected and requires a fresh gate. Job attachment
can narrow a grant but cannot widen it. The cross-repository tool compatibility
check verifies installed definitions rather than requiring matching role lists.

## Codex provider dispatch

Codex turns use the Rust `posse-remote` adapter. Posse assembles the issued
execution contract, model choice, and prompt before dispatch; the native
adapter owns CLI launch, stream handling, session resume, and usage accounting.
The deterministic MCP gateway remains the executor for scoped tools. The
installed `posse-remote` must advertise a compatible Codex adapter before a
Codex turn can run.

### Native tool grant

Remote signs the resolved agent tool ceiling as a native tool grant
(`posse.native.tool-grant.v1`) beside every prompt compile and agent tool
surface it issues. Posse relays that opaque token from issuance to the agent's
MCP gate and into each native dispatch; it never interprets the token as
authority, never writes it into packets, telemetry, or boot payloads, and can
only narrow the surface beneath it. The native dispatch hosts (`posse-remote`
and `posse-ml`) verify the grant against compiled trust before any provider or
tool activity and refuse a dispatch whose issued tools or capabilities exceed
it with a terminal `authorization` denial, which Posse treats as permanent
rather than retrying or falling back to another provider. A Posse that holds a
grant refuses to dispatch through a native runtime that cannot verify it, and
a tool-bearing or web-enabled dispatch without a grant never starts: there is
no local fallback authority. Tool-free turns (decision-only agent turns, model
probes, image generation already authorized through its tool) need no grant.

### Planner dispatch

Planner-led intake is the default account setting (`planner_dispatch_mode=planner`).
Existing `router` settings migrate to `planner` once on update; selecting `router`
afterward restores the upfront research/preflight flow. The separate
`agent_coordination_mode` setting defaults to `handoff`; existing repositories
with `off` migrate once to terminal handoff reports, preserving `subagents` and
subsequent explicit `off` selections. It still governs citation sub-agents. The planner
can plan simple work directly or call one tool:

```json
{"agent_type":"code","question":"Find the request validation path and its tests","budget":{"reasoning_effort":"medium","max_turns":12}}
```

`dispatch_agent` accepts `agent_type: "code" | "web"`. Code children investigate
the repository with read-only tools; web children use online research. Each call
blocks and returns a compact evidence-backed report. Child calls do not receive
the parent's transcript or dispatch tools. Existing citation-only `sub_agent`
behavior remains available to its existing callers; gated planners receive only
`dispatch_agent` for delegation.

Account settings bound total children per planner call (default 2), child turns
(24), timeout (1200 seconds), effort (medium by default with a high ceiling),
and returned report-size target (12000 characters; longer reports remain intact).
The runtime converts the triage turn setting into a planner repository-read
allowance of two calls per turn. Reads before and after child reports share
that allowance; failed read attempts also count. Handoff, clarification, and
child dispatch remain available when reads are exhausted. Child limits are
also runtime-enforced. The separate dispatch MCP timeout
(1500 seconds) reserves time to return results. Existing child cancellation and
stall handling are reused.

Monitor Agents shows code/web child rows with their question, progress, tool
history, provider/model/effort, and completion state. Select a running child and
press `n` to send guidance to that exact call. Parent and sibling nudges remain
separate. Agent-call records and planner completion events retain child lineage,
usage, questions, and the zero-child decision.

Planner dispatch requires a compatible remote code-child prompt and capability
contract. Validate direct planning, code and web investigations, child nudges,
and parent cancellation in an isolated test repository. Oneshot, trivial
no-research, and web-only intake retain their existing routes. A red-team
chain's primary planner and an assessment replan may dispatch; the critique and
synthesis planners cannot.

## Assessment replanning

An assessor's `needs_replan` verdict returns directly to the planner. With
planner dispatch enabled it uses the configured planner tier and may dispatch
bounded research children; otherwise it uses the standard planner route.
The planner receives the failed task, its success criteria and test command,
assessor reasons, original scope/commit, and a record of retained work. Local
preparation selects a read-only work-item branch snapshot and supplies the commit
diff when available. Prior research remains historical context; the planner
checks the affected current source before revising the remaining plan.

Citation sub-agents remain disabled on this route. The unified research dispatch
tool is available only when `planner_dispatch_mode=planner`. Stale queued branches
are canceled transactionally; completed work and implementations awaiting
assessment are retained. The existing `posse_max_replans` limit counts direct
planner cycles and legacy research cycles. Already-queued research loopbacks
continue through their existing continuation.

## Scope approval

Use `posse run --scope-mode=auto` or `posse go --scope-mode=auto` to approve
file-scope expansion requests automatically while keeping the run interactive.
This includes requests triggered by out-of-scope edits, one-shot file requests,
high-risk file requests, and fix scope gates that spawn the proposed fix.
Existing waiting scope gates for the selected work items are resumed through
the same approval policy.

The flag applies only to that run. Omitting it, or using `--scope-mode=default`,
preserves the existing `scope_auto_approval` policy and interactive or
non-interactive behavior. That policy already grants developers and fixes test
files, lockfiles, paths inside an approved create root, and project manifests
(`package.json`, `composer.json`, `tsconfig*.json`, `.gitignore`,
`pyproject.toml`, `requirements.txt`, `requirements-dev.txt`, `Cargo.toml`,
`go.mod`, `Gemfile`)
without a gate; installing new dependencies still needs its own approval. Scope mode does not change plan approval, publication,
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

### Incremental run monitoring for agents

From this package directory, check the latest scheduler run in a target project:

```bash
node tools/monitor-run.mjs --project /path/to/project
```

Repeat the same command to see only new signals. The first check starts at the
beginning of the run; each check emits at most 40 signals, and `backlog remains`
means another check will continue draining unread data. The monitor reads only
new telemetry bytes (at most 8 MiB per stream per check) and saves its cursor
under `$XDG_STATE_HOME/posse/run-monitor`, or `~/.local/state/posse/run-monitor`.

Signals include human questions and gate state changes, selected answers/actions
and their outcomes, job/work-item transitions, assessments, merges, retries,
model starts/completions, agent progress, failed tool calls, warnings/errors,
shutdown, and stale heartbeat changes. Runtime warnings retain nested work-item
and job IDs, phase labels, and durations. Replayed tool failures are labeled
`Recovered historical failure` and retain error severity; a later successful
retry does not erase them. Their timestamp is the observation's recording time,
not necessarily the original tool-call time. Gate snapshots include
automatic-decision provenance when recorded. They use the live database in
read-only mode, scoped to work items observed in the run (or `--work-item`).
Gate state reflects the latest database state; the event stream retains emitted
question/answer history, including gates opened and resolved between checks.
Unchanged gates are not repeated. Heartbeat staleness is a warning, not proof of
a dead process. Missing/unreadable gate data is reported explicitly.

Routine context/indexing logs, raw prompts, tool payloads, and stacks are omitted;
indexing warnings/errors remain visible. Text is bounded and secret-scrubbed.
Output includes IDs for deeper investigation in the original logs and database.

```bash
# Continuous polling; idle checks are silent. Stop with Ctrl-C.
node tools/monitor-run.mjs --project /path/to/project --watch --poll-ms 2000

# Machine-readable checks for one work item, with an independent agent cursor.
node tools/monitor-run.mjs --project /path/to/project --work-item 42 \
  --state job-42 --json

# Pin a specific run rather than selecting the latest scheduler run.
node tools/monitor-run.mjs --project /path/to/project --run <run-id>
```

Use `--run-dir` for an explicit telemetry directory and `--db` for a nonstandard
gate database. Watch mode stays on its selected run; a new one-shot invocation
selects the latest run again. `--state <job>` names a cursor; the monitor manages
its storage automatically. Names are scoped to the selected run and work-item
filter, so the same name can be reused safely across projects, runs, and filters.
The name does not select a job: use `--work-item` to filter the monitored work.
Names accept 1–80 letters, digits, dots, underscores, or hyphens, starting with
a letter or digit. Omit the option to use `default`; choose a new name to replay
history or maintain an independent observer.
The cursor is locked against simultaneous consumers and saved after successful
output; a crash between output and saving can replay the last batch. If a hard
kill leaves a `.lock` file beside the cursor, verify its recorded PID has stopped
before removing it. The monitor never starts a scheduler or mutates the run DB.

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
posse add "Describe the change you want"
posse doctor
posse admin
posse go
```

`posse add`, `posse go`, `posse admin init`, and session joins initialize the project. Other repository commands
require that initialization. `posse doctor` and `posse update` skip repository
dependency installation when run elsewhere. The installer explicitly provisions
shared tools from Posse's own checkout.

`posse go` plans and runs queued work. Boot checks required dependencies,
attempts doctor repair when unhealthy, and stops if verification still fails.
Use `posse help` for the full CLI reference.

Interactive `run`, `go`, and session starts offer to refresh Posse when its
installation is behind `origin/main`. Accepting saves local tracked and
untracked installation edits in a named Git stash, fast-forwards the client,
refreshes dependencies, and restarts the original command in a fresh process.
Saved edits stay in Git so the refreshed installation uses the published code;
the project you are working on is not stashed or pulled. Inspect `git stash list`
in the installation checkout and use `git stash apply --index <saved-OID>` to
restore saved work deliberately.

Use `posse go --update-at-boot` (also supported by `run` and session starts) to
accept automatically, including in noninteractive use. It stops startup if the
freshness check or update fails. Use `--no-update-at-boot` to skip the offer.
Read-only commands and help do not perform this startup check. Standalone
`posse update --stash` provides the same preservation option; plain `posse update`
continues to refuse tracked installation edits. Only committed upstream work
can be pulled.

Admin → General → Workflow includes **Startup Update Mode** (`startup_update_mode`)
as an account-wide preference: `ask` (default) offers an update in interactive
starts, `auto` updates without prompting even in noninteractive starts, and `off`
skips startup updates. Set it from the CLI with
`posse admin set startup_update_mode auto`. The command-line boot flags
override this preference for that invocation; `--no-update-at-boot` takes priority.

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
- `tools [list|new|show|test|secret|grant|revoke]`: author script tools that
  granted agents can call (see below).
- `agent [<name>|list|show|new|chat|run|confirm|conversations|export]`: run and
  inspect durable user-defined agents (see below).

### Script tools

`posse tools` manages operator-authored tools in the machine automation owner.
Each tool is a folder under the automation data directory
(`~/.posse/tools/<name>/`): a `tool.json` (`posse.script_tool.v1`) declaring
params, env defaults, secrets, effect (`read` or `write`), timeout, and an
output cap, plus the script itself. `posse tools new <name> --template
bash|python|node|http --param id:string:required --secret DB_PASSWORD` writes
a starter that fails until you edit it.

- Arguments arrive only as data: JSON on stdin and `PARAM_<NAME>` variables,
  never argv. The process gets a built environment — the test-subprocess
  allowlist, a per-call temp dir, declared env, and its own secrets — and none
  of the owner's credentials. It runs in its own folder and process group;
  timeouts and cancellation kill the whole tree.
- Registered agent calls may include private `inputs` in their request JSON.
  A tool declares caller-facing fields in an `inputs` JSON object schema beside
  its agent-facing `params` schema in `tool.json`. Posse validates the caller
  values and fills them into the tool invocation; the model sees only `params`.
  The caller supplies the same inputs on each chat turn. Use `--inputs-file`
  when testing such a tool.
- A tool may declare `output_schema` as a JSON object schema. Posse checks the
  script's parsed JSON output against it before a passing test publishes the
  tool and again on each run. Bossy can create this schema from typed output
  fields and edit the script through the automation owner; saving code changes
  the digest and requires a new passing test.
- Secrets are write-only: `posse tools secret set <tool> <NAME>` reads a hidden
  prompt or piped stdin and stores the value in the owner database. Listings
  show only a fingerprint. Only the declaring tool's process receives it, and
  output is redacted for the raw, base64, URL, and JSON-escaped forms of every
  injected secret before credential-pattern scrubbing.
- A tool becomes callable only after `posse tools test <name>` passes; the
  pass publishes an entry pinned to the digest of `tool.json` plus the script.
  Editing either makes the entry unavailable until a new test passes, and that
  test revokes grants that pinned the old version.
- `posse tools grant <name> --repo <path> --roles dev` (or `--standalone`)
  exposes it through `custom_tools`. Write tools confirm by default: no agent
  surface except `posse agent` can ask a person, so other agent callers run a
  `write` tool only under a grant made with `--unattended`. A registered
  agent follows its own definition's `write_tools` instead.

Bossy's Automation Studio Tools tab drives the same owner operations
(`script.*`); it stores and runs nothing itself.

### User-defined agents

Bossy's Automation Studio Agents tab edits strict `bossy.agent.v1` files in
`~/.posse/agents/`; Posse owns their execution. A direct invocation can keep a
named conversation across processes:

```bash
posse agent kairos --session asdfe -m "What should we do next?"
posse agent chat seedance-stage --session episode-12
posse agent kairos --session asdfe -m "Return JSON" --json
```

The definition pins the private standing prompt, provider/model, ordered script
tools and published skills, repository or standalone scope, write policy, and
turn/call/spend/wall-time limits. `sonnet`/`standard` and `opus`/`strong` are
portable tier labels; use `provider:model` to pin an exact provider model.
An unversioned skill name from Bossy resolves to the newest published version
when the conversation is created; `name@version` pins a version explicitly.

The first turn resolves exact tested tool and skill digests plus their grants.
Later turns on the same session retain that definition and capability set even
if the editable files change. A new session receives the new definition.
Read tools execute through the automation owner. Write tools follow the
definition's `confirm`, `allow`, or `deny` policy; `confirm` returns exit code 2
and a `proposal_id`, which can be resumed with:

```bash
posse agent confirm asdfe proposal_ID
posse agent confirm asdfe proposal_ID --deny
```

An agent may request up to eight independent tool calls in one provider
response, including calls to different tools. Posse validates, authorizes,
executes, and records each call separately, then returns all results before the
agent continues. Calls that depend on earlier results still need another
provider response. When the agent has a write tool requiring confirmation,
Posse accepts one tool call per response so confirmation can pause safely.

`--json` emits exactly one `bossy.agent_turn.v1` envelope on stdout for harness
integration. Use `posse agent conversations [name]` and `posse agent export
<session-id>` for durable history. Posse compiles the generic `agent` safety
role from posse-remote, then appends the private prompt and exact capability
contract locally; the editable persona prompt is not sent to the prompt
service. Bossy fleet tools (`bossy.*`) are not yet bridged into this runtime and
are rejected explicitly rather than silently widened.

### Native provider and admin JSON

`posse usage --json` emits one bounded `posse.provider_usage.v1` document on
stdout. Use `--refresh` for a normal provider refresh and `--force-refresh` for
an operator-forced probe; diagnostics remain on stderr. The payload preserves
finite, unlimited, and unknown capacity windows, budget configured-vs-unset
state (including numeric zero), and measured-vs-unavailable spend without raw
provider responses or credentials. Human `posse usage` output is unchanged.

The interactive admin has four sections: Settings, Dashboard, Work, and Changes.
Use `Tab` or `1`–`4` to switch. Dashboard opens first; press `r` there for saved
report analytics and `Esc` to return. Settings keeps everyday controls in General,
Agents, Providers, ATLAS, and Repository. Press `Ctrl+A` for advanced tuning and
experiments; `Esc` returns to the settings pane you came from.

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

The shared Node environment also installs pinned TypeScript 5/6 compilers,
ESLint, and a TypeScript parser for verification. Project-installed tools take
precedence. When a compiler is absent, Posse selects a managed version matching
the project's declared TypeScript range and checks its `tsconfig.json` without
emitting files. Without a lint configuration, Posse runs baseline defect rules
for JavaScript and TypeScript; compatible project ESLint configurations can use
the managed executable. Custom scripts, plugins, and application dependencies
still require their project environment. Verification never installs packages
into the target repository. Re-running the setup command above upgrades older
central environments even when their SCIP indexers already work.

## Independent tool batches

`edit_file.edits` resolves each item against the original file snapshot and
applies valid, non-overlapping edits. The response identifies every input index
as successful or failed; overlapping edits both fail while unrelated edits
still apply. Retry only failed items after rereading affected ranges, since
successful edits can move line numbers. The resulting file is written atomically.

File inspections, downloads, reference creation and fetching, ATLAS symbol retrieval,
and child-request batches also
retain successful siblings when an item is invalid or fails. Authorization,
batch limits, and whole-request validation still apply. Operations that build
one inseparable output, such as a sprite sheet or a dependency graph, retain
their transactional validation.

The first non-passing `run_unit_test` result in each agent call includes failure
handling guidance. It asks the agent to identify the assertion or startup
error, distinguish environment failures from product defects, make a justified
minimal fix, and reassess after two unsuccessful targeted fixes. Later test
responses in that call omit the guidance; it is not added to the base prompt.

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
`/home/mason/repos/deployment/posse/CI`. Publication uses the local validation
gate in `publish-posse.mjs`. GitHub Actions CI is disabled for Posse and the
public client; hosted check results are not publication requirements.

Native deployment and clean-client synchronization run directly from the
centralized `CI/` directory; there are no repository-local deployment
launchers. Only committed work can be published: pushing or synchronizing
reconstructs the client from the pushed source and does not preserve
uncommitted, in-flight changes.

`npm test` cleans stale artifacts and runs the full catalog through
`scripts/run-tests.mjs`. Core members execute in separate processes, with their
own runtime sandbox. The aggregate `test/core.test.js`, `test/suites` wrappers,
and `run-core-suite.mjs` selector have been removed.

Use the same runner for files, whole domains, affected changes, and shards:

```bash
npm run test:scheduler
npm run test:atlas
npm run test:domain -- worker
npm run test:affected -- --base <successful-source-commit>
npm run test:plan -- --base <successful-source-commit>
node scripts/run-tests.mjs files test/core/suites/scheduler.test.js
node scripts/run-tests.mjs domain scheduler --shard 1/3
node scripts/run-tests.mjs catalog ci_portable
```

Domain aliases select both core and standalone regressions. The old `:fast`,
`:slow`, and `test:quick` aliases are removed; use domains, files, or shards
for narrow runs. `test:core-only` selects the explicit `core` partition.
Inherited suite-name and fast/slow environment filters cannot hide tests. `--list` or
`--json` prints the selection without running tests. An affected plan includes
changed paths, selected domains, per-file reasons, and full fallback reasons.

The versioned `test/test-catalog.json` assigns every test its domains,
execution lane, platform, and partitions. Source ownership, mandatory smoke
files, aliases, and broad-change rules live in `test/test-domains.json`.
Discovery covers `test` and `scripts/tests`; validation rejects unreachable
suites and unknown domain labels. Run `npm run test:catalog:check` after adding
or moving tests. Domain ownership is explicit metadata. Transitive static
imports additionally include consumers of affected code. Runtime-selected
consumers must be represented in domain assignments; test helpers, fixtures,
shared code, dependencies, and unknown or deleted paths conservatively require
the full suite.

On Linux/macOS the concurrent pool defaults to at most eight processes and
the resource-heavy pool to four, with both pools overlapping. Windows keeps
the resource-heavy pool at one and drains the first pool before starting it.
`POSSE_PARALLEL_CONCURRENCY`, `POSSE_SERIAL_CONCURRENCY`, and
`POSSE_OVERLAP_PASSES` control these limits. Stable `--shard N/M` membership is
independent of local timing caches, so workers cover the selection exactly
once. Within each pool, recent durations prioritize the longest files first.

The default reporter prints failures and heartbeat progress. Set
`POSSE_TEST_REPORTER=spec` for verbose output; an independent audit reporter
still records skips and failures. Unexpected skips fail with either reporter.
Required native capabilities are declared with `requires` in the catalog.
Missing debug Atlas builds fail before spawning the suite; set
`POSSE_ATLAS_DEBUG_BINARY` to the compatible debug executable. With the sibling
`posse-bin` checkout, build it once using
`cargo build --locked -p posse-atlas --manifest-path ../../posse-bin/Cargo.toml`
from this package directory. The runner discovers that debug build automatically.

`npm run test:timings` reads measured file completion durations, including
startup and teardown. Historical aggregate entries may remain in its rolling
cache until that cache is removed.

Each runner invocation writes immutable evidence beneath `.posse-test-runs/`:
selection, starting and ending commit/cleanliness, catalog hash, runtime,
completed execution files, durations, skips, and failures. Dirty runs have no
reusable tree fingerprint. Publication uses a unique external receipt and
rejects incomplete, dirty, or changed-candidate evidence.

The central publisher defaults to the two `ci_portable` shards, each with
strict skip checks on the same committed candidate. Its aggregate receipt
verifies that the shards cover that partition exactly once. Static, contract,
and catalog checks also run. Explicit `--affected-tests` mode compares against
the last successfully published source commit and can fall back to the full
suite for missing/divergent baselines, broad changes, or full validation older
than seven days. `--full-tests` requires full validation; `--shadow-tests`
records the affected selection and runs everything. The publication baseline
advances only after source push and public-client synchronization succeed.
`--no-tests` never advances that tested baseline. Coordinated multi-repository
sweeps run full Node validation because native and Remote dependencies change
outside the Node commit range. See the centralized deployment index for state
locations and publication commands.

The `ci_portable` and `ci_windows` catalog names identify test partitions;
they do not require GitHub Actions. Portable receipts do not claim Windows or
full/native validation.

Full suite timing depends on native binaries, host load, and storage. Use the
run manifest's measured duration instead of the former aggregate estimates.

Posse runs a repository's frozen test command and its canonical verification
command under a declared time policy instead of a fixed 120-second cap:

One-shot `vitest run`, `node_modules/.bin/vitest run`, and `npx vitest run`
commands are standard verification commands. Explicit test-file selections
use the existing `run_unit_test` Vitest adapter and per-file results. Suite
filters or explicit CLI options use the repository's installed Vitest through
the frozen-command runner; `npx` never downloads a package. Missing dependencies
are reported as unavailable. Watch mode, snapshot updates, and output-writing
flags remain excluded. Quoted PHPUnit filters such as
`phpunit --filter 'FirstTest|SecondTest'` preserve their literal regex argument.

Jest, Mocha, `playwright test`, and `tsx --test` are standard verification
commands when named bare, through `node_modules/.bin`, or through `npx`,
`pnpm [exec]`, `yarn`, or `bunx`; Vitest accepts the same launchers, and
`npx tsc --noEmit` and `npx eslint` follow the bare typecheck and lint rules.
A launcher is syntax only: verification runs the repository's installed
package bin under Node and reports a missing package as unavailable.
`vendor/bin/pest`, `php artisan test`, and `deno test` are standard commands
like PHPUnit and `go test`. Scaffolding, watch, debug, and output-writing
options remain excluded.

Automatic scoped checks prefer a package's `typecheck` script. When none exists,
a package with `tsconfig.json` uses its installed TypeScript compiler with
`--noEmit`; temporary incremental metadata is removed after the check. Posse
does not run an arbitrary build script or download a compiler for this fallback.
Missing TypeScript is reported as unavailable. Projects with TypeScript project
references need an explicit `typecheck` script to cover their referenced projects.

**Test strictness** is a repository setting under **Repository → Verification**
in the admin settings. `test_strictness=permissive` is the default: missing,
unavailable, unconfigured, and zero-test runs are recorded as diagnostics and
do not force review or replanning. The assessor judges the implementation from
the available evidence. Set `test_strictness=strict` to require verification
and retain review/recovery gates for missing test evidence. Unknown case counts
alone do not block a successful run in either mode. Actual failures, timeouts,
and workspace-integrity checks remain actionable in both modes.

| Setting | Scope | Default | Meaning |
|---------|-------|---------|---------|
| `verification_wall_timeout_ms` | repository | 120000 | Wall-clock limit for a frozen test or canonical verify run. Set it from measured suite durations; Posse uses a 900000 ms allocation for full verification. |
| `verification_idle_timeout_ms` | repository | disabled | Kill a run that produces no output for this long. Enable only for harnesses that print progress while healthy; `npm test` here prints a heartbeat every 30s when headless, so it qualifies. |
| `verification_wall_timeout_max_ms` | account | 1800000 | Administrator ceiling. Repository values above it are clamped, so a repository cannot pin a worker indefinitely. |
| `verification_dependency_network_policy` | repository | allow | Dependency repair may fetch exact locked artifacts (`allow`, the default), use only existing caches (`cache_only`), or be disabled. Repairs always require a repository lock, frozen/no-script flags, and a clean-tree check. |

Every receipt records normalized argv/cwd, the limits that applied, clean-tree
identity, the policy fingerprint, runtime versions, lockfile digests, and the
environment profile. Timeout and infrastructure receipts are diagnostic
history and are never executable cache hits. Passing and known-baseline-debt
receipts may be reused across jobs only for the same repository, commit, plan,
tree, policy, and toolchain; the new receipt points back to its source artifact.

Complete Node spec and PHPUnit failure reports are compared by individual
failure identity. Fixing some existing failures or changing their report order
leaves the remaining failures classified as baseline debt. New failures and
changed diagnostics remain actionable. Debt does not count as a passing suite
or waive missing test coverage; incomplete reports retain conservative handling.

PHP unit-test discovery uses the nearest repository `vendor/bin/phpunit`, then
falls back to Posse's managed `scip/bin/phpunit.phar`. PHP setup (`posse doctor`
with PHP selected) installs the checksum-pinned PHAR suitable for the host PHP,
including when SCIP is already installed. PHPUnit need not be declared in the
repository's `composer.json`. The fallback keeps the repository's configuration,
bootstrap and test path; application dependencies still belong to the repository.
Repositories that require another PHPUnit version can install it locally. Test
execution itself never downloads PHPUnit or changes Composer files.

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

For custom class-based test frameworks, declare which script executes each
test file in the same committed config. `unit_test_runners` applies to both
path-only test tools and automatic changed-test verification. Direct Node
single-file commands (`node tests/example.mjs` or `node --test tests/example.mjs`)
also honor the matching declaration, freezing its runner and arguments before
development:

```json
{
  "schema_version": 1,
  "checks": [],
  "unit_test_runners": [
    { "files": ["tests/integration/**"], "runtime": "php", "script": "run-tests.php", "args": ["integration"] }
  ]
}
```

Patterns and scripts are relative to the repository root. Supported runtimes
are `node`, `php`, and `python`; arguments are literal strings, with no shell
expansion. Each file must match at most one runner. A declaration promises
that the command executes every matching test; use narrow patterns reflecting
the runner's real discovery rules. A suite shared by several changed files
runs once per batch. Empty output or an explicit zero-test summary does not
count as executed tests. Node file checks require registered `node:test` cases;
a successful file exit alone is unavailable coverage. Registered skips retain
their counts and reason, including when other cases pass. Repository script
runners must emit a recognized test summary. A forwarded filename in a package
script is selection metadata, so it cannot suppress changed-file verification.
Changed tests with an unavailable runner or missing
dependency remain explicit diagnostics; repository-declared required checks retain
their obligation when unavailable, and optional checks keep their skipped/unavailable
status. Strict test mode requires their
verification before completion.

Use the same declaration for browser tests that need a setup wrapper. The
repository wrapper owns its locked test dependencies, browser installation,
frontend build, candidate-local server, readiness wait, and cleanup. It runs
from the exact verification checkout, including detached baselines; it must
not reuse a server serving another checkout. Runtime environment values should
be supplied by that wrapper or fixtures, since verification does not inherit
arbitrary application environment variables or parent credentials. Posse does
not infer external installations or server commands from prose documentation.

For directly invoked Node test files, dependency repair finds the nearest
owning locked package instead of assuming the repository root. It can reuse
the corresponding primary checkout's matching install and verifies that a
reported missing package actually resolves before reporting repair success.
An unrelated sibling lockfile does not authorize installing test tooling.

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

Provider setup, assessment transport/protocol errors, and exhausted assessment
evidence budgets also have bounded automatic retries. Exhaustion ends the job
with an infrastructure diagnostic instead of a blocking human question. Failed
work items retain their normal recovery actions. Retrying a preserved assessment
candidate grants a fresh assessment slot without rerunning implementation;
missing bound source instead requires implementation to regenerate the evidence.
Strict verification requirements and unresolved worktree changes retain their
explicit recovery gates.

An orphaned review with no answerable gate gets at most one assessment-only
reconstruction when a local or remote operator is present. A human-input wait
whose gate is missing fails after a grace period; live gate contracts, worker
leases, and post-merge database holds retain their normal owners. An answered
gate from before the current wait does not hide a missing new gate.

Child test processes do not receive `POSSE_KEY`. The verifier instead starts
a per-command local capability broker and passes its locator in
`POSSE_VERIFICATION_PULSE_CAPABILITY`, so key-gated native routes still work
inside a verification run while the secret stays with the parent.

Queue decisions that rely on merge/reopen evidence or deduplicated lock notices
use compact durable state independent of the 20-row telemetry tail. Event
readers continue to combine the SQLite tail with JSONL history. Batch event
flushes defer during open transactions so rollback cannot leave phantom mirror
entries.

`posse status` warns when completed calls lack exact recorded model pricing;
`--json` includes the counts and affected provider/model/basis groups under
`pricing`. `--active` limits these counts to active work items, including those
awaiting merge review or recovery. Missing historical pricing provenance stays
unknown even after the price book is updated.

Terminal handoff rejections are retained in `agent_handoff_rejections`, one
row per rejected submission, with call/job/attempt attribution, role, error code,
serialized input character count, and bounded error details. Raw handoff
arguments are not copied into this ledger. Observation pruning does not remove
these rows; queue reset detaches their job/attempt/work-item links while keeping
their agent-call link. Deleting the agent call removes its rejection history.

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

A saved final-review pass stops the developer and reviewer calls. Once the
reviewed bytes are committed, the job completes directly from that review,
including after restart. It does not run another assessor or reapply the old
assessment test/confidence policies. Changed code or a changed task contract
requires fresh verification. The accepted pass is announced once.
Developers report an unrecoverable blocker with `final_review({ blocker: "..." })`.
This saves BLOCKED and stops both sessions without running another review or
requiring a separate handoff call.

`clear` prints the queue database it resets and cancels pending work before Git
cleanup. Failed branch/worktree cleanup no longer leaves runnable jobs behind:
the queue is cleared, while remaining files and a recovery artifact are kept.
A live scheduler prevents clearing, and a maintenance lock prevents startup
during the reset. Separate worktree directories can have separate queues.

Reviewed-file handoffs are enabled by default. Eligible jobs with exact file
scopes can receive successfully committed, final-reviewed changes before the
source work item finishes its unrelated work. The receiving work item still
waits for its upstream dependencies before merging.

To disable new handoffs for the current repository, run
`posse admin set scheduler_reviewed_file_handoffs off --json`. Existing transfers
continue to reconcile safely. Run
`posse admin clear scheduler_reviewed_file_handoffs --json` to restore the default.

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

Joining initializes Posse automatically in `~/posse-sessions/<CODE>` regardless
of the terminal's starting folder. A new session folder gets its own fresh
checkout and takes the session repository's history after admission. Retrying
the same code reuses that session folder. Use `--here` only to explicitly join
in an existing clean clone or a chosen empty folder.
A folder where `posse add` or `posse go` already ran, with nothing committed,
still counts as empty.

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
uses that bearer to leave rather than lingering as an active member. Kick
removes that member's deploy keys, and an admission whose key could not be
installed removes any key GitHub created anyway. Close revokes every member key
before its final sync, so the frozen work cannot change afterwards and a kept or
undeleted repository stays writable only by the host; a revocation that cannot
be proven stops the close for a retry. Repository cleanup reports a manual
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

Hosting must start on the remote's advertised default branch, at exactly its
remote tip (hosting fetches it first), so the integration target is unambiguous
and the close can publish what the session was seeded from. A hard-killed process leaves a durable local recovery
journal. The next non-help Posse command repairs the session, waits for peers to
stop, and resumes the exact leased integration before allowing more mutable work.
Restoration safely pauses if the shared checkout is dirty, so commit or stash the
work and run Posse again.

While the session monitor is connected, bridge snapshots, `posse dashboard`, and the live TUI's
monitor view (the default) and log view show each peer's active work with a `read-only` label. Press
`p` for the detailed Pipeline pane. Peer work is held in a short-lived local
status snapshot; it never enters the local queue and cannot be scheduled,
claimed, or changed by this Posse instance. Background preparation jobs such as
ATLAS warmup stay local and are not relayed as paired work or app status.
Unknown shared-trunk commits are not absorbed: Posse compares only the recorded
session baseline through the fetched tip. New Posse merge commits carry
`Posse-Session-User: <session-id>:<instance-id>`; the instance ID persists for
the clone across sessions. Posse checks that the named instance participated in
the named session, or that a local operation journal binds the exact commit.
Older session commits without the trailer require an exact-tip recovery review.
Administrator-managed trunks without a Session retain their previous committer
identity check. The trailer identifies a Posse participant but is not a
cryptographic signature against someone with direct write access to the Git
remote. A failed check creates a typed repository recovery gate for accepting
that exact tip or rejecting it for manual review.

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

Manual configuration remains available for existing long-lived administrator-managed
trunks through explicit `posse admin set` commands. These legacy runtime keys are
omitted from the Posse and Bossy admin settings editors; Session manages new
team trunks and their approvals. Create the branch once, push it, then enable
the feature last:

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

Hosting or joining a session runs the same dependency gate as
`posse run`/`posse go`: Posse's own packages are repaired first, then the
repository's dependencies are checked and repaired, a host before opening the
session and a member on the checked-out session branch before Posse marks the
clone active. If Posse can run, it can pair: anything still missing after the
repair leaves the session running without it, with the same warning a run
shows, and pairing stops only where `posse run` would stop.

Before enrollment, pairing checks Git, OpenSSH, and `ssh-keygen`; hosts also
check the GitHub CLI (`gh`). Version probes have a ten-second limit and name
the failing command with a recovery step. Git handles repository transport;
`gh` handles the host's GitHub API access. Dependency checks show progress
during both checking and repair, including the package or indexer being checked.
Readiness checks have a two-minute worker limit; installation keeps its normal
repair budget. Optional dependency failures still allow pairing with a warning;
run `posse doctor` for a detailed repair report.

Session Git traffic connects directly to `ssh.github.com` on TCP port 443 using
GitHub's supported SSH-over-443 endpoint, with strict pinned host-key checking.
It does not probe port 22 first. This is SSH on port 443, not HTTPS: networks
that restrict protocols as well as ports may still need an administrator to
allow this endpoint. Posse generates a separate session SSH config, so changes
to `~/.ssh/config` do not override this connection. Existing sessions retain
their generated config until recreated; this change applies to new sessions.
The host's original repository uses its existing transport outside that config.

Pairing allows 15 minutes for Git fetch/push, five minutes for checkout, and
two minutes for worktree scans and history traversal. Clean checks include
untracked files but skip expensive rename detection. For unusually large
repositories or slow disks/networks, set `POSSE_PAIR_GIT_TIMEOUT_MS=1800000`
in the terminal before starting Posse to allow 30 minutes per Git operation
(maximum 60 minutes). This only extends Git budgets; tool-version probes keep
their ten-second limit, and dirty-checkout and history checks still apply. Uploads and
downloads show live Git phase progress, object counts, bytes, and transfer
speed; checkout shows Git's file-count progress. Git transfers packed objects,
so it does not expose a current filename during upload/download. A quiet
operation reports elapsed time every 15 seconds. Interrupted fetches/pushes
retry up to twice within the operation's original timeout budget; authentication,
history, and branch-protection failures are not transport retries.

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

### Application environment setup

For a greenfield application, the planner can use `inspect_environment` and
`setup_environment` before handing off development. The latter proposes one
ordered batch of package-manager steps (the supported managers are listed at the
end of this section). Each step names a package manager and directory,
packages and version constraints, whether they are development dependencies,
and whether scripts or Composer plugins are needed. An omitted package list
installs the dependencies already declared in the manifest.

The **Approve / Reject** question shows the entire batch, commands, environment
overrides, current manifests, proposed initialization/ignore changes, and local
commit scope. Nothing installs before approval. Automatic scope approval and
unattended mode never authorize these requests. Lifecycle scripts, pip/uv
source builds and Composer plugins are disabled unless explicitly requested in
the approved step. Poetry and Bundler cannot disable package build code, and
Cargo and Go downloads run none; the question states which applies. Project
configuration such as `.npmrc`, `.yarnrc.yml`, `bunfig.toml`, Composer
`auth.json`, `uv.toml`, `poetry.toml` or `.cargo/config.toml` is named in the
question (its contents are not shown) because it controls the registry and
authentication. A canceled attempt, rejection,
changed inputs, or no answer within 10 minutes prevents execution. Each approval
can be used once; batches stop at the first failed command and restore the
setup files they changed, so the primary checkout stays mergeable (installed
packages remain in their ignored directories). A retry needs new approval.
Work-item merges into the primary checkout wait while an approved installer is
running there instead of failing on its uncommitted manifests. Installers in one batch
share a 30-minute budget (10 minutes per step). The job's runtime watchdog
does not count the approval wait or the approved installers, up to a capped
credit per dispatch, and other jobs keep using their tools meanwhile.

Planning setup runs in the primary checkout, initializes missing npm-family,
Composer, pip, uv and Bundler manifests (Poetry, Cargo and Go need an existing
project manifest), adds anchored ignore rules for local install directories
(`node_modules/`, `vendor/`, `.venv/`, `vendor/bundle/` and `.bundle/`), and commits only the
setup manifests, locks, and `.gitignore` locally. It does not push or deploy.
The plan that requested setup cannot start development until setup succeeds and
that commit is clean. If you reject the request, the plan continues without
it. If setup expires or fails, Posse asks how the next plan should proceed:
retry with a revised batch, continue without setup, or pause. New dev worktrees
reuse the approved installation with matching manifests and lockfiles before
development checks or providers run, including worktrees of later work items
that ran no setup of their own. Once a work
item changes its manifests or lockfile, its worktrees keep their own
dependencies; a worktree without them is reported to the operator and the
developer. Only npm-family and Composer installations are linked; a Python
virtualenv or Bundler path records the checkout that built it, so its worktree is
told to request its own install, and Cargo and Go share the user's download
cache. With the lockfile in its writable scope, a developer can request
`install_dependencies`. This batch tool is available during initial ordinary
planning, before the work-item development branch exists; red-team/review
passes and assessment replans cannot run it.

For local SQLite storage, include `database` in that same planning batch. Supply
the new database `path`, optional existing CREATE TABLE/INDEX `schema_path`,
and application `env_files` (default `[".env"]`). Use `steps: []` when no package
installation is needed. Setup adds `DATABASE_URL` (a file URL), `DB_DATABASE`
(an absolute local path), and `DB_CONNECTION=sqlite`, preserves unrelated
environment values, and commits portable `database.env.example` files. It adds
ignore rules for live `.env`, the database, and SQLite sidecars. Existing data,
conflicting database variables, tracked `.env`, and an existing Posse database
registration are never replaced automatically.

When the application does not already have a connection module, include
`database.connection_file: { "path": "src/db/connection.ts", "content": "..." }`.
The planner supplies complete, small source in the project's language and
framework. It should expose a reusable connection function, load configuration
through the existing environment/framework mechanism, and avoid logging
connection values. Include its driver and environment-loader packages in the
same approved dependency batch. Reuse an existing framework connector with `connection_file: { "path": "..." }`.
Every database setup requires an explicit new or existing connector.

The full proposed module is shown for approval and committed with setup. Posse
does not substitute `.env` values into its source, execute the module during
setup, or overwrite an existing file. Developers import it and validate it with
the application's normal checks. The source limit is 16 KB; live credentials
and machine-specific configuration belong only in the local environment.

The same approval lists Posse's database `permissions`: default `["read"]`, or
explicit `["read", "write"]` when development needs schema/data changes. After
the setup commit succeeds, Posse creates the SQLite file and registers it with
its project database tools. Subsequent jobs receive only their permitted tools;
an existing agent token is not widened. Development worktrees get the generated
database variables pointing to the same primary-checkout local database, without
copying other secrets. Each worktree then keeps database values its developers
change; a missing database or unignored `.env` is reported to the developer
instead of stopping development. Applications must load their `.env` using their framework
or dotenv support. The portable example is suitable for configuring a fresh
clone; runtime data and machine-specific environment files are never committed.

PostgreSQL and MySQL use the same database setup flow. For an existing server,
supply `type: "postgres"` or `"mysql"` and
`server: { "env_file": ".env", "url_env": "DATABASE_URL" }`. Put the connection
URL in that ignored local file; tool arguments and source contain no credentials.
Optional `server.create_database: true` creates a new database using the supplied
account's privileges. Setup verifies connectivity before registering it.

To provision a local server, replace `server` with
`local_server: { "database": "app", "username": "app_user" }`; the username is
optional. On Ubuntu/Debian, this explicitly approved action installs missing
`postgresql` or `mysql-server` packages from configured APT repositories, starts
the service, and creates a dedicated application account and database. It needs
root or non-interactive sudo; Posse does not collect sudo passwords. Debian
requires a configured repository providing `mysql-server`; MariaDB is not
substituted. Other operating systems use the existing-server connection flow.

Local provisioning uses the default local socket and TCP port (5432 or 3306),
preserves existing server configuration, and requires socket administration by
the system administrator. Existing database/account names stop setup without
replacement. The generated password is passed to the administrator client over
stdin and saved in ignored `.env` files and Posse's local credential store.
Posse verifies the application connection before registering it and retains the
required connector and portable examples in source. Package installation and
resource creation can leave partial state on failure; retries require another
approval, and existing data is never removed to make a retry succeed.

On an existing development branch, `install_dependencies` remains available
within writable scope. Declare dependencies in the package directory's manifest,
include its lockfile in scope (npm and Go also need the manifest), and ignore its
local install directory. The manager is detected from the manifest, the
`packageManager` field and the lockfile; pass `manager` when a directory has
several, such as `composer.json` beside `package.json`. Asking npm to install a
package that has another manager's lockfile is refused with the manager to use.
Composer honors an existing lock and resolves only the packages it lacks, with
incompatible root requirements also resolved using Composer's own constraint
validation. Unrelated locked packages keep their versions. Before installing,
shared Composer vendor links are copied into an independent worktree-local
installation so package changes cannot modify the primary checkout.
Scripts are off unless approved and plugins are always off. pip creates `.venv` and
installs `requirements.txt` (plus `requirements-dev.txt` or
`dev-requirements.txt` when present) from wheels only unless source builds are
approved. Without that approval, requirements must name registry distributions;
local/direct source references and build-control overrides are refused.
Local `-r`/`--requirement` and `-c`/`--constraint` includes are shown and
fingerprinted recursively. Includes must stay inside the package directory;
remote/dynamic includes, cycles, and graphs over 32 files or 32 KB are refused.
Changing an included file invalidates the approval.
This separate installer also requires explicit approval and leaves its
lockfile for the ordinary developer commit.

`setup_database` supports the same PostgreSQL/MySQL connection and local-server
options. For SQLite it creates a **new local file** at an ignored path, optionally
applying a SQL file containing CREATE TABLE/INDEX statements. It requires a
separate user approval, never overwrites existing data, and never grants
`project_db_query` permission. Keep the schema and repeatable initialization in
source control; runtime databases remain local to their worktree.
It requires `connection_file` in the same shape. On a developer branch the
new file must be in writable scope, reads the application's existing environment
configuration, and is committed and tested with the ordinary developer changes.

Supported package managers are npm, pnpm, yarn (classic and Berry), bun,
Composer, pip, uv, Poetry, Bundler, Cargo and Go, using toolchains already
installed on the machine (including Windows command shims). Posse builds every
command itself from registry package names and version constraints; a manager
outside this list needs a registry entry in
`lib/domains/system/functions/package-managers.js`. JavaScript workspaces, Cargo
workspace members, vendored Go modules, OS toolchain installation,
and existing-database migrations require separate setup. Local PostgreSQL/MySQL
server provisioning is the explicit system-installation capability described above.
