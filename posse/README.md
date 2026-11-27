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

## Iterative tests

Bossy recommends **one test setup** containing the prompt, guidelines, initial
payload files, metrics, iteration allowance, acceptance policy, model choices
and budgets. Its existing review card offers **Approve & start**, **Adjust
setup**, and **Cancel**. Approval launches a Posse-owned runner agent. Bossy
never walks the user through individual stage/run tool calls.

The runner uses the existing caller-owned agent dispatch framework. The
coordinator manages the loop; a writer produces scoped candidate edits and an
assessor reviews them before staging. The optional proctor reads
compact findings and has no mutation authority. All roles default to `standard` with medium reasoning; the approved setup can
change them. Defaults allow 100 calls, 1,000,000 tokens, $25 and one hour.
Baseline and reviewed-candidate execution run directly from campaign state,
without coordinator calls. An ordinary iteration needs three model calls:
choose an improvement, write it, assess it. Repairs, extra source reads and
optional advice consume additional calls. Scoring and direct integration use
no model calls. Every decision and delegated call
counts against the same model-call, token, spend and active wall budgets.
Unknown model usage stops further inference. Token/spend checks stop new calls;
they cannot undo an overrun by the final in-flight call. Human review time does
not consume the active wall budget.

**Passing an iteration is different from meeting the goal.** A completed,
independently scored improvement can pass and be accepted below the goal.
Automatic acceptance normally requires the configured primary metric's minimum
gain, no goal-metric regressions, and all guardrails. Human acceptance pauses the
runner until a decision; guardrail violations cannot be promoted. Acceptance
atomically advances the experiment's file snapshot and current baseline.
Rejection preserves the prior accepted files. The starting baseline never
changes. Acceptance alone does not change the source repository. An optional
integration configuration can verify the accepted source, commit it, and merge
it into the main worktree, as described below.

For an explicit quality/speed tradeoff, automatic acceptance can include
`tradeoff:{metrics:[{id,weight,normalization,max_regression}],min_gain}`. Include
every goal exactly once. `normalization` is `absolute` (metric units) or
`relative` (fraction of the positive starting value). Weighted gain must be
positive and reach `min_gain`; this replaces the primary minimum. Regression
caps and relative scales stay anchored to the starting baseline, so successive
small sacrifices cannot accumulate beyond the approved limit. Guardrails and
goal targets still apply. Reports retain each metric's contribution and cap check.
For example, quality with weight 1 and an absolute 0.01 loss cap, plus latency
with weight 0.05 and a relative 0.10 loss cap, requires more than 20% faster
execution to compensate for one percentage point of quality loss.

The owner captures a baseline once and reserves each iteration durably before
execution. A staged or failed candidate consumes its iteration. Accepted goals
stop the loop; otherwise the iteration allowance or model budget stops it.
Revision guards, snapshot digests and idempotency receipts prevent stale review
and duplicate launches. Owner restart reconciles sandbox work and marks model
work interrupted; it never silently repeats a potentially billed decision.

**Toolkit › Tests** in Bossy displays active runners, periodic percent complete,
starting/accepted/current metric values, stale-measurement warnings, decisions,
budget usage, history and charts using the existing UI components. Human review
buttons are bound to the displayed candidate revision. Reports update from
owner telemetry without model calls, and remain available after completion.

### Reusable labeled corpora

`posse experiment corpus schema` prints the import example, prep defaults and
prep tools. `corpus list` lists every registered corpus in the project, including
when called from a task worktree. `corpus choices` gives a compact inventory with
case counts, readiness, metric IDs and pinned revisions. Ask the user whether to
use, create or expand a corpus before constructing the test setup. An `init`
request without a corpus or explicit evaluation returns `corpus_choice_required`
before creating a workspace. Preparation is a separate step; testing never
silently generates or expands a corpus.

Other actions take one JSON request on stdin:

```sh
posse experiment corpus create < corpus.json
posse experiment corpus import < items.json
posse experiment corpus prep < prep.json
posse experiment corpus inspect < corpus-reference.json
posse experiment corpus update < corrections.json
```

Use `{experiment:"cards", corpus:"selected", contract:{fields:[...]}}` to
create an empty corpus. Batch import accepts up to 100 `items` per request and
can create the corpus when supplied a contract. Each item has `label`, `tags`,
`profile`, `input`, `resources`, and `expected`. Resource bindings accept a local
`path` relative to the experiment directory, a public HTTPS `url`, or an existing
resource `id`; each can supply a human-readable `label`, a safe filename `name`,
and an optional expected `sha256`. A case may bind several resources, such as
`rom`, `controller_trace`, and `save_state`. Downloads have byte/time limits,
validate redirects and public destinations, and purge temporary raw files.

```json
{
  "experiment": "cards", "corpus": "selected",
  "contract": {"fields": [
    {"id":"identity","path":["identity"],"kind":"exact","weight":0.7},
    {"id":"printing","path":["printing"],"kind":"exact","weight":0.3,"depends_on":["identity"]}
  ]},
  "items": [{
    "label":"Selected card — glare photo", "tags":["glare"],
    "resources":{"image":{"path":"inputs/card.jpg","label":"Selected card photograph","name":"image.jpg"}},
    "profile":"card-identification-v1", "input":{},
    "expected":{"identity":"canonical-card-id","printing":"canonical-printing-id"}
  }]
}
```

Resource and case labels lead inspection and per-case reports; hashes identify
immutable bytes and bindings internally. Changing labels or tags creates a new
corpus revision without duplicating resources, cases or answer keys. Storage is:

```text
.posse/experiments/
  .resources/<sha256>.zip           # shared resource archive
  .resources/<sha256>.json          # archive and payload integrity manifest
  .resources/<sha256>.labels.json   # human-readable resource labels
  corpora.json                     # project registry
  cards/
    inputs/                        # operator-owned originals; never purged
    items/<case-id>.json            # resource bindings + profile + scenario
    answers/<answer-id>.json        # expected answers bound to the complete case
    corpora/selected.json           # current membership and labels
    corpora/selected/<revision>.json
    prep/<run-id>/report.json
```

Another corpus in the same experiment can import `entries` containing existing
`case_id`, `answer_id`, `label`, and `tags`, instead of supplying `items` again.
Resources are deduplicated project-wide. An archive currently contains one
opaque resource file; multiple named bindings form a bundle. User-supplied ZIPs
are treated as opaque files, never automatically extracted as arbitrary paths.
Hashes of both the archive and expanded bytes are checked before staging.

`update` requires `expected_revision`. Supply `items` to correct answers, or
`entries:[{case_id,label,tags,resource_labels}]` to change annotations. Resource or
scenario changes produce a new case ID; use `remove` with `case_ids` and
`expected_revision` to remove obsolete membership. Older revisions and keys
remain intact. `inspect` accepts `revision` and `include_answers:true` for review.
`register` repairs registration from the current stored corpus head.

For a prep agent, supply `{experiment, corpus, prompt}` and optionally `contract`,
`model`, `reasoning_effort`, and `budget`. It can propose the contract for a new
corpus, inventory/read the inputs directory, view image pixels, download public
resources, and batch import cases. `download_batch` fetches up to 100 labeled
URLs in one agent call, with four transfers and 200 ms between starts by default.
The agent can lower `concurrency` or adjust `delay_ms` for the source's limits.
The compact result table preserves request order and individual errors, so only
failed items need retrying. Each success retains full provenance; hash archives
are shared and staging is purged, including on cancellation. Single and batch
downloads share the same byte budget and public-HTTPS checks. Downloaded metadata
remains evidence; inferred answer keys still require verification.
`downloads` retrieves paginated receipts from current and prior prep runs for the
same corpus, with optional label/URL search. `inspect_json` projects requested
field paths from an archived JSON resource or input file into a bounded table;
array indexes and pagination avoid sending large API responses through the model.
For example, `{id, array_path:["data"], fields:{name:["name"],image:["image_uris","large"]}}`
reads just the selected columns. Truncated cells are explicitly marked.
The import schema describes profiles and resource bindings explicitly. Malformed
arguments return a field-specific error so the agent can correct its next call.
`corpus` defaults to whole-corpus status and tag/profile counts, so coverage checks
do not require recounting pages. `view:cases` returns bounded membership tables
with image/resource IDs and `next_offset`; answer provenance is not repeated.
Prep keeps at most four recent results within 16 KiB of working context, plus
compact notes and twelve recent operation summaries. Related metadata and
resource IDs therefore survive the next tool call without replaying the full
history; read parameters remain in the ledger for reproducible retrieval.
Defaults are standard/medium, 100 calls,
1,000,000 tokens, $25 and one hour. It uses bounded context with working notes and
an operation ledger; usage and download provenance are saved in its report.
Rerunning prep expands an existing corpus. Model decisions are never automatically
replayed after interruption. Staging is purged on completion/cancellation; the
next prep invocation also cleans staging from dead local prep processes.

