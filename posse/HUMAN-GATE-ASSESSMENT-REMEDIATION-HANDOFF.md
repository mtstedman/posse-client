# Human Gates, Assessment Readiness, and Write-Scope Remediation Handoff

Status: implementation plan

Date: 2026-07-25

Scope: Posse queue, worker, handoff, assessment, deterministic tools, UI/bridge,
and the corresponding authenticated `posse-remote` role contracts

## Outcome

Posse must stop turning orchestration, environment, and scope-contract defects
into repeated model attempts or unwinnable human prompts.

The implementation is complete only when:

1. Every displayed human action has one typed, executable, idempotent state
   transition.
2. A current human decision is authoritative and cannot be overwritten by stale
   retry/dead-letter work.
3. Assessment transport, tool, environment, confidence, and terminal-handoff
   failures cannot dead-letter completed implementation work.
4. A writing job is never dispatched with an unsatisfiable file or verifier
   contract.
5. Lint, syntax, typecheck, and test capabilities advertised to an agent are
   actually runnable in the detected project root.
6. `files_to_create` is a non-writing control-plane declaration. Handoff
   materializes it before a writing agent starts; writing agents never receive
   file-creation scope or generic file-creation authority.
7. Concurrent human prompts always identify their work item, original job, gate
   job, age, and chain so that advancing to another prompt cannot look like the
   previous answer caused it.

This is an architectural correction, not a prompt-tuning exercise.

## Corrected incident record

The motivating run occurred on another device. Its event data is not available
in this checkout, so the following timeline is based on the operator-provided
remote logs and must not be represented as locally reproduced.

### WI #123: human pass worked

- 03:59:38 UTC: job #900 passed assessment with medium confidence. Policy
  required high confidence, so Posse started internal assessment retry 1/2.
- 04:02:05 UTC: the second assessment also returned pass/medium. Job #900 moved
  to `waiting_on_review`, and human gate #915 was created.
- 05:02:05 UTC: gate #915 timed out while waiting for input.
- 05:50:41 UTC: the operator selected `[1]`. Gate #915 correctly recorded:
  `Human review passed original job via job #915`.

The human pass did not cause a dead letter.

### WI #124: independent dead letter

- The separate chain was #901 -> #906 -> #911.
- Job #911 repeatedly failed assessment with:
  `agent_handoff was required but no report was staged`.
- After three attempts, job #911 dead-lettered at 04:09:44 UTC and created
  recovery gate #917.
- Gate #917 timed out at 05:09:44 UTC.
- Immediately after #915 was resolved at 05:50:41 UTC, the UI surfaced the
  already-existing #917 prompt without a sufficiently explicit cross-work-item
  transition.
- At 06:06:06 UTC, an explicit retry answer to #917 created retry #918 and
  rewired dependent #902.
- At 06:18:05 UTC, #918 passed with medium confidence and succeeded.

There are two distinct defects here:

1. Assessment protocol failure incorrectly consumed implementation-job attempts
   and dead-lettered completed work.
2. UI prompt sequencing obscured the switch from WI #123/#915 to WI #124/#917.

### Current impossible-scope loop from that run

The later chain was #902 -> #926 -> #930 -> #934.

- #902 initially produced pass/medium, but an assessment attempt was rejected
  because terminal `agent_handoff` was missing.
- Reassessment then required a runnable HTML test entrypoint and/or `.htaccess`
  wiring.
- The generated fix jobs could modify only three test JavaScript files.
- #926 and #930 failed for the same missing entrypoint/wiring reason.
- #934 was dispatched with the same insufficient scope.

The retry chain was structurally unable to win. A fix must not be enqueued until
its required paths and capabilities fit its execution scope.

## Non-negotiable invariants

### Human-gate invariants

- A gate has a typed contract version, original job, generation, allowed source
  states, allowed actions, and explicit postconditions.
- At most one active gate exists for one original/kind/generation.
- Only actions whose preconditions currently hold are displayed.
- Selecting an action either commits its documented postcondition or leaves the
  same gate open with a recoverable error. It never silently no-ops.
- Answer recording, original-job transition, replacement creation, dependency
  rewiring, competing-gate retirement, and gate closure are one logical
  transaction.
- A stale or expired gate lease produces no side effects.
- A recorded answer can be replayed idempotently after a process crash.
- A current-generation human `pass` is authoritative. Stale automation cannot
  overwrite it with retry, failure, or dead letter.