Operator CLI imports are verified answer keys. Agent-inferred answers remain
**draft** and prevent launching that corpus until corrected/verified or removed.
The prep agent can import an operator-provided JSON answer manifest from inputs:
`{items:[...]}`, with resource paths relative to that manifest and a required
`sha256` for each resource. The exact manifest contents are imported and its hash
recorded; the agent cannot edit that file or certify its own downloaded manifest.
Review draft answers with `inspect` and promote corrections through `update`.

Scoring contracts support weighted exact values (including explicit accepted
alternatives), numeric tolerance and linear partial credit, set F1, and one-to-one
object matching by bounding-box IoU with optional attribute scores. Missing or
extra objects lose credit; duplicate detections cannot match multiple answers.
Dependencies can require correct card identity before printing earns credit.
Unknown answer fields are excluded from the denominator; they are not invented.
Scoring is deterministic host code, including partial credit; an LLM never judges
predictions. The contract and answer keys freeze when a run is initialized.

A contract may also include a compact `interface` with `resources`, `input` and
`prediction` maps of field names to descriptions, plus `requirements` strings.
For example, `resources:{image:"PNG/JPEG card photograph"}` documents the alias,
while `prediction:{identity:"Canonical card ID",printing:"Canonical printing ID"}`
documents expected output types. Keep this public usage information free of
case answers. The prep agent and test writer receive the contract; the coordinator
receives its identity and compact findings. Resource aliases are sampled to 32
with an explicit omitted count; use stable aliases across cases. Interface text
is limited to 8 KiB and the complete contract to 16 KiB.

Corpus-backed writers and assessors also receive `test.corpus_cases` and
`test.inspect_resource`. They can list ten labeled cases at a time and inspect
one resource by case index and alias: PNG/JPEG/WebP/GIF pixels, UTF-8 text, or hex
bytes for ROMs and other binaries. Inspection resolves only the frozen corpus's
resource bindings, verifies archive integrity and never returns answer keys.
The prep agent retains its own scoped inputs/inspect/download tools.

Previews are requested on demand. Text is limited to 4 KiB and hex to 512 input
bytes per page; images use the shared bounded image viewer. Only the next agent
decision receives the requested pixels, and the last four inspection/source
results remain in context. Temporary preview files are purged after success,
failure or cancellation. Inspection follow-up calls count against the existing
budget; the coordinator receives no inspection tools or pixels. Specialized
formats still require an appropriate adapter; inspection does not execute ROMs
or automatically render PDFs/audio/video.

To run a corpus, replace the inline `evaluation` in an init request with
`corpus:{experiment,corpus,revision?}`. Metric IDs are `score` or contract field
IDs; use higher-is-better fraction metrics. Selected field metrics require answer
coverage in every case. The Node/Python JSONL adapter receives
`{case_id,input,files}` and returns `{case_id,prediction:{...}}`. `files.<alias>`
resolves to a read-only path under `/input-files/`; labels, keys, and registry
manifests remain outside the sandbox. Temporary expanded files are removed after
success, failure, cancellation or owner recovery; archives remain reusable.
Custom programs such as an emulator still require their experiment-specific
adapter and a suitable pinned runtime image.

Corpus experiments can also declare the reserved `latency_ms` metric with unit
`ms`, direction `lower`, and aggregation `mean` or `p95`. The owner measures from
admitting one input to receiving its matching prediction, then admits the next
input. Payloads must respond and flush per line; they must not wait for stdin
to close. Timing includes transport, scheduling and input processing, plus
startup on the first case. It is runtime-specific elapsed time, not a claim
about physical-device latency. Candidate-supplied timing is not accepted, and
the corpus cannot define an answer field named `latency_ms`. Timing is retained
in case results and included in execution evidence.

`posse experiment case-results <prepared-directory>` saves a labeled component
score table to `case-results.json`. `status` includes the weakest cases and tag
summaries. Raw `case-results` requests accept `{id,which}` with `latest`, `accepted`
or `baseline`. Detailed answer keys are never included in optimizer context.

### Owner and Bossy corpus selection

Bossy lists corpora with `experiment.corpus_options`, asks **Use existing**,
**Create new**, or **Expand existing**, and reviews preparation separately from
the test setup. `experiment.corpus_prepare` starts a bounded background prep job;
`experiment.corpus_status` reports readiness and usage without loading answers.
Expansion requires the current `expected_revision`. Idempotency keys prevent
repeated preparation; interrupted paid work is never replayed automatically.

For testing, supply `repo_path` and `corpus:{experiment,corpus,revision}` alongside
the Bossy setup. The owner binds that verified revision and persists its private
evaluation before launch. Draft answers block binding. A public contract is
available through `experiment.corpus_contract`; it contains no answer keys.
The existing setup still supplies payload files and a configured sandbox runtime.

External callers can use the same owner operations through stdin:
`posse experiment corpus-options`, `corpus-contract`, `corpus-prepare`,
`corpus-status`, and `corpus-bind`. Options takes `{repo_path,offset?}`; contract
and bind take `{repo_path,corpus}` (bind also takes `setup`); preparation takes
`{repo_path,mode,preparation,idempotency_key}`; status takes `{id}`. Standalone
`posse experiment corpus prep` remains a foreground preparation command.

### Standalone workspace preparation

Run `posse experiment init-schema` for the input example, then supply the
experiment-specific objective, metrics, file scope, JSONL entrypoint, frozen
evaluation, and repository checks:

```sh
posse experiment init-schema > init-contract.json
posse experiment init < experiment.json
# init returns the prepared directory and exact commands:
posse experiment launch /path/to/repo/.posse/experiments/algorithm-v1
posse experiment progress /path/to/repo/.posse/experiments/algorithm-v1
posse experiment status /path/to/repo/.posse/experiments/algorithm-v1
posse experiment stop /path/to/repo/.posse/experiments/algorithm-v1
```

`init` resolves the checked-out `main` or `master` destination, pins its commit,
reads declared source from Git, fills source/evaluation digests, and prepares
an immutable launch request. Specify `trunk_branch` if the destination is
ambiguous or uses another name. Paths after `work/` map to repository paths by
default; provide `mapping: [{source, target}]` for different writable paths.
Inline initial contents, especially a read-only adapter, belong in `setup.files`.
Mapped existing source must match the pinned commit; pending edits to those
files block preparation. Unrelated dirty files are preserved and may block
final merging until trunk is clean.

The input is `{name, setup, evaluation, checks}` with optional `mapping`,
`prepare`, `trunk_branch`, `image`, and `runtime_path`. `setup.plan` supplies
`objective`, `entrypoint`, `files`, and `metrics`; ordinary plan/settings fields
can be overridden. Defaults are ten iterations, automatic acceptance against
the first goal metric, **standard / medium for all roles**, and a shared budget
of 100 model calls, 1,000,000 tokens, $25, and one hour. These are ceilings, not
spending targets. Checks remain explicit argv commands; initialization never
guesses evaluation answers or treats an arbitrary package script as the
experiment's success criterion.

Preparation provisions a separate private owner under
`~/.local/state/posse/experiment-owners/`, pins a locally available Docker image,
and pulls the profile's default image if missing. Supply `image` to choose a
different tag or immutable ID. Linux Docker isolation and user systemd are
checked before preparation succeeds. Existing evaluations/images can be copied
from `runtime_path`, the repository's `.posse/experiment-owner` runtime, or the
configured/default owner. Evaluation labels stay in the private owner runtime.
No global owner is restarted or rewritten. Docker and systemd themselves must
already be installed and accessible.

Each directory selects its own owner automatically: no environment exports,
digest copying, launch-envelope construction, or campaign-ID copying are needed.
`init` performs no model calls. `launch` starts the validated setup and is safe
to replay after a lost response. `status` saves `report.json`. Changed prepared
setup/runtime data is rejected; initialize a new name to change the experiment.
The prepared branch/worktree path is unique; the integration worktree is created
when an accepted result is ready, then the direct strategy checks, commits, and
merges it into trunk without model inference.

Separate initialized experiments can run concurrently, including alongside
ordinary work in other worktrees. Their owners and snapshots are isolated;
trunk updates use shared Posse Git locks and check the combined tree when trunk
has advanced. This does not reserve work-item file claims or coordinate arbitrary
external writes. Raw launches against one shared owner retain its one-runner
limit. Concurrent owners share the machine's CPU/memory and provider capacity.