- Human-input execution failure cannot fail the parked original merely because
  the UI, bridge, logging, or resolver failed.
- No dependent may point at a canceled or superseded gate.

### Assessment invariants

- Implementation execution attempts and assessment attempts have separate
  budgets and terminal states.
- Assessment protocol, provider transport, terminal-handoff, missing-tool, and
  environment failures never consume implementation attempts.
- Those failures never assign `failed` or `dead_letter` to otherwise completed
  product work.
- The terminal handoff control channel remains available even when the normal
  model turn/tool budget is exhausted.
- The assessor sees the actual post-attachment capability surface, not a static
  role promise.
- Missing optional evidence is `not_applicable` when other evidence proves the
  criterion. Missing required evidence is `assessment_unavailable`, not product
  failure.
- A confidence floor may require human judgment, but it cannot manufacture
  missing evidence, rerun implementation, or merge unrelated recovery chains.

### Environment and verifier invariants

- Every advertised verifier has a resolved executable, project root, launcher,
  and readiness proof.
- Supported detected languages have a runnable lint or syntax adapter before a
  job that depends on it is dispatched.
- Package-manager selection follows the nearest manifest, `packageManager`
  declaration, and lockfile. It never silently falls back to npm.
- Canonical verifier results are tri-state: `passed`, `failed`, or
  `unavailable`. All-skipped is never success.
- Posse-owned missing tools route to deterministic repair, not human review.
- Agents use canonical verification tools first. Safe syntax-only shell
  commands remain available as exact, policy-checked fallbacks.

### Scope and file-creation invariants

- Planner and assessor are non-writing roles that may declare exact
  `files_to_create` in control-plane output.
- `files_to_create` is not a writing-agent capability.
- Before dev, fix, or ordinary artificer execution, handoff validates and
  materializes every exact declared creation.
- After materialization, every writing-agent file path exists and appears only
  in `files_to_modify`.
- Writing-agent schemas, prompts, session packets, tool tokens, and terminal
  contracts contain no `files_to_create` or `createFiles`.
- Ordinary dev/fix agents receive no generic creation root.
- Creation provenance remains private orchestration data for Git, diff,
  assessment, rollback, and audit. It is not serialized to a provider.
- If materialization fails, no writing agent starts and no agent attempt is
  consumed.
- If an authorized modify path is unexpectedly absent after handoff, writing
  fails as an invariant violation; the agent is not granted fallback creation.
- Specialized artifact tools may create within system-owned output roots, but
  generic writing-agent tools may not use those roots to create arbitrary repo
  files.

## Findings to address

### HG-1: Answer success is recorded before resolution

`runHumanInputJob` stores the answer artifact and marks the attempt succeeded
before applying the selected action. The gate lease is released after original
status changes, replacement creation, and dependency rewiring. A stale resolver
can therefore mutate state before discovering that it no longer owns the gate.

Resolution exceptions also overwrite the already-recorded successful attempt
and can fail the parked original. There is no durable resolution record or
idempotency key.

### HG-2: Gate creation and parking are not atomic

Several producers park an original and create the human gate in separate writes.
Assessment transport handling, `needs_review`, assessor `blocked`, and
post-execution blocked handling can leave:

- a parked original with no gate;
- an open gate for an original that has moved;
- multiple competing gates;
- dependents split across original and gate.

### HG-3: Gate actions can be unwinnable

Current examples include:

- `replan` at the replan limit immediately creating another replan-limit gate;
- blocked-cycle retry preserving the blocked-attempt count that caused the cap;
- failure-threshold retry preserving the same work-item failure count;
- fix-chain retry preserving the same fix depth;
- pipeline-head dead-letter `skip` closing only the gate while the original
  remains a completion blocker;
- `artifact_routing_admin -> acknowledge` closing without rechecking routing,
  changing task mode, or retrying work;
- inconsistent `skip` behavior between rewired and non-rewired dependents;
- generic custom choices requeueing an original regardless of the selected
  action's intended semantics.

### HG-4: Closed choices omit the changes required for retry

Recovery prompts ask for provider changes, narrower scope, larger budgets, or
specific instructions, while the TUI and bridge expose closed actions such as
`retry` and `skip`. A number key cannot carry the delta needed to make retry
meaningful.

### HG-5: Prose inference changes execution phase

Assessment disposition versus clarification is inferred from narrow question
regexes. An assessor question that does not match can become an untyped
clarification. Its resolver removes `_assess_only`, appends guidance, extends
attempts, and reruns the developer instead of resuming assessment.

### HG-6: Gate retirement can strand dependencies

Competing review gates are canceled without guaranteeing that dependencies
rewired to those gates are restored to the authoritative continuation.
Dead-letter recovery creation and replacement rewiring also use independent,
unchecked writes.

### HG-7: Prompt timeout and prompt switching are ambiguous

Timed-out prompts can later return to the interactive queue. Resolving one gate
can immediately display an older gate from another work item without a durable
transition message. This makes independent activity appear causal.

### HG-8: Partial-work recovery can turn a recoverable answer into failure

Partial-work `commit` performs stash/commit/status work after the human answer
has been recorded. If the stash is missing, the scoped commit fails, or a later
resolution step throws, the gate can fail and the parked original can be
failed. The answer cannot be replayed safely. `revert` also dead-letters the
original even when no successful descendant exists, without clearly presenting
that it abandons the work-item branch.

Partial-work actions need typed postconditions and idempotent outbox operations:

- `extend` resumes the same generation with an explicit turn/budget delta;
- `commit_for_assessment` preserves the stash until commit and assessment
  continuation are durable;
- `abandon` explicitly records work-item failure/waiver semantics;
- operational failure leaves the gate open and the stash recoverable.

### HG-9: General dead-letter recovery has no generation cap

Stall recovery has a bounded recovery count, but ordinary, research, and
one-shot dead-letter replacements can fail and create equivalent recovery gates
indefinitely. Recovery needs a generation and failure fingerprint. A retry with
no provider, scope, environment, budget, or instruction delta must not create
another replacement after the same failure recurs.

### AS-1: Assessment failures consume implementation attempts

After one penalty-free missing-terminal-handoff retry, the assessment pipeline
marks subsequent handoff failures as failed attempts and passes the original job
to generic `_retryOrFail`. The generic handler dead-letters at the implementation
attempt limit and spawns downstream recovery.

Missing `agent_handoff` is orchestration/protocol failure, not evidence that the
implementation failed.

### AS-2: Required handoff can become unavailable

The terminal report is required, but provider turn-budget handling can end with
no staged report and no successful terminal call. Repeating the same provider
contract does not repair this contradiction.

### AS-3: Assessment setup failures are swallowed

Registered-test rerun failures and assessor packet/handoff failures can be
caught and discarded, allowing assessment to continue with missing evidence or
a null/degraded packet. This creates false confidence problems and repeated
requests for tools the assessor does not actually have.

### ENV-1: Static tool issuance is mistaken for readiness

The assessor role is statically assigned scoped checks, tests, and Bash.
Runtime publication checks authorization flags, not whether the required
package manager, linter, compiler, test runtime, local binary, or project
entrypoint exists.

### ENV-2: Boot readiness is advisory

Boot dependency sync is background, dry-run, and non-blocking. Its test-tool
probe mainly confirms Node and optionally Python, not the actual verifier
adapters a job will use.

Heavy optional indexers may remain advisory, but lightweight job-critical
verifier readiness must gate dispatch.

### ENV-3: Canonical scoped checks resolve the wrong environment

The current runner:

- looks for ESLint only under its supplied current directory;
- falls back to hard-coded `npm run lint`;
- hard-codes npm for typecheck;
- does not consistently choose the nearest nested project root;
- can report `ok: true` when all requested checks were skipped;
- calls Python compilation “lint” even though it only checks syntax.

### ENV-4: Safe syntax commands are rejected

The Bash allowlist includes `node --test` but not `node --check`. Similar
read-only syntax checks are inconsistently allowed, rejected, or redirected.
These predictable policy failures waste assessment turns and can lower
confidence even though they are capability defects.

### ENV-5: Planner test commands are not compiled against readiness

A planner-provided `test_command` can be copied into a job without proving that
its launcher exists, that it runs from the selected project root, or that its
test/page entrypoint is wired. Agents may then invent package-manager commands
or repeatedly retry a recipe that cannot run. Test commands must be normalized
into the readiness manifest during plan compilation and rejected or repaired
before dispatch.

### SCOPE-1: Fixes are spawned before satisfiability is checked

Assessor fix instructions can require files outside the emitted fix scope.
Repeated fixes inherit the same narrow scope and same reason, guaranteeing the
same result.

### FILE-1: Creation is materialized too late and remains exposed