Raw operator CLI (for callers managing their own owner and setup):

```sh
posse experiment setup-schema
posse experiment setup-validate < setup.json
# request: {"setup": {...}, "setup_digest": "<reviewed digest>", "idempotency_key": "..."}
posse experiment launch < approved-setup-request.json
posse experiment list
# request: {"id": "<campaign id>"}
posse experiment progress < campaign.json
posse experiment status < campaign.json > report.json
bossy experiment-report < report.json
posse experiment stop < campaign.json
```

### Compact agent context

Agents receive separate **accepted** and **rejected** tables with column names
once and one row per decision. Each row includes the change and measurements;
rejected rows also include the reason. Agent context retains the latest eight
rows per table and reports how many older rows were omitted. The campaign
report retains the full tables and its existing iteration history for charts.

Writers receive editable source within a 24 KiB allowance and an inventory of
other files; `test.read` retrieves bounded source ranges when needed. Writers
can submit exact replacement patches. Assessors receive changed spans and can
read accepted or candidate source rather than receiving both complete snapshots.
Truncated spans are explicit and require further reading before approval.
Integration adaptation uses compact current state and recent action receipts,
not an accumulating transcript of source reads, writes, and successful logs.
Successful checks return short receipts; failures include bounded diagnostics,
and `integration.check_log` retrieves the stored log on demand. Operators can use
`posse experiment integration-log` with `{id,stage,check}` (`stage` is `candidate`
or `trunk`, and `check` is a zero-based index). Reports include
per-role request-byte totals/peaks and reported input/output token counts;
request bytes measure context size, not billable tokens.

### Integrating accepted code into trunk

Add `integration` to the setup to close the loop automatically after a goal,
iteration limit, or model budget stops an experiment with an accepted change.
`setup-schema` includes the complete schema and an `integration_example` using
**`strategy: "direct"`**. Direct integration uses **zero model calls and tokens**.

Test the actual shippable source as the writable payload. Keep JSONL wrappers,
fixtures, and adapters read-only. Map each writable payload file to exactly one
writable repository file, for example:

```json
{
  "strategy": "direct",
  "repo_path": "/absolute/path/repo",
  "worktree_path": "/absolute/path/task-worktree",
  "branch": "experiment/algorithm",
  "trunk_branch": "main",
  "base_commit": "<full pinned commit>",
  "commit_message": "Apply accepted algorithm experiment",
  "mapping": [{"source": "work/algorithm.mjs", "target": "src/algorithm.mjs"}],
  "files": [{"path": "src/algorithm.mjs", "mode": "modify"}],
  "prepare": [],
  "checks": [{"program": "npm", "args": ["test"], "cwd": ".", "timeout_seconds": 120}],
  "budget": {"model_calls": 0, "tokens": 0, "spend_usd": 0, "wall_seconds": 600}
}
```

For modified repository files, starting payload bytes must equal the pinned
repository source. Validation rejects a transformed adapter being substituted
for source before the experiment starts. The harness copies the accepted bytes,
runs the fixed repository checks, commits, and updates the declared trunk in
`repo_path`. Unchanged trunk fast-forwards to that exact verified commit. If
trunk advanced, the harness cleanly merges it into the isolated candidate and
checks the combined tree before fast-forwarding trunk. It uses the existing
Git worktree/branch locks and scoped commit machinery. It does not push or deploy.

Dirty trunk, changed checkout, conflicts, or failing merged-tree checks stop
without overwriting user work or dispatching an agent to redo the experiment.
`merge_blocked` retains the verified candidate and diagnostics. Replaying the
same integration request retries only the merge/check work. Restart recovery
reconciles a recorded merge candidate already present in trunk rather than
creating another commit. Earlier failures without a verified commit preserve
the worktree and require a new request key, branch, and worktree for another try.

When adaptation is actually required, explicitly select `strategy: "agent"`
and provide `instructions`, `model`, `reasoning_effort`, and positive model-call,
token, and spend budgets. This uses the compact agent context above; a configured
`trunk_branch` then enables the same deterministic merge. Legacy configurations
without `strategy` retain their previous agent behavior and do not gain trunk
write authority unless `trunk_branch` is supplied. Direct mode never silently
falls back to agent adaptation.

For an already completed experiment:

```sh
# {"id":"<campaign>","snapshot_digest":"<accepted digest>",
#  "integration":{...},"idempotency_key":"integrate-v1"}
posse experiment integrate < integration-request.json
posse experiment status < campaign.json
```

This is operator-owned **host execution authority**, distinct from sandbox
payload edits. Paths, commands, trunk destination, and budgets are included in
the validated setup summary and digest. Commands are fixed argv lists, run
without a shell with bounded time/output; `cwd` is worktree-relative. Dependencies
and build output must stay ignored by Git. Checks must succeed without changing
the source tree. Status/report receipts bind the accepted snapshot, verified
commit, merged tree, and trunk commit. `stop` interrupts unfinished work. No
private evaluation labels are exposed to models. Adapted or merged code still
needs appropriate real-world validation; original experiment metrics remain
attached to the original accepted snapshot.

The lower-level `schema`, `validate`, `create`, `stage`, `run`, `get`, `files`,
`decide` and `cancel` owner operations remain available for harness integration.
They are not Bossy assistant actions. `schema` and `validate` only check plan
structure and never grant execution. `report < measurements.json` retains the
older provisional v1 artifact formatter; `status` emits owner campaign v2.

### Execution profile and provisioning

The implemented adapter is **offline numeric prediction**, with Python or Node
JSONL payloads. `experiment schema` includes public templates: stdin carries
`{case_id,input}` and stdout must return exactly `{case_id,prediction}` once per
case. Host scoring supports absolute error, squared error and exact match,
with mean/min/max/p95 aggregation. General test suites, backtests and GPU
training still need workload adapters; declaring a latency metric does not
make a numeric scorer measure elapsed latency.

Execution is disabled unless an operator installs a regular, owner-owned 0600
`experiment-runtime.json` in the automation data directory. Its shape is:

```json
{
  "schema": "posse.experiment.runtime.v1",
  "images": {"node": "sha256:<installed image id>", "python": "sha256:<installed image id>"},
  "evaluations": {
    "evaluation-v1": {
      "schema": "posse.experiment.numeric.v1",
      "cases": [{"id": "case-1", "input": 2, "expected": 3}],
      "scorers": {"error": "absolute_error"}
    }
  }
}
```

Images must already be installed and pinned by image ID; no image pulls,
package installs or network access occur. Plans must use empty dependency lists
for this profile. Setup-schema discovery returns evaluation references, digests
and scorer names without labels. Freeze representative evaluation cases before
experiments; do not specialize product code to hidden answers.

The backend requires Linux Docker with cgroup v2, effective CPU/memory/pid
controls, seccomp and a user systemd manager. The container has a read-only
root and payload mount, no network, dropped capabilities, no privilege gain,
non-root UID, bounded tmpfs/output, and no owner socket, scorer or labels.
Owner caps are 2 CPUs, 2 GiB and 600 seconds per execution, one active sandbox.
One runner campaign is active or awaiting review at a time. A systemd deadline
removes the container even if the Node owner dies. Missing
capabilities fail closed; there is no unsandboxed fallback. This boundary
protects the payload and narrowly issued agent tools, not an operator with
unrestricted host access.

Run the explicit local integration probe with an installed Node image:

```sh
node scripts/smoke-experiment-sandbox.mjs sha256:<installed-node-image-id>
```

It checks isolation, forged/duplicate/incomplete output, flooding, deadlines,
cancellation, owner-death cleanup and one approved setup through baseline plus
two accepted iterations. Model decisions are scripted in this probe; container
execution and scoring are real. It does not provision the live owner or deploy.

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

Before attaching another job, an agent with an expired grant gets a new gate
issued through Remote, bounded by its previous tool contract. Renewal preserves
the logical agent, provider, and handoff and never interrupts an active job.
Citation children retain their parent's ceiling and cannot renew it themselves.

Claude and Codex use the same issued tool and capability ceilings. Hosted web
access also requires the issued web policy and local web-tools setting: Claude
exposes `WebFetch`/`WebSearch`, and Codex exposes its hosted web search. Local
file, test, and shell operations remain behind the Posse MCP gateway. Publish
native support before updating the client to enable Claude web dispatch.

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