The current handoff attaches creatable-file metadata but does not create the
paths. Developer and fix roles later call `primeCreatableFiles`, after handoff
enrichment, then still pass `createFiles` to provider execution.

The path may exist before the provider call, but the provider contract still
models creation authority. The materialization and contract transformation must
be one handoff-layer operation.

## Target design

### 1. Typed human-gate contract registry

Replace producer-specific payload conventions and the monolithic resolver with
a registry such as:

```text
HumanGateContract {
  kind
  version
  allowed_source_states
  actions {
    name
    required_input_schema
    executable_when(state)
    resolve(transaction, state, input)
    postcondition(state)
  }
}
```

Persist at least:

- `gate_kind`
- `contract_version`
- `original_job_id`
- `generation`
- `gate_state` (`open`, `resolving`, `resolved`, `superseded`)
- `resolution_action`
- `resolution_payload`
- `resolution_idempotency_key`
- `resolved_at`

Add a uniqueness constraint for one open gate per
`original_job_id + gate_kind + generation`.

The registry inventory must include every current producer, including special
CLI/bridge routes:

| Gate family | Required typed continuation |
| --- | --- |
| Plan approval | approve the exact plan generation or cancel/revise it |
| Push offer | push the exact reviewed branch/ref or defer without changing job state |
| One-shot scope selection | select an exact candidate, route to planning, or cancel |
| Scope expansion | authorize/deny exact paths and resume the originating phase |
| Research/operator clarification | append structured guidance and resume the recorded phase |
| Partial work | extend, commit for assessment, or explicitly abandon |
| Developer blocked | retry with a blocker delta, replan, waive, pass, or fail |
| Assessment review/confidence | pass, fail, waive, replan, or assessment-only retry as allowed |
| Assessment transport/tooling | repair/recheck, change provider, assessment-only retry, or manual disposition |
| Replan/failure/fix/blocked limits | a generation-changing override or terminal disposition |
| Dead-letter recovery | replacement with structured delta or explicit bypass/failure |
| Artifact routing | deterministic recheck, mode change/replan, or fail |
| Work-item-level approval | atomically settle referenced originals, gates, verdicts, and dependency edges |

Work-item approval must not bypass per-gate invariants by merely canceling open
gates. It is a higher-level explicit transaction that applies authoritative
dispositions to every affected original and repairs every affected dependency.

Do not retain a generic fallback that requeues typed gates. Unknown contract
versions or actions remain open and route to an explicit administrative repair.

### 2. Transactional gate resolution

Implement one queue-domain `resolveHumanGate` operation:

1. Begin a transaction.
2. Compare-and-swap gate `open -> resolving` using lease token, generation, and
   expected original state/version.
3. Validate the action's current precondition.
4. Apply the original status/verdict/payload transition.
5. Create any replacement/replan job with an idempotency key.
6. Rewire all dependencies and verify the affected-row count.
7. Retire competing gates and redirect any edges that referenced them.
8. Persist the durable resolution record.
9. Mark the human attempt and gate resolved.
10. Commit.

Filesystem or Git work that cannot be transacted belongs in an idempotent
outbox. A gate remains `resolving` until the outbox succeeds or is returned to
`open` with a visible error.

`retryOrFail` must also compare-and-swap the active job/lease before logging
terminal state, writing artifacts, creating recovery, or rewiring dependencies.

### 3. Split overloaded recovery kinds

Replace `blocked_recovery` with typed causes:

- `developer_blocked`
- `assessor_evidence_unavailable`
- `blocked_cycle_exhausted`
- `failure_threshold_exhausted`
- `fix_chain_exhausted`
- `assessment_transport_unavailable`
- `assessment_retry_exhausted`
- `dead_letter_recovery`
- `artifact_routing_unavailable`
- `scope_expansion_required`

Each kind exposes only actions that alter its blocking condition.

#### Required action semantics

- `pass`: set original succeeded, set assessor verdict pass/high by explicit
  human authority, retire competing gates/recoveries, and route dependencies to
  the succeeded original or its authoritative bypass node.
- `fail`: terminally fail the original with explicit human provenance and
  deterministically settle dependents.
- `skip`: create an explicit waived/bypass outcome with consistent completion
  semantics. It must not merely close the gate.
- `retry_assessment`: preserve completed implementation, increase only the
  assessment budget, set assess-only continuation, and optionally change
  provider.
- `retry_with_changes`: require structured provider, scope, instruction, budget,
  or environment deltas. Do not offer it when no meaningful delta exists.
- `replan`: create a new plan generation. At the automatic replan limit it must
  either be an explicit one-time human override with a new generation or not be
  offered.
- `recheck`: execute deterministic readiness. Close only if the condition is
  repaired.

### 4. Prompt identity and structured interaction

Every human surface must show:

```text
WI #123
Original job #900
Gate #915
Chain: #...
Created: <UTC timestamp>
Waiting: <duration>
Cause: <typed gate kind>
```

After an answer:

```text
Resolved: WI #123 / original #900 / gate #915 -> PASS
Next prompt: WI #124 / original #911 / gate #917
Created: <UTC timestamp> (<age>)
```

Closed action selection and structured recovery input are separate steps. For
example, selecting `retry_with_changes` opens fields for provider, instructions,
scope request, and budget. Bridge and TUI use the same action schema.

Persist one audit event containing:

- gate/original/work-item ids;
- displayed choices and contract version;
- selected action and structured input;
- pre/post status and version;
- lease/generation;
- replacement ids and dependency rewires;
- deployed Posse commit/version;
- the next status writer, if any.

### 5. Separate assessment lifecycle

Introduce an assessment sub-state and budget independent of implementation
attempts:

```text
implementation_complete
  -> assessment_pending
  -> assessment_passed
  -> assessment_needs_human
  -> assessment_unavailable
```

Protocol/transport/environment failures transition only within assessment.
After bounded automatic recovery, park the completed implementation at
`assessment_unavailable` and expose typed actions. Never call generic
implementation `_retryOrFail`.

Reserve or provide a non-budgeted terminal control call for `agent_handoff`.
Before starting an assessor call, verify that the actual attached tool surface
contains the required terminal mechanism. A missing terminal mechanism is a
pre-call runtime-contract failure.

Stop swallowing registered-test, packet-build, handoff, and tool-attachment
errors. Classify them as:

- automatically repairable environment;
- provider/tool-surface mismatch;
- unavailable required evidence;
- invalid assessment contract.

### 6. Verification readiness manifest

Build a manifest per detected project/language root:

```text
VerificationCapability {
  root
  language
  kind: lint | syntax | typecheck | test
  launcher
  executable
  package_manager
  source: project | managed
  status: ready | repairable | unavailable | unsupported
  readiness_proof
  repair_action
}
```

Use one shared detector for dependency sync, planner validation,
`run_scoped_checks`, tests, and assessment.

For Node projects:

- resolve the nearest `package.json`;
- honor `packageManager`;
- choose lockfile manager deterministically;
- bootstrap pnpm/yarn through Corepack where appropriate;
- use project-local binaries or scripts;
- never substitute npm for a different declared manager.

For supported languages, provide a managed fallback syntax/lint adapter when
the project does not declare one. An unsupported language is explicit and
prevents the system from advertising a nonexistent verifier.

Compile every planner `test_command` into an exact root, launcher, argument
vector, and entrypoint. Do not dispatch the test job when the command cannot be
resolved. Do not let an assessor repair an invalid recipe by guessing a
different package-manager invocation.

Job-critical readiness gates dispatch. Heavy SCIP/indexer warming remains
background and must not freeze boot.

### 7. Canonical checks and safe syntax fallback

Change scoped checks to:

- resolve each file to its nearest project root;
- group checks by root/language/launcher;
- use local binaries and the resolved package manager;
- distinguish syntax from lint;
- return `unavailable` when nothing ran;
- include exact command, root, executable, and coverage in evidence.

Allow exact, read-only syntax command shapes where Bash is available:

- `node --check <scoped-file>` and `node -c <scoped-file>`
- `php -l <scoped-file>`
- `ruby -c <scoped-file>`
- `bash -n <scoped-file>` and `sh -n <scoped-file>`
- `shellcheck <scoped-file>`
- constrained `gcc`/`clang -fsyntax-only <scoped-file>`

Validate all operands against readable scope and prohibit evaluation flags,
plugins, output flags, loaders, arbitrary scripts, and shell expansion.

Python compilation can create `__pycache__`; implement Python syntax validation
inside the managed adapter with temporary output rather than blindly
allowlisting mutating `py_compile`.

A rejected safe command or missing executable is a policy/readiness defect. It
does not count as failed product evidence, reduce confidence, or consume a job
attempt.