Account settings bound total children per planner call (see [Planner research](#planner-research) for the current default), child turns
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

## Review model selection

Every assessment starts from the configured Assessor model tier and reasoning
strength in Admin, including final review and assessment-only recovery. Task
risk and retries may raise that baseline; they cannot silently lower it.
An explicitly selected strong tier remains strong. Provider tier-to-model
mappings still select the concrete model. Review execution observations record
the baseline, effective model, and reasons for escalation. Settings changes
apply to fresh reviewer calls, not an already-running reviewer session.

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

Every gate uses its canonical ID from `WORK_ITEM_QUESTION_CHOICE_IDS` for its
stored contract, payload identity, client question kind, and approval policy.
Scope approval is `file_scope_approval`, with the setting
`approval_policy_file_scope_approval`. Runtime callers cannot use aliases or
change a registered gate's identity. On upgrade, the storage migration converts
older gate names and policy keys while preserving gate decisions and generations.
Policy migration retains explicit settings over `ask` defaults; conflicting
explicit settings become `fail_closed` and their previous values are audited.
If two open gates would acquire the same identity, migration rolls back instead
of discarding either decision.

Admin → Approvals exposes each gate policy, including environment setup and
push offers. These two default to Ask and require their own saved policy for
automatic action; general auto-approve flags do not enable them. The Scope
approvals group keeps the file-scope policy beside routine auto-approval, which
is on by default. Saved Reject or Fail closed policies override routine approval.

When a developer or fix job has `write_tests: true`, it can claim new files
inside `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, `__snapshots__/`, and
`testdata/` without another approval. Each claim adds an exact writable path;
existing tests require explicit scope, and another unfinished job's tests
cannot be claimed. `tests_to_run` grants execution permission only. Test
creation grants do not create empty placeholder files.

Per-job verification runs the job's selected or owned tests. Commands that
discover the full suite remain integration obligations at the isolated merge
gate. Post-change verification runs the assessed commit in a detached checkout,
so concurrent edits and test cleanup cannot modify another agent's work.

Submitting a development plan registers its starting commits for shared baseline
verification. Before its developers begin, Posse collects each starting point in
one detached checkout and shares identical checks across the plan's tasks.
Each task retains its own frozen receipt, including existing failures. Completed
receipts survive restarts. Checks use the actual runner invocation, so files mapped
to the same repository section share one execution and report the broader scope.
Baseline collection and waiting have their own bounded wall budget and do not
consume the agent's runtime allowance; phase observations report both durations.

Passing merge-candidate and post-change checks can supply a later baseline on the
exact same Git tree, including a squash commit with a different commit hash.
Evidence is bound to the project, invocation, policy, toolchain and environment;
only missing or invalidated checks run again. Failed or waived merge checks never
become passing baseline evidence, and ancestry alone cannot prove a new tree.
In-flight tasks retain their original baseline. Post-change checks still verify
each task's resulting code.

Choosing **commit** at a preserved-work recovery gate commits the authorized files
and resumes validation of that candidate. An interrupted developer's missing
final response is recorded as an operator recovery, without claiming verification
passed. **Send back** resumes development with the supplied feedback.

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
posse admin
posse doctor --first-task
posse go --approve-plan --no-auto-merge
posse review
```

`posse add`, `posse go`, `posse admin init`, and session joins initialize the project. Other repository commands
require that initialization. `posse doctor` and `posse update` skip repository
dependency installation when run elsewhere. The installer explicitly provisions
shared tools from Posse's own checkout.

`posse go` plans and runs queued work. Boot checks required dependencies,
attempts doctor repair when unhealthy, and stops if verification still fails.
Use `posse help` for the full CLI reference.

`posse doctor --first-task` adds one readiness report for Git and commit identity,
the configured planner/developer/assessor provider pools, runtime requirements,
and declared root verification commands. It sends no model request and does not
execute those commands. A declared check is not passing evidence. The report
explains missing prerequisites and the queue → plan → run → review workflow;
the example above requests plan approval and disables auto-merge for that run.
`posse plan` alone queues planning jobs; it does not execute or display a plan.
Use `posse plan review <wi-id>` to inspect an existing plan.
`--json` includes `first_task`; exit status is nonzero when first-task readiness
is blocked or needs attention, even if the dependency-only `ok` field is true.
Run `posse add` first to initialize a new project; a skipped doctor check never
claims that project's runtime is ready.

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
- `local install <slug>`: download and verify a local model after a size
  confirmation.
- `local-models [list]`: inspect the signed local-model catalog.
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
- A script that exits non-zero or is killed by a signal fails: its test does
  not publish, and its run is `failed` (`script_failed`) for run history,
  schedules, skill recipes and skill tests, while a calling agent still gets
  the exit code, output and stderr. A tool whose exit codes carry results (a
  status probe, a diff) declares `"exit_codes_are_data": true` in `tool.json`;
  then any exit code is a result, and only a signal or timeout fails it.
- A tool may declare `output_schema` as a JSON object schema. Posse checks the
  script's parsed JSON output against it before a passing test publishes the
  tool and again on each run. Bossy can create this schema from typed output
  fields and edit the script through the automation owner; saving code changes
  the digest and requires a new passing test.
- Registered-agent transcripts preserve structured script reports and delegated
  agent receipts as complete JSON up to the dispatch budget of 1,000,000
  characters. Oversized values become explicit omission records rather than
  partial JSON. Failed scripts retain their host failure metadata alongside
  structured reports, including incomplete execution evidence.
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

- An **Invoke agent** tool also has no script. Create one with
  `posse tools new review.dispatch --template agent --agent reviewer`.
  Posse pins the existing agent's name and definition digest in `invoke_agent`,
  runs it directly through the automation owner's agent runtime, and returns
  its status, reply, conversation ID, tool receipts, usage and errors. The
  default input is `{"message":"the task"}`; a custom object schema is passed
  as JSON task data. Declared private inputs stay outside that task. Test and
  grant the tool like other tools. It declares write effects, and the child
  still needs its own current tool grants and write permission. Changing the
  target definition requires updating the binding and testing again. Children
  use isolated conversations, inherited usage policy, inactivity detection,
  cancellation and a maximum
  delegation depth of four; cycles are rejected. No application dispatcher,
  shell launcher, or `posse-agent` subprocess is used.

- An image or video tool has no script. `posse tools new <name> --template
  image|video [--provider NAME] [--model NAME] [--folder DIR]` writes a
  `tool.json` whose `generate` block names the kind, provider, model, and
  the folder every result is saved in. The folder is required and absolute;
  it defaults to `~/posse-output/<name>` and can be changed. Images run on
  the local image model or an API image model Posse is configured for; video
  runs on the local video model. The owner creates the folder, runs the
  model (a local model through `posse local` in a child process, an API
  model with Posse's own provider credentials), writes one uniquely named
  file there, and returns its path. The tool's `prompt` argument is
  required; other declared arguments pass to a local model as its settings.
  Such a tool always has effect `write`, takes no env, secrets, or caller
  inputs, and defaults to the 600-second timeout; `--param`, `--env`,
  `--secret` and `--effect` are refused for these templates. Changing its
  provider, model, or folder changes its digest, so it needs a new passing
  test; a new provider without a model takes that provider's default model.
  A run that fails, times out, or is canceled leaves nothing in the folder.
  These tools are the only place a custom format is produced: agents work
  in text and call a tool for media.

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

Account-wide quota, authentication, unavailable-provider, and incompatible-CLI
failures mark the provider dead for the rest of the run. All workers skip it
and use an eligible alternative; a pause expiring or a concurrent call succeeding
does not revive it. Starting a new run clears this state, while existing timed
quota pauses still apply. Model-specific limits and transient server failures
retain their normal recovery behavior.

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

## Local Models

Run local text, image and video models directly from any directory:

```bash
posse local list
posse local list --json
posse local --model qwen-image --help
posse local install qwen-code
posse local install qwen-image
posse local --model qwen-code --prompt "Explain Rust ownership" --format text
printf 'Explain Rust ownership' | posse local --model qwen-code --format json --output answer.json
posse local --model qwen-image --prompt 'A red robot holding a POSSE sign' --format png --output robot.png --steps 20
posse local --model qwen-image --prompt 'A red robot' --parameters '{"width":320,"height":320,"steps":20}' --output robot-small.png
posse local --model qwen-image --init-image robot.png --strength 0.6 --prompt 'An oil painting of a red robot' --output robot-painted.png
```

The slugs are `qwen-code` (`qwen2.5-coder-3b-instruct`), `qwen-image`
(`qwen-image-2512`), `qwen-image-edit` (`qwen-image-edit-2511`), and `minimax-h3` (video with stereo audio); either slug or full ID works with `--model`.
`posse local help --model <slug>` lists a model's parameters, defaults and limits.
`qwen-image-edit` edits or combines 1 to 10 reference PNGs named with
`--ref-images a.png,b.png` (refer to them in the prompt as image 1, image 2, …);
it needs a native runtime that advertises reference-image input.

An installed `qwen-image` can also be Posse's image provider: once it is
installed, **Local** appears as an Image provider choice in Admin (or set
`artifact_image_provider` to `posse-local`). Image jobs then generate on this
machine through `posse local`, with no API key and no spend. Output is PNG; a
requested size is scaled to fit 1024 and rounded to 16, and with no size the
model's saved defaults apply. It needs neither a local text model nor the
experimental local-generation setting.

A local model is slow on a CPU, so an image job does not wait for it. The
image tool saves a grey placeholder PNG of the final size, queues a render
job in the same work item, and returns; the agent finishes and that job is not
assessed. The render job runs without an agent, one at a time, for up to 19
minutes, and replaces the placeholder with the real image. Until it has,
promote jobs install the other files and leave that one for a follow-up, and
the work item does not finish, so a placeholder never reaches your branch. A
render that fails keeps the placeholder and is not retried by itself: the
work item waits for you to retry the render job, or cancel it to accept the
placeholder. Outside a job (a media tool, `posse local`) the image is
generated before the command returns.
`posse local --model <slug> --help` lists that profile's supported parameters,
types, defaults, limits and input/output capabilities without loading the runtime.
`--parameters` accepts a strict JSON object using the keys printed by help.
Unknown keys, incorrect types and invalid values are rejected before native startup.
Existing individual flags remain supported; supplying the same setting in JSON
and a flag is an error. Keep the prompt in `--prompt`, `--input` or stdin.
Dimensions follow each model's alignment: for example, use 320×320 rather than
300×300. Silent video is not exposed by the current H3 adapter.
Qwen image-to-image accepts an opaque PNG up to 4 MiB with `--init-image FILE`
or JSON `initImage`. Output dimensions are inherited from the PNG (64–1024,
multiples of 16); explicit dimensions must match. `--strength` / JSON `strength`
requires an image, ranges from 0 to 1 and defaults to 0.75. Higher values transform
more. Sampling is quantized to steps and always runs at least one step, even at
zero. This uses the base Qwen-Image-2512 model; dedicated Qwen-Image-Edit reference
editing is not included. Image input requires an updated native runtime advertising
the capability; existing text-to-image calls continue to work on older artifacts.
`--input FILE` reads a prompt from a UTF-8 file. `--model-root DIR` selects an
existing model store; the default is `~/.posse/models`.
`--runtime-root DIR` selects the ONNX runtime cache, defaulting to
`~/.posse/runtime/onnx-genai`. Generation never installs a model automatically.
`posse local list` and help work offline without a project or Posse key. Execution and
installation use the existing authenticated native ML connection and require a
configured Posse key and a compatible `posse-ml` artifact. File presence in the
list is explicitly unverified; the native runtime checks integrity before use.

Progress appears on stderr: an animated cursor, elapsed time and image step
counts in terminals, plain progress lines when redirected. `--quiet` suppresses
this feedback. Stdout contains only the result, so it can be piped. `--format json` returns the full native response, including image base64; it does not
instruct a text model to generate JSON. `--format png` writes binary PNG and
requires an output file or redirected stdout. New output files are published
only after generation and validation; existing files are never overwritten.
Ctrl+C cancels inference and retires the native worker.

Model downloads require interactive size confirmation. To install image files
already on disk, use `posse local install qwen-image --source /absolute/files`.
An explicit `posse local install <slug>` always replaces that model, including
healthy or incomplete installations; no force flag is needed. New files are
staged and verified before the old installation is replaced, so a failed
download or checksum check leaves the old files intact. Staging requires room
for both copies until replacement completes. This applies to Admin installs too
and requires an updated native runtime. Automatic model setup still reuses
verified installations.
The image installer uses the native catalog's immutable URLs and SHA-256 pins;
callers cannot substitute download URLs or hashes. Qwen image generation is
available on Linux x64 and Windows x64 (AVX2, FMA and F16C), and Linux ARM64 and
macOS Apple Silicon (NEON). GPU mode defaults to `auto`: use a compatible GPU
when available, otherwise CPU. CPU generation can take tens of minutes.
Use `posse local gpus` or `posse local gpus --json` to query available image GPUs
through the authenticated native runtime. Linux/Windows use Vulkan and Apple
Silicon uses Metal. Use `--gpu on` to require a GPU, `--gpu off` to force CPU,
or `--gpu-id ID` to select an exact device:

```bash
posse local gpus
posse local --model qwen-image --gpu auto --prompt "A red robot" --format png --output robot.png
```

With multiple GPUs, `auto` selects the device with the most free VRAM, breaking
ties by device ID. `--gpu on` opens an interactive selector; scripts must supply
`--gpu-id`. Bare `--gpu` remains an alias for `--gpu on`. An explicit GPU ID or
memory cap requires GPU execution and conflicts with `--gpu off`.
Unavailable IDs fail instead of falling back to the CPU. Hardware
IDs are preferred; IDs labelled `enumeration` should be looked up again after
hardware, visibility, or driver changes. Operations exceeding the selected GPU’s
tensor limits run on CPU. The engine automatically balances weights between the
selected GPU and RAM, streaming work in segments. It reserves 5% of free VRAM,
bounded to 512 MiB..1 GiB, for driver/desktop headroom and never borrows another
GPU. Opportunistic weight prefetch uses spare capacity without evicting cached
weights; unsupported CPU-only weights do not consume the GPU allocation estimate.
Use `--gpu-memory-gb 4` to cap GPU use at 4 GiB; this also enables GPU execution
and can only lower the automatic budget. Progress shows the planned budget,
and `--format json` includes the effective budget under `runtime.memory`.
GPU execution requires a runtime advertising GPU memory budgeting; `auto` falls
back to CPU when the runtime lacks this capability or reports no devices.
Generation failures are reported without automatically replaying the request on CPU.
Worker failures include their exit status and recent native stderr.
MiniMax H3 uses the same native engine and GPU controls for text-to-video with
stereo sound. Its pinned quantized profile downloads approximately 33.02 GiB;
inference also needs additional RAM. Install it explicitly, then generate:

```bash
posse local install minimax-h3
posse local gpus --model minimax-h3
posse local --model minimax-h3 --gpu --prompt "A little robot waves and beeps cheerfully" --frames 56 --steps 20 --output robot.avi
```

H3 defaults to 384×384, 56 frames at 24 fps (about 2.33 seconds), and 20 steps.
Dimensions must be divisible by 32; `--frames` accepts 5, 22, 39, 56, 73 or 90.
The profile takes text and an optional first-frame PNG, with guidance fixed to 1. `--format avi`
(the default) writes MJPEG video and 32 kHz stereo PCM audio; `--format json`
includes the video as base64 and generation metadata. No Python or FFmpeg
installation is needed. AVI output is limited to 40 MiB; reduce dimensions or
frame count if it exceeds that limit. For a small execution check, use
`--width 64 --height 64 --frames 5 --steps 1`; this is not a quality test.
The model uses the [MiniMax H3 community license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).

Continue a video from its final frame and stitch the result into a new video:

```bash
posse local --model minimax-h3 --continue-from robot.avi \
  --prompt "The robot turns and walks toward the door" --frames 56 --output longer.avi
posse local --model minimax-h3 --parameters '{"continueFrom":"longer.avi","frames":56}' \
  --prompt "The robot opens the door" --output even-longer.avi
```

This operation requires `ffmpeg` and `ffprobe` on PATH and an updated native ML
runtime advertising first-frame conditioning. It accepts Posse AVI files (24 fps
MJPEG with 32 kHz stereo PCM), including previously stitched output. Dimensions
are inherited; explicit width/height must match. `frames` controls only the new
segment. The repeated first frame of that segment and its audio interval are
removed at the join, so a 56-frame continuation adds 55 frames. Audio is trimmed
or padded to each segment's video duration and video is re-encoded as MJPEG.
The result is bounded to 256 MiB and ten minutes. Existing files are never
overwritten; intermediate files are cleaned up on success, error or cancellation.
`--format json` returns the stitched video and its combined frame count/hash.

To generate a clip from an image without stitching, use `--first-frame frame.png`
(or `firstFrame` in `--parameters`). Supply an opaque PNG of at most 4 MiB with
dimensions that meet the H3 limits. It cannot be combined with `continueFrom`.
Frame conditioning preserves a visual starting point; motion history and audio
are not carried into the next generation, so seamless motion or sound is not guaranteed.

Use `posse local --help` for all generation controls.

Run `posse local-models list` to inspect the verified catalog without downloading.
Every model entry shows its signed download size, minimum and recommended
memory, recommendation summary, intended use cases, runtime profile, and
license.

`posse local install <slug>` is the one download command for text, image, and
video models. Admin's Providers > Local Models > Install a model starts the same
install.

Before any model bytes are requested, Posse presents a confirmation
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

Path-only `run_unit_test` calls also support Jest. They use the nearest owning
package's installed runner and configuration, select the exact file, and disable
watching, coverage output, and snapshot updates. Conflicting script configurations
remain unavailable instead of guessing. Missing test prerequisites are recorded
as infrastructure diagnostics; assertion failures remain product failures.
Commands rejected during planning for missing prerequisites are revalidated at
handoff and restored when they become available and still satisfy command policy.

Scoped lint checks load changed `babel.config.*` and `.babelrc*` configuration
files with the owning package's installed Babel loader in the test environment.
This catches unresolved presets/plugins before tests exist. The probe runs in a
bounded child process and does not generate output files. An absent Babel loader
or an uninstalled declared dependency remains unavailable infrastructure; broken
configuration references are attributed to the config file for review.

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

Node setup (`posse doctor`) also installs Posse's pinned pnpm in the managed
Node toolchain. Declared `pnpm test` / `pnpm run` commands, prerequisite setup,
and test scripts that invoke pnpm use this copy without requiring a global
pnpm or Corepack install. Arguments, workspace filters, and failure exit codes
are preserved. Test execution does not download a project-declared pnpm version;
strict version requirements remain enforced by pnpm. Project application and
test dependencies still need to be installed in the project.

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

An explicit Node wrapper command with selectors, such as
`node tests/run.cjs --file tests/example.mjs`, is also a verification command
when its script and complete argument list match a committed
`unit_test_runners` declaration. Unregistered arguments are rejected; selecting
a wrapper does not remove the repository's required checks.

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

Interactive runs keep the TUI open while a human gate needs an answer, even
when it is the only remaining job for the only work item. Answering the gate
resumes work or allows the run to finish. Headless runs can still return with
operator action required; optional push offers do not keep a run open.

Remote runs keep unanswered review and recovery gates available while the bridge
has an authenticated relay connection, including while the phone is idle. This
does not approve a gate or override an explicit `fail_closed` policy. A stale or
disconnected bridge no longer holds those gates open. Remote start commands
report success only after the child scheduler confirms startup; slow startup is
reported as still starting, and a process that exits before startup is a failure.

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

If Posse reports **database recovery required**, startup stops without replacing
the queue database. Stop all Posse processes for that repository and preserve
the database together with its SQLite `-wal`, `-shm`, and `-journal` sidecars
before attempting recovery. Restore a verified, consistent backup or recover a
copy with SQLite tooling; retain the original files until the recovered queue,
work items, decisions, and history have been inspected. Do not delete the runtime
directory to make startup succeed: that discards operational state. Normal
SQLite crash/journal recovery still runs; this stop applies to corruption errors,
and lock or I/O failures remain errors without automatic quarantine.

Mutating jobs run in per-work-item git worktrees. Successful dev/fix/promote
jobs are committed on the work-item branch. Failed or interrupted work is
snapshotted before cleanup when possible.

A saved final-review pass stops the developer and reviewer calls. Once the
reviewed bytes are committed, the job completes directly from that review,
including after restart. It does not run another assessor or reapply the old
assessment test/confidence policies. Changed code or a changed task contract
requires fresh verification. The accepted pass is announced once.

Productive review/fix revisions continue in the same reviewer session. Repeated
submissions of rejected bytes reuse the saved findings without rerunning checks
or review. Three consecutive reviews with the same unresolved findings initiate
a targeted fix; new findings reset that limit. Posse does not start another
assessor for that candidate. A final edit after the limit preserves the findings
as context to recheck, not proof that the new code is broken. Continuations
retain their work-item limit, and attempt/reviewer time limits still apply.

Before a reviewer closes a repair flow with `needs_review`, it receives one
classification reminder per revision: concrete regressions belong in `fail`
findings. Confirmed reviewer blockers preserve their evidence and open the
normal review gate, including Send back for fixes; they are not classified as
assessment infrastructure failures.
Developers report an unrecoverable blocker with `final_review({ blocker: "..." })`.
Verification-related blockers first run current checks and the normal review,
so stale failures cannot create another recovery gate. Unchanged, freshly
verified blockers can still save BLOCKED; product-input blockers do so directly.
Neither PASS nor saved BLOCKED requires a separate handoff call.

Pauses record owned file contents, staging, branch and attempt identity. Resume
reuses those exact bytes after scope approval or retry; unexplained changes still
require recovery. Typecheck errors confined to dirty files owned by unfinished
siblings are deferred to the isolated merge gate, which runs the full check.
File mutations waiting on scope approval have the same deadline as explicit
`request_scope` calls.

Blocked candidates remain in their worktree while awaiting a decision. An
explicit verification waiver commits the job's authorized files, including
ignored declared tests, before marking it successful and releasing dependents.
A commit failure keeps the gate open and preserves the candidate; retrying the
answer resumes the Git phase without another developer attempt.

Dirty-work recovery also finalizes work left uncommitted by older waivers under
each original owner's scope. It can restore an older blocked snapshot when the
scoped files still match its base. Newer dependent work stays with its current
owner; ambiguous overlaps, changed recovery candidates, and snapshot conflicts
are preserved for resolution rather than silently included or overwritten.

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

Start remote access from an initialized Posse repository:

```bash
posse serve
```

Serve shows a compact startup display with the local URL, collaborator join
code and command, then automatically displays the phone QR and manual token
at an interactive terminal. In the `serve>` console, type `phone` for a fresh
QR, `invite` to show the invitation again or retry a failed reservation, and
`help` for more commands. Phone pairing is optional; a failed automatic pairing
keeps the bridge and collaborator invitation available. `posse serve --pair`
explicitly opens phone pairing, including in JSON mode. Enter skips pairing and
Ctrl-C at the phone prompt cancels only that prompt; both keep serving.
Type `quit` or press Ctrl-C at `serve>` to stop.
Phones retain account-level
credentials and the existing account-paired repository access. Adding a phone
to an existing bridge preserves that repository's identity and credential.
Phone pairing grants access under the serving owner's account; invite a person
using their own Posse installation with the collaborator code below.
Phone commands run on the served computer through its normal queue and execution
path; phone-only use creates no Git branch or temporary repository.

The shared Git session is created only when a clone joins:

```bash
posse serve join ABCDE-FG234
# Existing spellings and invite links remain supported:
posse session join 'posse://session?token=ABCDE-FG234'
```

The join waits while the serving host checks its checkout and provisions the
session. If a phone prompt is open, Posse cancels that prompt before opening the
session console; `phone` remains available there. The collaborator invitation
retains its identity even if first-time phone pairing changes the bridge identity.
The host must then be on its clean, up-to-date default branch with
no scheduler running. Posse uses the authenticated `gh` CLI to create a private
throwaway repository, install a host deploy key, and push a unique side branch.
GitHub remains the only provisioning adapter. Failed preparation is reported to
both ends; the phone bridge remains available. Fix the reported precondition
and type `invite` for a fresh invitation (or restart serve). `--remote`,
`--branch`, `--merge-mode` and `--deploy-mode` on serve apply when that Git
session is created.

`posse pair` and `posse session host` enter this same serving lifecycle. Session
management verbs also work under `posse serve`, such as `serve admit AB23 host`
and `serve status`.

`posse serve --json` (including its aliases) emits JSON lines on stdout for
`serving`, `invitation`, and `stopped` events. The invitation includes the clone
code and `repository_pending: true`; Git activation retains the existing host
session JSON response. Human diagnostics go to stderr. JSON hosting skips the
automatic phone prompt; explicit `--pair` sends its QR and prompt to stderr.

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
posse session admit <COUNTERSIGN> host   # or: member (the default when omitted)
posse session lease <member-id> host     # or: member | default
posse session scope <member-id> '{"files":["README.md"],"roots":["lib/"]}'
```

#### Who is in the session

One roster describes the session everywhere it is shown: one row per person
(the host and every member, including those waiting to be admitted).

```text
who                   role    go       run  queued  waiting  runs on        id
you                   host    running    1       1        0  own
webapp @ ana-laptop   member  running    1       0        1  host           67708284
webapp @ raj-desktop  member  unknown    0       3        0  own (default)  4d826144
```

`run`, `queued` and `waiting` count that person's work items with a job
executing now, not running, and waiting on a person. `runs on` is their compute
lease: `host` means the host's computer and provider account run their work,
`own` means they run and pay for it themselves, and `(default)` marks a lease
the host has not issued, which follows the session policy. `go` is the
scheduler. For your own row it is read from this clone's scheduler lock. Peers
do not advertise their scheduler, so another person's row says `running` only
when one of their jobs is executing and `unknown` otherwise (`away` when the
relay has lost touch with them, `joining` before their first heartbeat,
`pending` before admission).

- `posse go` inside a live session is a **shared run**. It opens on the
  **Session** view (`o`): the roster, each person's sync state, and everyone's
  open work items. It does not end when its queue empties: it stays on the
  session screen, keeps the heartbeat, sync and routing going, and picks up
  work as it is added (`i` adds a task; a task queued with `posse add` in
  another terminal is planned and run too). Finished work is still auto-merged
  when automatic merge is on, and work waiting for review is announced with
  the key (`r`) that reviews and merges it in place. The other views are a key
  away as usual; outside a session the view does not exist and a run ends when
  its work does, as before. A run scoped with `--wi`, an unattended run
  (`--yes`), and a run whose input is not a terminal also end when their work
  does.
- **Ctrl+C in a shared run** stops the scheduler (the usual graceful stop) and
  returns to the session console with the session still live. The session ends
  from the console: the host types `close` (or `quit`, or Ctrl+C), which closes
  it for everyone and asks before the session's work is published; a member
  types `leave`. A shared run also ends when the host closes the session or
  removes this clone, and says which.
- `posse session join` goes straight to the session
  screen once the checkout has synced for the first time, when the terminal can
  show it. `POSSE_SESSION_CONSOLE=1` keeps it in the session console; `go`
  there opens the screen. `go` runs in the console's own terminal on every
  platform (the console is suspended meanwhile); `go window` keeps the Windows
  option of a separate PowerShell window.
- The **host's** Session view is a manager. Up and down select a person; the
  line under the title lists what can be done to them: `a` admits a pending
  request (it opens the session command with `admit ` typed; type the
  4-character countersign the member reads to you, optionally followed by
  `host` or `member`), `e` changes a member's lease (host, member or the
  session default), `c` sets their write scope, and `z` removes them (or
  declines a request) after a confirmation. `h` opens the session's own
  actions: merge, deploy, auto merge and auto deploy on or off, invites open
  or closed, policy, and close. Deploy, close, and turning auto deploy on ask
  first; merge and deploy hand the terminal to `posse session merge` /
  `deploy` for the typed approval and then return. Declining that approval
  is a cancel, not a failure: the command exits with code 3 and nothing is
  published. Every action is the same command `u` takes, so the host
  check stays in the command and the Remote. A **member's** Session view only
  shows: it lists no actions, and the keys do nothing there.
- In the session console (`posse session host` / `join`), `who` (or `panel`)
  prints the roster. On a POSIX terminal the roster stays pinned under the
  prompt (a terminal scroll region) and is repainted in place when someone
  joins, leaves, is admitted, or has their lease changed. Where it cannot be
  pinned (a pipe, a dumb or too-small terminal, Windows) it is printed into the
  feed as a block on each such change. `POSSE_SESSION_PANEL=block` forces the
  block, `=pinned` also pins on Windows, and `=off` silences it.

#### Session trees: leave them up, rejoin, purge

A session's shared branch (`posse/pair-*`) and its private GitHub repository
are a **tree**. Quitting a hosted session at the terminal asks what to do with
it: `k` leaves the tree up (the branch, the private repo and its key are kept),
`p` purges it (the branch, repo and recovery refs are deleted once the work is
published), and Enter keeps the earlier behavior (delete the repo, keep the
local branch). `posse session close --keep-tree` / `--purge-tree` answer that
for a scripted close. The next time you host, trees left up are offered:
rejoin one, which only publishes what changed since, or make a new tree. A
rejoin merges the trunk into the tree (never rewriting history), clears any
member keys left on the repo, and refuses, changing nothing, if the tree and its
repository have diverged or the trunk conflicts. `posse session trees` lists
every tree and whether its work is in the trunk; `posse session trees purge
<tree>` (or `purge --merged`, or the console's `trees` / `purge <tree>`)
removes one. The live session's tree is never removed, and a tree holding work
the trunk lacks needs `--force`.

#### Compute leases: serve and session are one route

`posse serve` and `posse session` differ only in which end owns the work. The
host issues every lease, and the lease names who runs and pays for the holder's
routable work:

| Lease | Who runs the holder's work | Who pays | Today's equivalent |
|---|---|---|---|
| `host` | the host's computer | the host's provider account | a phone paired with `posse serve`; `host-only` |
| `member` | the holder's own computer | the holder's provider account | a clone joined with `posse session join`; `each-member` |

A phone's lease is always `host`, because a phone cannot run work: what it
queues runs on the computer it is paired to. When that computer is itself a
session member on a `host` lease, the phone's work continues to the session
host like any other work from that clone; `posse serve` prints where it will
run. A clone's lease is whatever the host issued at admission (`admit <CODE>
host|member` in the console, or `posse session admit <CODE> host|member`), and
`posse session lease` re-issues it during the session. An admission without a
tag issues `member`: tag someone `host` when they should work through your
Posse on your providers. `posse session lease <member-id> default` returns a
member to the session policy (`host-only` defaults to `host`, `each-member`
and `capability-routing` default to `member`), which is also what a member
whose client predates leases follows. The host always runs its own work.

The issuer's lease is enforced where the money is spent. A member on a `host`
lease offers its routable jobs only to the host. The host claims offered work
from members whose lease the Remote reports as `host`, and caps each such
member to one active job at a time. Under `capability-routing` the host also
takes overflow from members paying their own way, and pays for what it runs.
Members never claim each other's work unless the host turned on
`capability-routing` for the session, and even then only a member paying its
own way balances, and only for members who also pay their own way. An offer
is only ever made to a peer that would claim it. Work a clone imported from another member always runs where it
was imported. If the host cannot take a host-leased job (offline, no matching
provider, or no headroom), the member still runs it on its own account and
records a `session.job_lease_fallback` event. Each
delegation records the lease it was offered or accepted under, alongside the
originator and executor identifiers already kept on model-call cost rows.
`posse session status`, `members`, `who` and the run screen's Session view
show each lease; `(default)` marks one that follows the policy. A Remote that predates leases ignores them, and the
session policy applies as before. A member whose Posse predates leases is never
issued one: the admission reports the lease as not recorded and `posse session
lease` refuses it.

Scope is deny-by-default for unknown paths and is enforced both by the Node
write barrier and the native commit/push/CAS boundary. Scope changes and kicks
invalidate cached native authentication on the next five-second session
heartbeat. If the member monitor is not running, a previously minted envelope
can remain usable only until its normal pulse TTL expires.

`posse pair` and `posse session` remain compatibility aliases for `posse serve`; `posse unpair`
remains an alias for `posse session leave`.

The host and member commands remain connected, like `posse serve`. A live run
adopts the session monitor, so the TUI remains the sole raw-input owner. Its
Pipeline pane shows session phase, roster, invite/policy state, peer work, and
delegated jobs; press `u` for the host session command line. It accepts `admit`,
`kick`, `lease`, `scope`, `policy`, `invite`, `drain`, `close`, `keep`, and `inject`.

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
bounded work packet through `refs/posse/handoff/*`; a `host` lease (the
`host-only` default) routes member work to the host. The winner is selected by
CAS in `refs/posse/jobs/*`.
Transient relay failures pause session routing while local dispatch continues;
a later successful heartbeat resumes routing. Invalid authorization or session
identity drains the scheduler. Graceful drain interrupts parked human gates and
still applies worker runtime limits. Close reports a timeout if workers remain
wedged, preserving the scheduler lock until they exit.

Unreachable transport runs locally, unclaimed offers are recalled, executor-side
human gates remain with the executor, and origin work completes only after the
shared trunk contains its `Posse-Origin-Work-Item` trailer. Model-call cost rows
retain both originator and executor instance identifiers.

Phone enrollment and clone enrollment use the `/v1/pairing/*` route family.
The phone confirmation accepts its four-character code or `admit <CODE> host`.
It issues the existing account credentials and a fixed host compute lease;
clone admission retains its SSH key, scope, and host/member lease checks.
Legacy `/v1/bridge-pair/*` URLs remain compatibility adapters for installed clients.

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

Choose **Node package manager** under **Admin → General → Workflow** to set
your account-wide preference: npm (the default), pnpm, yarn, or bun. The CLI
equivalent is `posse admin set node_package_manager pnpm`. Planning, dependency
installation, and generated verification commands use that choice when the
project has no package-manager declaration or lockfile. Existing project choices
take precedence; this setting does not migrate lockfiles or install the manager
itself. Both `install_dependencies` and the planner's `setup_environment` tool
reject an explicit manager that conflicts with this setting for a package
without a declaration or lockfile, before creating an approval. To choose a
different manager, change the Admin setting first. The installer revalidates
the policy before execution, so changing it can invalidate an outstanding approval.

The exact `.env.example` filename is an ordinary source template and is
available to agents within their normal file scope. Other `.env` files remain
blocked, including symlinks to them. Plan compilation removes requirements that
explicitly name policy-blocked files, records the omissions, and applies the
same filter when older jobs enter execution or assessment. Newly compiled tasks
also retain a versioned original requirement contract with stable content IDs.
Fixes and replans inherit that contract; local developer and reviewer evidence
marks omitted requirements as policy-constrained rather than completed. Agents
may establish the requested behavior using permitted evidence, but the contract
does not grant access to protected files. Legacy jobs retain their existing
filtered contract until replanned. Requirements for `.env.example` remain verifiable.

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
This separate installer follows the environment-setup approval policy and leaves its
lockfile for the ordinary developer commit.

`setup_database` supports the same PostgreSQL/MySQL connection and local-server
options. For SQLite it creates a **new local file** at an ignored path, optionally
applying a SQL file containing CREATE TABLE/INDEX statements. It requires a
separate environment-setup approval (Ask by default), never overwrites existing data, and never grants
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

## Outcome evidence

Status JSON and review reports include an additive `outcome` object separating
execution, reviewer verdict, verification, pending decisions, and delivery.
`checks_passed` means recorded checks ran against the recorded implementation
commit; it does not claim complete behavioral coverage. `review_only` means
source review without current executable evidence. Missing evidence remains
unknown, and waived checks remain visible. The review screen's **Execution
Check** retains the existing queue/dirty-tree check rather than presenting it
as proof of product acceptance. Work-item deployment is verified only by an
exact matching merge-commit receipt; repository-wide publication is shown
separately. `included_in_deployment` means a local Git ancestry check found the
merge in the verified deployed revision's history. It does not claim current
behavior is verified: later commits may change or revert it. Missing local
history stays unverified; outcome inspection never fetches or mutates Git.
Phone review briefs expose only bounded states and counts.

### Requirement acceptance evidence

New plans retain the work-item objective and each task's original requirements.
`posse acceptance show <wi-id>` lists stable `contract:requirement` keys, assigned
jobs, unresolved or policy-constrained outcomes, mapped receipts and waivers.
The review report, status JSON and bridge summary expose acceptance separately
from execution and passing checks. Legacy work is `untracked`, not accepted.

An operator can map an existing executed receipt to an outcome:
`posse acceptance bind <wi-id> <key> <artifact-id> "why this check covers the outcome"`.
Only passing receipts with demonstrated coverage, from the assigned job lineage
and exact current implementation commit, qualify. This mapping is an operator
judgment about coverage, not an automatic claim that a general test proves every
requirement. Changed source, contracts or superseding receipts invalidate evidence.

`posse acceptance require <wi-id> <key>` explicitly marks an obligation.
After inspecting the current plan, `posse acceptance require-all <wi-id>` marks
all currently tracked requirements as obligations in one atomic operator action.
It is idempotent and does not automatically require criteria added by later plans.
Outcome summaries distinguish all unresolved criteria from the subset explicitly
required; zero required outcomes unresolved does not mean all criteria are proven.
In strict verification mode, unresolved required obligations defer merging before
Git mutation; the candidate remains available. Permissive mode reports them only.
`posse acceptance waive <wi-id> <key> "reason"` records a distinct operator waiver
for the current commit. Waivers are visible and expire on source changes. No
acceptance action publishes or deploys the work.

### Following up on earlier delivery

Use `posse add "Dragging coordinates loses changes" --follow-up 123
--follow-up-kind regression` (or the same options with `posse inject`). The kind
is `gap` by default; `regression` and `enhancement` distinguish broken prior
behavior from new scope. The ID is explicit and can refer to older work outside
the recent delivery window. Invalid IDs are rejected before a work item is created.

The follow-up retains a snapshot of prior review, verification, requirement
acceptance and waivers. Planners and reviewers receive that context locally;
prior passes and waivers do not count as evidence or permission for the new work.
Approved assessor suggestions keep their existing suggestion-origin lineage and
are treated as enhancements. Similar titles alone never establish a link.

### Opt-in spend and time admission thresholds

Existing advisory budget settings remain advisory. To enable a work-item gate:

```bash
posse budget configure 123 20 2 60
posse budget show 123
```

This sets a $20 spend threshold, a **$2 reservation estimate per provider dispatch**,
and a wall-clock deadline 60 minutes from configuration. A dispatch can contain
many model turns: choose its estimate accordingly. Use `-` for an omitted limit,
for example `posse budget configure 123 - - 60` for time only. Configuring again
replaces limits and restarts the deadline, preserving all charges and reservations.
A paused budget still requires `posse budget resume 123` after adjustment.

Admission is atomic across workers and includes developer, reviewer, child,
correction, retry, fallback and image requests. It accounts for prior tracked calls
when enabled mid-run. Outstanding reservations count against the threshold. Calls
already in flight may complete and cost more than their estimate; this is an
admission threshold, **not an exact dollar cap**. The deadline is checked before
new dispatches, includes idle/paused time, and does not terminate in-flight calls.

Missing or incomplete cost receipts are unknown, never zero-priced. Unknown image
prices and auxiliary direct-provider calls without a complete accounting receipt
currently require reconciliation when a spend threshold is active.
A paused work item retains queued work and partial implementation; implementation
retries are not consumed, and interrupted assessment resumes as assessment only.
Status, review summaries and the incremental run monitor surface the pause.

```bash
posse budget pause 123
posse budget reconcile 123 <reservation-id> 0.75 "Observed provider charge"
posse budget resume 123
posse budget disable 123
```

Reconciliation requires an observed nonnegative cost and a reason; active
reservations cannot be cleared. Exited processes and ended worker attempts retain
unknown charges until reconciled. Resolve any orphan provider execution before
reconciling its final charge. Disabling the gate is an explicit operator action;
it preserves the ledger. These actions do not merge, publish or deploy work.

### Agent activity and strength

New agent definitions default to 10,000 calls and 20,000 turns. Agent and skill contracts accept up to 1,000,000 of each. Explicit lower limits in existing definitions and grants remain enforced; edit those definitions to increase them. Active provider/tool work uses inactivity monitoring rather than a total elapsed-time cutoff. Bossy’s Stop button or Ctrl+X cancels the parent and delegated child work.

Agent definitions select a model (including `cheap`, `standard`, or `strong`) and optional `reasoning_effort` (`low`, `medium`, `high`, `xhigh`). The legacy `limits.wall_seconds` field measures provider inactivity, not total run time. Activity refreshes that allowance; tool execution does not consume it. New definitions default to 1800 seconds. Native Invoke agent tools follow their selected agent’s inactivity policy rather than imposing their script timeout on the child. Spend, call, turn, explicit script execution limits, and cancellation still apply.

Caller-owned `posse agent dispatch` requests accept optional `reasoning_effort` and `idle_seconds` (1–14400; default 1800). Provider dispatch runs without a total wall cap for these agent decisions, retaining the provider’s inactivity watchdog.


### Direct-assist execution and stopping

`posse agent <name>`, `posse agent run <name>` and `posse agent chat <name>` run without automatic call, model-turn or spending cutoffs. Native Invoke agent children inherit this mode through the authenticated owner. Usage and cost remain recorded. The agent's saved definition and digest do not change. Use `--budgeted` to enforce its saved usage limits; registered applications and scheduled automation retain their budgets.

Operator tests of Invoke agent tools (`posse tools test` and Bossy activation tests) also run without usage cutoffs. Disconnecting the operator request cancels that test and its delegated work; an interrupted test does not publish a passing entry.

Press Ctrl+C to cancel a CLI run and its delegated work, or run `posse agent stop <session-id>` from another terminal. Bossy provides Stop / Ctrl+X. Cancellation revokes the active turn and cancels its child tool runs. An external stop is observed by a quiet provider on the next owner heartbeat (within 30 seconds); Ctrl+C aborts the local provider immediately. Provider inactivity detection, individual script execution timeouts, grants, scope and write approvals remain enforced. Active agent work has no total elapsed-time cutoff.