### 8. Handoff-owned file materialization

#### Declaration boundary

Planner and assessor control outputs may declare exact `files_to_create`.
Writing agents may not.

The handoff layer must consume declarations before prompt composition, remote
composition, capability-token minting, or provider session creation.

#### Materialization algorithm

1. Normalize and deduplicate exact declared paths.
2. Reject traversal, worktree escapes, unsafe symlink parents, directories,
   sensitive files, broad roots, and invalid task-mode destinations.
3. Check ignore/tracking policy. A declared repo deliverable that cannot be
   committed must become a scope/plan error rather than a silent ignored file.
4. Validate every existing `files_to_modify` path exists.
5. Preflight all parent directories and creation operations.
6. Create missing parents and placeholders using exclusive creation.
7. Never truncate an existing path from a prior attempt.
8. On partial failure, remove only placeholders/directories created by this
   materialization generation.
9. Record private creation provenance and materialization generation.
10. Produce the writing execution scope:

```text
files_to_modify =
  existing files_to_modify + materialized declared creations

files_to_create = absent
createFiles = absent
```

11. Assert every writing-scope file exists.
12. Only then render prompts and start the writing agent.

#### Contract changes

- Remove `files_to_create` from dev, fix, ordinary artificer, and writing
  sub-agent input/output schemas.
- Remove `createFiles` from their provider options, deterministic MCP boot
  config, OAuth capability token, and remote tool surface.
- Do not place private creation provenance in `sessionPacket`, `_raw_payload`,
  prompt persistence summaries, or remote requests.
- Remove role-local `primeCreatableFiles` calls after centralization.
- Treat any writing-agent request to create a repo file as a scope request, not
  a write operation.
- Make missing modify paths a handoff invariant failure rather than granting
  fallback creation.
- Preserve original-new-file provenance for scoped commit, diff classification,
  expected-output validation, rollback, and audit.

Specialized artifact generation remains mediated by system-owned artifact tools.
It may use an approved output root, but the generic dev/fix write surface never
inherits arbitrary creation authority from that root.

### 9. Fix-scope satisfiability

Before enqueuing a fix:

1. Normalize assessor fix instructions and structured requested paths.
2. Determine required existing paths, exact new paths, runtime capabilities, and
   test entrypoints.
3. Compare them with proposed writable scope and readiness.
4. If a required path is missing:
   - route an exact creation declaration from the non-writing assessor through
     handoff materialization when policy permits; or
   - create `scope_expansion_required`; or
   - replan when the fix changes task architecture.
5. If a required tool or entrypoint is missing, repair/plan it before dispatch.
6. Compute a fingerprint from failure reason, required capability/path set,
   writable scope, and plan generation.
7. Refuse to spawn another fix when the fingerprint and scope are unchanged.

An assessor must not demand a new HTML entrypoint or `.htaccess` wiring and then
emit a fix restricted to unrelated JavaScript files.

## Implementation work packages

### P0-A: Incident visibility and containment

- Add gate identity, age, chain, and cross-WI transition messages to TUI,
  bridge snapshots, and remote clients.
- Add the full gate-resolution audit event.
- Add a reconciliation command/report for current orphaned or contradictory
  state.
- Stop classifying assessment protocol/environment failures as implementation
  failures before broader refactoring lands.

### P0-B: Assessment isolation

- Add separate assessment counters and states.
- Remove assessment failure calls to implementation `_retryOrFail`.
- Guarantee terminal-handoff availability or fail before provider invocation.
- Preserve completed implementation during assessment recovery.
- Make assessment errors explicit instead of swallowing them.

### P0-C: Handoff materialization and no-create writing contracts

- Centralize exact file materialization in handoff.
- Convert materialized paths to modify-only execution scope.
- Remove creation fields/capabilities from writing role contracts and remote
  surfaces.
- Preserve private creation provenance.
- Delete redundant role-local priming.
- Add pre/post write-scope enforcement.

### P0-D: Fix satisfiability and loop breaker

- Validate fix paths/capabilities before enqueue.
- Add typed scope expansion.
- Add unchanged-fingerprint rejection.
- Stop active chains from producing another identical fix generation.

### P0-E: Transactional human-gate resolution

- Add versioned gate contracts and schema fields.
- Implement compare-and-swap transactional resolution.
- Make pass authoritative.
- Make retries idempotent and delta-bearing.
- Repair dependency rewiring and competing-gate retirement.
- Remove generic typed-gate fallback behavior.

### P1-A: Verifier readiness

- Add the readiness manifest and shared root/manager detector.
- Gate job-critical dispatch on lightweight verifier readiness.
- Add deterministic repair for supported toolchains.
- Fix nested roots, manager selection, and all-skipped semantics.
- Feed a resolved evidence pack to assessment.

### P1-B: Syntax policy

- Add exact safe syntax command forms and argument validation.
- Reconcile prompt guidance with policy.
- Prevent policy/readiness errors from becoming assessment evidence.

### P1-C: Gate-kind migration

- Split overloaded recovery types.
- Add structured retry inputs across TUI, bridge, and remote clients.
- Replace `acknowledge`-only administrative gates with deterministic `recheck`
  flows.
- Add recovery generation/fingerprint caps for general, research, and one-shot
  dead-letter recovery.

### P2: Legacy-state migration and invariant watchdog

- Migrate open legacy gates to typed contracts where unambiguous.
- Materialize queued legacy creation declarations at dispatch.
- Reconcile parked originals without gates, multiple active gates, edges to
  canceled gates, terminal originals with open gates, and human gates that
  dead-lettered while originals remained parked.
- Run periodic invariant checks and emit actionable administrative events.

## Expected implementation touchpoints

Human gates and queue:

- `lib/catalog/human-input.js`
- `lib/domains/worker/functions/execution/human-input-job.js`
- `lib/domains/worker/functions/helpers/dead-letter.js`
- `lib/domains/worker/functions/helpers/verdicts/*.js`
- `lib/domains/queue/functions/index.js`
- queue schema and migrations under `lib/shared/storage/`

Assessment:

- `lib/domains/worker/functions/helpers/assessment-pipeline.js`
- `lib/domains/worker/classes/execution/AssessmentHandoffAdapter.js`
- assessor role and terminal-handoff adapters
- authenticated assessor contract in `posse-remote`

Handoff and write scope:

- `lib/domains/handoff/functions/index.js`
- `lib/domains/handoff/functions/helpers/file-attach.js`
- `lib/domains/handoff/functions/helpers/scope-preflight.js`
- `lib/domains/handoff/functions/agent-handoff.js`
- `lib/domains/worker/classes/roles/developer.js`
- `lib/domains/worker/classes/roles/fix.js`
- `lib/domains/worker/functions/helpers/worktree-lifecycle.js`
- `lib/shared/scope/classes/MutationPolicy.js`
- deterministic MCP authority/token/remote-surface modules

Environment and tools:

- `lib/domains/system/functions/dependency-sync.js`
- `lib/shared/tools/functions/toolkit/scoped-runners.js`
- `lib/shared/tools/functions/toolkit/bash-executor.js`
- `lib/domains/integrations/functions/deterministic-mcp-server.js`
- `lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js`
- provider prompt/tool-surface composers

Human surfaces:

- `lib/domains/ui/classes/display/input-controller.js`
- CLI review/session rendering
- `lib/domains/bridge/functions/human-input-answer.js`
- bridge state snapshot and command dispatch
- remote control clients governed by `docs/control-protocol.md`

## Test plan

### Human-gate state machine

- Generate a test for every registered gate kind/action pair.
- Verify every displayed action has an executable resolver and postcondition.
- Property-test all allowed source states and concurrent terminal transitions.
- Prove one active gate per original/kind/generation.
- Prove no dependency points to a canceled/superseded gate.
- Prove an original cannot be parked without a resolvable open gate.
- Prove a stale lease produces zero mutations.
- Inject a crash after each resolution step and prove idempotent replay.
- Race human pass against retry/dead-letter and prove current-generation pass
  wins.
- Prove resolver/UI/bridge failure leaves the original recoverable.

### Dead-route regressions

- Replan at limit cannot create an identical limit gate.
- Blocked-cycle retry cannot immediately recreate the same gate without a
  changed blocker/generation.
- Failure-threshold and fix-depth retry cannot preserve the triggering counter
  unchanged.
- Pipeline-head research, one-shot, and stall skip reach a defined work-item
  outcome.
- Artifact-routing recheck keeps the gate open while broken and resumes only
  after readiness passes.
- Assessment transport retry extends assessment budget only.
- Unknown/custom typed choices cannot generically requeue an original.
- Skip has identical semantics across gate kinds.
- Partial-work commit failure leaves the gate and stash recoverable.
- Partial-work abandon has explicit work-item terminal semantics.
- An unchanged dead-letter failure fingerprint cannot create unlimited recovery
  generations.

### Assessment lifecycle

- Missing terminal handoff never changes implementation status to failed or
  dead letter.
- Repeated assessment transport/provider/tool failures exhaust only assessment
  budget.
- Required terminal handoff remains callable after normal tool-turn exhaustion.
- Tool-surface mismatch prevents the assessor call.
- Packet-build and registered-test errors are visible and classified.
- Medium-confidence pass can enter human review without rerunning development.
- Human pass from that review settles the original and dependents.

### Prompt identity

- Two concurrent work items with old timed-out prompts resolve in FIFO/priority
  order while always showing WI/original/gate identity.
- Resolving one prompt emits an explicit `Resolved` record before rendering the
  next prompt.
- The next prompt's creation time and age are displayed.

### Verifier readiness

- Nested npm, pnpm, and yarn projects resolve the nearest package root.
- Corepack repair makes declared pnpm/yarn launchers ready.
- No npm fallback occurs for a different declared manager.
- Missing linter is repaired or reported unavailable before dispatch.
- All-skipped checks return unavailable.
- Syntax and lint are reported separately.
- Readiness manifest equals the actually published MCP tool surface.
- Planner test commands resolve to an existing root, launcher, and entrypoint
  before dispatch.
- Invalid test commands cannot be replaced by an assessor-invented package
  manager invocation.

### Safe syntax commands

- Accept exact scoped `node --check`, PHP, Ruby, shell, ShellCheck, and
  constrained C/C++ syntax forms.
- Reject evaluation, plugin, loader, output, traversal, shell-expansion, and
  out-of-scope variants.
- Python syntax validation creates no workspace cache/artifact.
- Policy rejection never becomes a product-failure verdict.

### Handoff materialization

- Planner-declared and assessor-declared exact creations are materialized before
  writing prompt composition.
- Writing role prompts, session packets, provider options, OAuth tokens, and
  tool schemas contain no `files_to_create`/`createFiles`.
- Materialized paths appear only as modify scope and exist before provider
  invocation.
- Existing paths are never truncated on retry.
- Partial materialization rolls back only paths created by that generation.
- Missing modify paths fail handoff before provider invocation.
- Symlink/traversal/sensitive/ignored invalid paths fail closed.
- Git and assessment still identify materialized files as new relative to the
  target branch.
- Dev/fix cannot create an undeclared file through deterministic tools, provider
  native tools, shell, or a missing modify path.
- Out-of-scope untracked files cannot be committed.

### Fix satisfiability

- A fix requiring an HTML entrypoint cannot launch with JS-only scope.
- An approved exact new path is materialized and handed to the fix as modify.
- A denied expansion replans or terminates explicitly.
- Repeated identical reason+scope fingerprints cannot spawn another fix.
- Test jobs requiring page/entrypoint wiring validate it before dispatch.

## Rollout and migration

1. Add observability and assessment dead-letter containment first.
2. Add new schema/state fields in backward-compatible form.
3. Implement materialization and provider-contract stripping behind an
   invariant-reporting feature flag.
4. Run contract parity tests against `posse-remote`.
5. Enable materialization for new jobs, then queued legacy jobs.
6. Enable transactional gate resolution for new typed gates.
7. Migrate open gates and reconcile dependency edges.
8. Enable verifier dispatch gating after readiness repair is available.
9. Remove legacy generic resolvers and creation grants only after telemetry
   shows no callers.

CI and deployment include only committed work. Source and clean-client mirrors
must be tested and published through the repository's documented deployment
pipeline.

## Completion criteria

The remediation is not complete until all of the following are demonstrated in
an end-to-end concurrent run:

- A medium-confidence pass creates one clearly identified human review.
- Selecting pass resolves that exact original once.
- The next prompt visibly identifies a different WI when applicable.
- Missing terminal handoff cannot dead-letter completed work.
- Missing verifier/tooling is repaired or reported before assessment.
- The assessor does not waste turns on policy-rejected safe syntax commands.
- A fix that needs an out-of-scope file requests/receives valid scope before
  dispatch and cannot repeat unchanged.
- Planner/assessor creation declarations are materialized by handoff.
- No writing-agent contract contains creation scope.
- No human action can close successfully without reaching its documented
  terminal or continuation state.
