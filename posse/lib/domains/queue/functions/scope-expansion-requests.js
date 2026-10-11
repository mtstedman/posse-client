import { SETTING_KEYS } from "../../../catalog/settings.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { classifyAutoApprovableScopeRequest } from "../../../shared/policies/functions/scope-auto-approval.js";
import {
  dependentSiblingScopeApproval,
  LIVE_SCOPE_WAIT_TIMEOUT_MS,
  scopeRequestBatchEntries,
} from "./scope-expansion.js";

// Queue-store owns the transaction and status transitions. It supplies those
// operations to this scope state machine so gate cancellation and attempt-start
// hooks can call back into it without a static module cycle.
export function createScopeExpansionOperations({
  createJob,
  decrementAttemptCount,
  forceUpdateJobStatus,
  getAllDependencies,
  getJob,
  getQueueWakeGeneration,
  getSetting,
  listJobsByWorkItem,
  logEvent,
  now,
  runInTransaction,
  setJobError,
  updateJobPayload,
  updateJobStatus,
  waitForQueueStateChangeAfter,
  terminalJobStatuses,
}) {
  const TERMINAL_JOB_STATUS_SET = terminalJobStatuses;

  const SCOPE_REQUEST_REVIEW_TYPE = "scope_expansion_request";

  function normalizeRequestedScopePath(value) {
    const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
    const parts = [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") return null;
      parts.push(part);
    }
    return parts.length > 0 ? parts.join("/") : null;
  }

  function parseJobPayloadObject(job) {
    try {
      const parsed = JSON.parse(job?.payload_json || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function jobPayloadAlreadyAuthorizesScopePath(payload, requestedPath, requestedAccess) {
    const requested = normalizeRequestedScopePath(requestedPath);
    if (!requested) return false;
    const createPaths = Array.isArray(payload?.files_to_create) ? payload.files_to_create : [];
    const authorizedPaths = requestedAccess === "create"
      ? createPaths
      : [
          ...(Array.isArray(payload?.files_to_modify) ? payload.files_to_modify : []),
          ...createPaths,
        ];
    return authorizedPaths.some((value) => normalizeRequestedScopePath(value) === requested);
  }

  function scopeGateQuestionText(job, request) {
    const entries = scopeRequestBatchEntries(request);
    const approvalAction = request?.live_wait === true
      ? "continue the active agent session"
      : "retry the job";
    const denialAction = request?.live_wait === true
      ? "return an out-of-scope error to the agent"
      : "fail it with an out-of-scope error";
    return [
      `Job #${job.id} (${job.title}) attempted to write outside its writable scope:`,
      ...entries.map((entry) => `  ${entry.path} (${entry.access})${entry.reason ? ` — ${entry.reason}` : ""}`),
      entries.length === 1
        ? `Approve to add this exact path to ${entries[0].access === "modify" ? "files_to_modify" : "files_to_create"} and ${approvalAction}, or deny to ${denialAction}.`
        : `Approve to add these ${entries.length} exact paths to the job's writable scope and ${approvalAction}, or deny to ${denialAction}.`,
      `Reply with "approve" or "deny".`,
    ].join("\n");
  }

  function scopeRequestDeniedError(request = {}) {
    const entries = scopeRequestBatchEntries(request);
    if (entries.length === 1) {
      const [entry] = entries;
      return `Out-of-scope ${entry.operation || request.operation || "write"} denied for ${entry.path}.`;
    }
    const paths = entries.map((entry) => entry.path);
    return `Out-of-scope writes denied for ${paths.join(", ") || "the requested paths"}.`;
  }

  function scopeRequestResult({ request, humanJobId = null, reused = false } = {}) {
    const batchSize = scopeRequestBatchEntries(request || {}).length;
    return {
      ok: false,
      code: "scope_approval_pending",
      paused: request?.live_wait !== true,
      waiting: true,
      request_id: request?.id || null,
      approval_job_id: humanJobId,
      path: request?.path || null,
      access: request?.access || null,
      operation: request?.operation || null,
      live: request?.live_wait === true,
      reused,
      message: request?.live_wait === true
        ? `The current file operation is waiting for a human to approve or deny writable scope for ${request?.path || "the requested path"}${batchSize > 1 ? ` (+${batchSize - 1} batched path(s))` : ""}; the active agent session will continue after the decision.`
        : `The current job is paused until a human approves or denies writable scope for ${request?.path || "the requested path"}${batchSize > 1 ? ` (+${batchSize - 1} batched path(s))` : ""}.`,
    };
  }

  /**
   * Persist one exact-path scope expansion. Legacy callers park the active job;
   * live-wait callers leave its lease and provider session active while the
   * internal request_scope tool waits for a human decision.
   *
   * `ignoredByRepository` ({ source }) marks a path the caller found untracked
   * and excluded by the repository's ignore rules (`git check-ignore`). Git
   * never commits such a path, so the request is answered without a gate and
   * without widening scope.
   */
  function requestJobScopeExpansion({
    jobId,
    workItemId = null,
    attemptId = null,
    agentCallId = null,
    path,
    access,
    operation,
    reason = "",
    source = "internal_tool",
    liveWait = false,
    ignoredByRepository = null,
  } = {}) {
    const normalizedJobId = Number(jobId);
    const normalizedPath = normalizeRequestedScopePath(path);
    const normalizedAccess = String(access || "").trim().toLowerCase();
    const normalizedOperation = String(operation || "").trim().toLowerCase();
    if (!Number.isInteger(normalizedJobId) || normalizedJobId <= 0) {
      return { ok: false, code: "scope_request_unavailable", paused: false, message: "No active job context is available for a scope request." };
    }
    if (!normalizedPath) {
      return { ok: false, code: "invalid_scope_path", paused: false, message: "Scope requests require one repository-relative file path." };
    }
    if (!new Set(["modify", "create"]).has(normalizedAccess)) {
      return { ok: false, code: "invalid_scope_access", paused: false, message: "Scope request access must be modify or create." };
    }
    if (!new Set(["write_file", "edit_file"]).has(normalizedOperation)) {
      return { ok: false, code: "invalid_scope_operation", paused: false, message: "Scope request operation must be write_file or edit_file." };
    }

    return runInTransaction(() => {
      const current = getJob(normalizedJobId);
      if (!current) {
        return { ok: false, code: "scope_request_job_missing", paused: false, message: `Job #${normalizedJobId} no longer exists.` };
      }
      if (workItemId != null && Number(workItemId) !== Number(current.work_item_id)) {
        return { ok: false, code: "scope_request_context_mismatch", paused: false, message: "The scope request does not belong to the active work item." };
      }
      const payload = parseJobPayloadObject(current);
      const pending = payload._pending_scope_request && typeof payload._pending_scope_request === "object"
        ? payload._pending_scope_request
        : null;
      // The durable job payload is the authority. A reconnected MCP process or
      // an overlapping embedded runtime can retain stale local predicates after
      // a prior approval and ask again for the same exact path. Return a grant
      // receipt so the caller refreshes its local predicate instead of creating
      // a duplicate human gate for authority the job already owns.
      if (jobPayloadAlreadyAuthorizesScopePath(payload, normalizedPath, normalizedAccess)) {
        return {
          ok: true,
          code: "scope_already_authorized",
          paused: false,
          approved: true,
          path: normalizedPath,
          access: normalizedAccess,
          operation: normalizedOperation,
          reason: "durable_job_scope",
          message: `Writable scope is already authorized for ${normalizedPath}. Retry the ${normalizedOperation} now.`,
        };
      }
      if (pending) {
        const pendingEntries = scopeRequestBatchEntries(pending);
        if (pendingEntries.some((entry) =>
          entry.path === normalizedPath
          && entry.access === normalizedAccess
          && entry.operation === normalizedOperation)) {
          return scopeRequestResult({ request: pending, humanJobId: pending.approval_job_id || null, reused: true });
        }
      }
      if (!pending && current.status !== "running") {
        return {
          ok: false,
          code: "scope_request_job_inactive",
          paused: false,
          message: `Job #${normalizedJobId} cannot request scope while its status is ${current.status}.`,
        };
      }

      // An untracked path the repository ignores can never be committed (scoped
      // commit staging skips it), so neither a gate nor a grant can make an edit
      // to it part of the change. Answer here, before auto-approval or batching
      // onto an open gate, and leave the payload scope untouched.
      if (ignoredByRepository) {
        const ignoreSource = String(ignoredByRepository.source || "").trim() || null;
        logEvent({
          work_item_id: current.work_item_id,
          job_id: current.id,
          attempt_id: Number(attemptId) || null,
          event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_IGNORED_PATH,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Declined ${normalizedAccess} scope without a gate: ${normalizedPath} is ignored by repository policy${ignoreSource ? ` (${ignoreSource})` : ""}`,
          event_json: JSON.stringify({
            path: normalizedPath,
            access: normalizedAccess,
            operation: normalizedOperation,
            ignore_source: ignoreSource,
            reason: String(reason || "").trim(),
            source: String(source || "internal_tool").slice(0, 80),
          }),
        });
        return {
          ok: false,
          code: "scope_path_ignored",
          paused: false,
          approved: false,
          path: normalizedPath,
          access: normalizedAccess,
          operation: normalizedOperation,
          ignore_source: ignoreSource,
          message: `${normalizedPath} is ignored by repository policy${ignoreSource ? ` (${ignoreSource})` : ""}: edits to it are never committed, so scope was not widened. If it is generated, the project's build or generator regenerates it from tracked sources; change those sources instead of this file.`,
        };
      }

      // Mechanical path classes are granted without a human gate: the payload
      // scope is widened durably here, and the caller's live predicates are
      // widened by the tool handler so the retried write succeeds within the
      // same attempt instead of costing a pause → gate → re-run cycle.
      let autoApprovalEnabled = true;
      try {
        autoApprovalEnabled = String(getSetting(SETTING_KEYS.SCOPE_AUTO_APPROVAL) ?? "true") !== "false";
      } catch { /* default on */ }
      const autoClass = autoApprovalEnabled
        ? dependentSiblingScopeApproval(current, normalizedPath, normalizedAccess,
          listJobsByWorkItem(current.work_item_id), getAllDependencies()) || classifyAutoApprovableScopeRequest({
          path: normalizedPath,
          jobType: current.job_type,
          createRoots: payload.create_roots,
        })
        : null;
      if (autoClass) {
        const field = normalizedAccess === "modify" ? "files_to_modify" : "files_to_create";
        const nextPayload = { ...payload };
        nextPayload[field] = [...new Set([
          ...(Array.isArray(nextPayload[field]) ? nextPayload[field] : []),
          normalizedPath,
        ])];
        nextPayload._scope_auto_approvals = [
          ...(Array.isArray(nextPayload._scope_auto_approvals) ? nextPayload._scope_auto_approvals : []),
          {
            path: normalizedPath,
            access: normalizedAccess,
            operation: normalizedOperation,
            reason: autoClass.reason,
            ...(autoClass.sibling_job_ids ? { sibling_job_ids: autoClass.sibling_job_ids } : {}),
            approved_at: now(),
          },
        ].slice(-20);
        updateJobPayload(current.id, JSON.stringify(nextPayload));
        logEvent({
          work_item_id: current.work_item_id,
          job_id: current.id,
          attempt_id: Number(attemptId) || null,
          event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_APPROVED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Auto-approved ${normalizedAccess} scope (${autoClass.reason}): ${normalizedPath}`,
          event_json: JSON.stringify({
            path: normalizedPath,
            access: normalizedAccess,
            operation: normalizedOperation,
            auto: true,
            reason: autoClass.reason,
            ...(autoClass.sibling_job_ids ? { sibling_job_ids: autoClass.sibling_job_ids } : {}),
          }),
        });
        return {
          ok: true,
          code: "scope_auto_approved",
          paused: false,
          approved: true,
          auto: true,
          path: normalizedPath,
          access: normalizedAccess,
          operation: normalizedOperation,
          reason: autoClass.reason,
          message: `Scope auto-approved (${autoClass.reason}) for ${normalizedPath}. Retry the ${normalizedOperation} now.`,
        };
      }

      if (pending) {
        // A recorded decision freezes the request contents. The gate job can
        // still be parked open while the answer is being applied, so gateOpen
        // alone is not sufficient: appending a new path onto a decided request
        // would let the consuming waiter grant a path the human never saw.
        // Mirror abandonJobScopeExpansionRequest's scope_request_decided guard.
        if (pending.decision) {
          return {
            ok: false,
            approved: false,
            code: "scope_request_decided",
            paused: false,
            live: pending.live_wait === true,
            waiting: false,
            request_id: pending.id || null,
            path: pending.path || null,
            message: `Job #${normalizedJobId} has a prior scope request that was already ${pending.decision}; that decision is still being applied. Retry this ${normalizedOperation} shortly to open a fresh request.`,
          };
        }
        // Batch a further out-of-scope path onto the open gate instead of
        // bouncing it: the paused provider call can surface several missing
        // paths while it unwinds, and each bounced path would cost another
        // full pause → gate → answer → re-run cycle on the next attempt.
        const gateJob = pending.approval_job_id ? getJob(pending.approval_job_id) : null;
        const gateOpen = !!gateJob
          && gateJob.job_type === "human_input"
          && ["queued", "waiting_on_human"].includes(gateJob.status);
        if (!gateOpen) {
          return {
            ok: false,
            code: "scope_approval_already_pending",
            paused: pending.live_wait !== true,
            live: pending.live_wait === true,
            waiting: false,
            request_id: pending.id || null,
            path: pending.path || null,
            message: pending.live_wait === true
              ? `Job #${normalizedJobId} has a prior live scope request for ${pending.path || "another path"}, but its approval gate is no longer open. The active operation cannot wait on that gate and should return before retrying.`
              : `Job #${normalizedJobId} is already paused for a scope decision on ${pending.path || "another path"}.`,
          };
        }
        const entry = {
          path: normalizedPath,
          access: normalizedAccess,
          operation: normalizedOperation,
          reason: String(reason || "").trim(),
        };
        const batch = [...scopeRequestBatchEntries(pending), entry];
        const updatedPending = { ...pending, batch };
        updateJobPayload(current.id, JSON.stringify({
          ...payload,
          _pending_scope_request: updatedPending,
        }));
        const gatePayload = parseJobPayloadObject(gateJob);
        updateJobPayload(gateJob.id, JSON.stringify({
          ...gatePayload,
          scope_request: updatedPending,
          questions: [scopeGateQuestionText(current, updatedPending)],
        }));
        logEvent({
          work_item_id: current.work_item_id,
          job_id: current.id,
          attempt_id: Number(attemptId) || null,
          event_type: EVENT_TYPES.JOB_SCOPE_REQUESTED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Added ${normalizedAccess} scope request to pending approval batch: ${normalizedPath}`,
          event_json: JSON.stringify({ request: updatedPending, approval_job_id: gateJob.id, appended: entry }),
        });
        return {
          ok: false,
          code: "scope_approval_batched",
          paused: pending.live_wait !== true,
          live: pending.live_wait === true,
          waiting: true,
          request_id: pending.id || null,
          approval_job_id: gateJob.id,
          path: normalizedPath,
          access: normalizedAccess,
          operation: normalizedOperation,
          batched_paths: batch.map((batched) => batched.path),
          message: `Added ${normalizedPath} to the pending scope approval batch (${batch.length} paths). One human decision covers the whole batch.`,
        };
      }

      const requestId = `job-${normalizedJobId}-scope-${Date.now()}`;
      const request = {
        id: requestId,
        path: normalizedPath,
        access: normalizedAccess,
        operation: normalizedOperation,
        reason: String(reason || "").trim(),
        source: String(source || "internal_tool").slice(0, 80),
        requested_at: now(),
        attempt_id: Number(attemptId) || null,
        agent_call_id: Number(agentCallId) || null,
        live_wait: liveWait === true,
      };
      request.batch = [{
        path: normalizedPath,
        access: normalizedAccess,
        operation: normalizedOperation,
        reason: request.reason,
      }];
      const humanJob = createJob({
        work_item_id: current.work_item_id,
        job_type: "human_input",
        title: `Approve scope: ${normalizedPath}`.slice(0, 180),
        parent_job_id: current.id,
        priority: "high",
        model_tier: "cheap",
        payload_json: JSON.stringify({
          original_job_id: current.id,
          review_type: SCOPE_REQUEST_REVIEW_TYPE,
          scope_request: request,
          questions: [scopeGateQuestionText(current, request)],
          context: `The request was surfaced automatically by the internal request_scope tool after ${normalizedOperation} hit the job's scope boundary.`,
        }),
      });
      request.approval_job_id = humanJob.id;
      updateJobPayload(current.id, JSON.stringify({
        ...payload,
        _pending_scope_request: request,
      }));
      if (request.live_wait !== true) {
        const parked = updateJobStatus(current.id, "waiting_on_human", {
          expectedStatuses: ["running"],
          force: true,
        });
        if (parked) {
          decrementAttemptCount(current.id);
        }
      }
      logEvent({
        work_item_id: current.work_item_id,
        job_id: current.id,
        attempt_id: Number(attemptId) || null,
        event_type: EVENT_TYPES.JOB_SCOPE_REQUESTED,
        actor_type: EVENT_ACTORS.WORKER,
        message: request.live_wait === true
          ? `Waiting in the active agent session for ${normalizedAccess} scope approval: ${normalizedPath}`
          : `Paused for ${normalizedAccess} scope approval: ${normalizedPath}`,
        event_json: JSON.stringify({ request, approval_job_id: humanJob.id, live_wait: request.live_wait === true }),
      });
      return scopeRequestResult({ request, humanJobId: humanJob.id });
    });
  }

  function abandonJobScopeExpansionRequest({
    jobId,
    requestId = null,
    attemptId = null,
    code = "scope_wait_aborted",
    message = "The active scope wait was abandoned.",
    cancelGate = true,
    // force: abandon even when the pending request belongs to a different
    // attempt. Attempt-end cleanup must use this — its attempt is dead, and
    // an early bounce here would leave an open gate asking about a dead
    // attempt while the stale pending keeps watchdog/stall exemptions alive.
    // The decided guard below still applies: a recorded decision is never
    // silently discarded.
    force = false,
  } = {}) {
    return runInTransaction(() => {
      const original = getJob(Number(jobId));
      if (!original) return { ok: false, code: "scope_request_job_missing" };
      const payload = parseJobPayloadObject(original);
      const pending = payload._pending_scope_request;
      if (!pending || (requestId && pending.id !== String(requestId))) {
        return { ok: false, code: "scope_request_stale", job: original };
      }
      if (!force && attemptId && pending.attempt_id && Number(pending.attempt_id) !== Number(attemptId)) {
        return { ok: false, code: "scope_request_attempt_mismatch", job: original, request: pending };
      }
      if (pending.decision) {
        return { ok: false, code: "scope_request_decided", job: original, request: pending };
      }

      const abandoned = {
        ...pending,
        abandoned: true,
        abandoned_at: now(),
        abandon_code: String(code || "scope_wait_aborted"),
        abandon_message: String(message || "The active scope wait was abandoned.").slice(0, 500),
      };
      const nextPayload = {
        ...payload,
        _scope_request_abandonments: [
          ...(Array.isArray(payload._scope_request_abandonments) ? payload._scope_request_abandonments : []),
          abandoned,
        ].slice(-20),
      };
      delete nextPayload._pending_scope_request;
      updateJobPayload(original.id, JSON.stringify(nextPayload));

      const gate = pending.approval_job_id ? getJob(pending.approval_job_id) : null;
      if (cancelGate && gate && !TERMINAL_JOB_STATUS_SET.has(gate.status)) {
        forceUpdateJobStatus(gate.id, "canceled", { expectedStatuses: [gate.status] });
      }
      logEvent({
        work_item_id: original.work_item_id,
        job_id: original.id,
        event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_ABANDONED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: abandoned.abandon_message,
        event_json: JSON.stringify({
          request_id: pending.id || null,
          approval_job_id: pending.approval_job_id || null,
          code: abandoned.abandon_code,
        }),
      });
      return {
        ok: true,
        code: abandoned.abandon_code,
        job: getJob(original.id),
        request: abandoned,
      };
    });
  }

  function abandonScopeRequestForCanceledGate(gateJob) {
    const gatePayload = parseJobPayloadObject(gateJob);
    if (gatePayload.review_type !== SCOPE_REQUEST_REVIEW_TYPE) return false;
    const result = abandonJobScopeExpansionRequest({
      jobId: gatePayload.original_job_id,
      requestId: gatePayload.scope_request?.id || null,
      code: "scope_gate_canceled",
      message: `Scope approval gate #${gateJob.id} was canceled; the pending live scope request was abandoned.`,
      cancelGate: false,
    });
    return result.ok === true;
  }

  /** Resolve a human answer for a request created by requestJobScopeExpansion. */
  function resolveJobScopeExpansion({ approvalJobId, approved, answer = "", actorType = EVENT_ACTORS.HUMAN } = {}) {
    const humanJob = getJob(Number(approvalJobId));
    const humanPayload = parseJobPayloadObject(humanJob);
    if (!humanJob || humanPayload.review_type !== SCOPE_REQUEST_REVIEW_TYPE) {
      return { ok: false, code: "scope_request_gate_missing" };
    }
    return runInTransaction(() => {
      const original = getJob(Number(humanPayload.original_job_id));
      if (!original) return { ok: false, code: "scope_request_job_missing" };
      const payload = parseJobPayloadObject(original);
      const pending = payload._pending_scope_request;
      const request = humanPayload.scope_request;
      if (!request || !pending || request.id !== pending.id) {
        return { ok: false, code: "scope_request_stale", job: original, request: request || null };
      }

      const nextPayload = { ...payload };
      const decision = approved === true ? "approved" : "rejected";
      nextPayload._pending_scope_request = {
        ...pending,
        decision,
        decided_at: now(),
        answer: String(answer || "").slice(0, 300),
      };
      if (approved === true) {
        // The pending request from the original job is authoritative for the
        // batch contents: appends update it in the same transaction as the
        // gate payload, and it reflects every path the answer covers.
        const entries = scopeRequestBatchEntries(pending);
        for (const entry of entries) {
          const field = entry.access === "modify" ? "files_to_modify" : "files_to_create";
          nextPayload[field] = [...new Set([
            ...(Array.isArray(nextPayload[field]) ? nextPayload[field] : []),
            entry.path,
          ])];
        }
        const liveActive = pending.live_wait === true && original.status === "running";
        const executionSettled = pending.execution_settled === true || (pending.live_wait === true && !liveActive);
        if (executionSettled) delete nextPayload._pending_scope_request;
        updateJobPayload(original.id, JSON.stringify(nextPayload));
        let requeued = false;
        if (executionSettled && original.status === "waiting_on_human") {
          requeued = updateJobStatus(original.id, "queued", { expectedStatuses: ["waiting_on_human"], force: true });
        } else if (
          executionSettled
          && original.status === "failed"
          && Number(original.attempt_count || 0) < Math.max(1, Number(original.max_attempts || 3))
        ) {
          requeued = updateJobStatus(original.id, "queued", { expectedStatuses: ["failed"], force: true });
          if (requeued) setJobError(original.id, null);
        }
        logEvent({
          work_item_id: original.work_item_id,
          job_id: original.id,
          event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_APPROVED,
          actor_type: actorType,
          message: `Approved scope for ${entries.map((entry) => entry.path).join(", ")}`,
          event_json: JSON.stringify({ request, approval_job_id: humanJob.id, answer: String(answer || "").slice(0, 300) }),
        });
        return {
          ok: true,
          approved: true,
          live: liveActive,
          requeued,
          remains_failed: original.status === "failed" && !requeued,
          job: getJob(original.id),
          request: pending,
        };
      }

      nextPayload._scope_request_denials = [
        ...(Array.isArray(nextPayload._scope_request_denials) ? nextPayload._scope_request_denials : []),
        { ...pending, denied_at: now(), answer: String(answer || "").slice(0, 300) },
      ].slice(-20);
      const error = scopeRequestDeniedError(pending);
      const liveActive = pending.live_wait === true && original.status === "running";
      const executionSettled = pending.execution_settled === true || (pending.live_wait === true && !liveActive);
      if (executionSettled) delete nextPayload._pending_scope_request;
      updateJobPayload(original.id, JSON.stringify(nextPayload));
      let finalized = false;
      if (executionSettled && original.status === "waiting_on_human") {
        setJobError(original.id, error);
        finalized = updateJobStatus(original.id, "failed", {
          expectedStatuses: ["waiting_on_human"],
          force: true,
        });
      }
      logEvent({
        work_item_id: original.work_item_id,
        job_id: original.id,
        event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_REJECTED,
        actor_type: actorType,
        message: error,
        event_json: JSON.stringify({ request, approval_job_id: humanJob.id, answer: String(answer || "").slice(0, 300) }),
      });
      return {
        ok: true,
        approved: false,
        live: liveActive,
        finalized,
        settled: executionSettled,
        job: getJob(original.id),
        request: pending,
        error,
      };
    });
  }

  /**
   * Wait for a human decision without ending the provider call, then consume the
   * decision atomically. Polling is intentional: deterministic MCP runs in a
   * child process, so in-memory queue wake listeners cannot observe the answer.
   */
  async function awaitJobScopeExpansionDecision({
    jobId,
    requestId,
    attemptId = null,
    signal = null,
    pollMs = 200,
    timeoutMs = LIVE_SCOPE_WAIT_TIMEOUT_MS,
    useQueueWake = true,
  } = {}) {
    const normalizedJobId = Number(jobId);
    const normalizedRequestId = String(requestId || "");
    const delayMs = Math.max(25, Math.min(2000, Number(pollMs) || 200));
    const deadline = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Date.now() + Number(timeoutMs)
      : null;
    const stopResult = (code, message) => ({
      ok: false,
      approved: false,
      live: true,
      paused: false,
      code,
      message,
    });

    const abandon = (code, message) => {
      const result = abandonJobScopeExpansionRequest({
        jobId: normalizedJobId,
        requestId: normalizedRequestId,
        attemptId,
        code,
        message,
      });
      if (result?.code === "scope_request_decided") return null;
      return stopResult(code, message);
    };

    while (true) {
      // Capture the wake generation before the read so an approval racing this
      // probe is observed by waitForQueueStateChangeAfter instead of sleeping
      // past it. The probe itself is deliberately read-only: no BEGIN IMMEDIATE
      // lock is taken on undecided polling iterations.
      const wakeGeneration = useQueueWake ? getQueueWakeGeneration() : null;
      const job = getJob(normalizedJobId);
      if (!job) {
        return stopResult("scope_request_job_missing", `Job #${normalizedJobId} no longer exists.`);
      }
      const payload = parseJobPayloadObject(job);
      const pending = payload._pending_scope_request;
      if (!pending || pending.id !== normalizedRequestId) {
        return stopResult("scope_request_stale", "The scope request is no longer active.");
      }

      const decision = pending.decision ? runInTransaction(() => {
        const freshJob = getJob(normalizedJobId);
        const freshPayload = parseJobPayloadObject(freshJob);
        const freshPending = freshPayload._pending_scope_request;
        if (!freshPending || freshPending.id !== normalizedRequestId) {
          return stopResult("scope_request_stale", "The scope request is no longer active.");
        }
        if (!freshPending.decision) return null;
        // A superseded waiter must never consume a decision recorded for the
        // rebound live attempt. Exit terminally here: falling through with null
        // would reach the rebind block, whose "decided" branch continues and
        // spins this waiter (decision tx refuses, rebind says decided) until
        // timeout.
        const decisionWaiterAttempt = Number(attemptId);
        const decisionBoundAttempt = Number(freshPending.attempt_id);
        if (
          Number.isFinite(decisionWaiterAttempt)
          && Number.isFinite(decisionBoundAttempt)
          && decisionWaiterAttempt < decisionBoundAttempt
        ) {
          return stopResult(
            "scope_request_attempt_mismatch",
            "The scope request belongs to a newer job attempt.",
          );
        }

        delete freshPayload._pending_scope_request;
        updateJobPayload(freshJob.id, JSON.stringify(freshPayload));
        const entries = scopeRequestBatchEntries(freshPending);
        if (freshPending.decision === "approved") {
          return {
            ok: true,
            approved: true,
            live: true,
            paused: false,
            code: "scope_approved_live",
            path: freshPending.path || null,
            access: freshPending.access || null,
            operation: freshPending.operation || null,
            batch: entries,
            message: `Writable scope approved for ${entries.map((entry) => entry.path).join(", ")}; continuing the active agent session.`,
          };
        }
        return {
          ok: false,
          approved: false,
          live: true,
          paused: false,
          code: "scope_request_denied",
          path: freshPending.path || null,
          access: freshPending.access || null,
          operation: freshPending.operation || null,
          batch: entries,
          message: scopeRequestDeniedError(freshPending),
        };
      }) : null;
      if (decision) return decision;

      if (pending.attempt_id && attemptId && Number(pending.attempt_id) !== Number(attemptId)) {
        const rebound = runInTransaction(() => {
          const freshJob = getJob(normalizedJobId);
          const freshPayload = parseJobPayloadObject(freshJob);
          const freshPending = freshPayload._pending_scope_request;
          if (!freshPending || freshPending.id !== normalizedRequestId) return "stale";
          if (freshPending.decision) return "decided";
          const waiterAttemptId = Number(attemptId);
          const pendingAttemptId = Number(freshPending.attempt_id);
          if (!Number.isFinite(waiterAttemptId) || waiterAttemptId < pendingAttemptId) {
            return "superseded";
          }
          // Equal attempt ids mean a concurrent duplicate waiter already
          // rebound the request to this waiter's own attempt — keep polling.
          if (waiterAttemptId === pendingAttemptId) return "rebound";
          const gate = freshPending.approval_job_id ? getJob(freshPending.approval_job_id) : null;
          const gateOpen = !!gate
            && gate.job_type === "human_input"
            && ["queued", "waiting_on_human"].includes(gate.status);
          if (!gateOpen) return "gate_closed";
          freshPayload._pending_scope_request = {
            ...freshPending,
            attempt_id: Number(attemptId) || null,
            execution_settled: false,
            rebound_at: now(),
          };
          updateJobPayload(freshJob.id, JSON.stringify(freshPayload));
          return "rebound";
        });
        if (rebound === "rebound" || rebound === "decided") continue;
        if (rebound === "stale") {
          return stopResult("scope_request_stale", "The scope request is no longer active.");
        }
        if (rebound === "superseded") {
          return stopResult(
            "scope_request_attempt_mismatch",
            "The scope request belongs to a newer job attempt.",
          );
        }

        // Re-read before cleanup: a decision or newer waiter may have won after
        // the failed rebind. Never let this stale waiter cancel an open gate.
        const freshJob = getJob(normalizedJobId);
        if (!freshJob) {
          return stopResult("scope_request_job_missing", `Job #${normalizedJobId} no longer exists.`);
        }
        const freshPending = parseJobPayloadObject(freshJob)._pending_scope_request;
        if (freshPending?.id === normalizedRequestId && freshPending.decision) continue;
        // A vanished or replaced request is stale, not an attempt mismatch —
        // the gate checks below would otherwise be derived from a request this
        // waiter never owned.
        if (freshPending?.id !== normalizedRequestId) {
          return stopResult("scope_request_stale", "The scope request is no longer active.");
        }
        if (Number(attemptId) === Number(freshPending.attempt_id)) continue;
        if (
          !Number.isFinite(Number(attemptId))
          || Number(attemptId) < Number(freshPending.attempt_id)
        ) {
          return stopResult(
            "scope_request_attempt_mismatch",
            "The scope request belongs to a newer job attempt.",
          );
        }
        const gate = freshPending.approval_job_id ? getJob(freshPending.approval_job_id) : null;
        const gateOpen = !!gate
          && gate.job_type === "human_input"
          && ["queued", "waiting_on_human"].includes(gate.status);
        if (gateOpen) {
          // The rebind saw the gate closed but it is open at this re-read —
          // a torn read; retry the rebind rather than stopping a live waiter.
          continue;
        }
        abandonJobScopeExpansionRequest({
          jobId: normalizedJobId,
          requestId: normalizedRequestId,
          code: "scope_request_attempt_mismatch",
          message: "The scope request belonged to an older attempt and its approval gate is closed.",
        });
        return stopResult(
          "scope_request_attempt_mismatch",
          "The scope request belongs to a different job attempt and its approval gate is no longer open.",
        );
      }

      if (signal?.aborted) {
        const stopped = abandon(
          "scope_wait_aborted",
          "The active scope wait was aborted before a human decision arrived.",
        );
        if (stopped) return stopped;
        continue;
      }
      if (deadline != null && Date.now() >= deadline) {
        // Timing out must not destroy a review in progress: the operator may
        // be seconds from answering, and abandoning here force-canceled the
        // gate so the answer landed scope_request_stale. Return control to the
        // caller but leave the request and gate intact — a later decision is
        // consumed by the attempt-end settle path (requeue-with-grant), and
        // the watchdog exemption ages out via the pending's requested_at, so
        // nothing leaks if no answer ever comes.
        return stopResult(
          "scope_wait_timeout",
          `The active scope wait timed out after ${Math.ceil(Number(timeoutMs) / 1000)}s; the approval gate stays open and a later decision is applied when the job retries.`,
        );
      }

      const remainingMs = deadline == null ? delayMs : Math.max(1, deadline - Date.now());
      if (useQueueWake) {
        await waitForQueueStateChangeAfter(wakeGeneration, {
          signal,
          timeoutMs: Math.min(2000, remainingMs),
        });
      } else {
        await new Promise((resolve) => {
          let timer = null;
          const finish = () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.("abort", finish);
            resolve();
          };
          timer = setTimeout(finish, Math.min(delayMs, remainingMs));
          signal?.addEventListener?.("abort", finish, { once: true });
        });
      }
    }
  }

  /**
   * Mark the provider attempt that triggered a scope request as fully stopped.
   * A fast human answer may arrive while the old provider process is still
   * unwinding; only this boundary is allowed to requeue/fail the original job.
   */
  function settleJobScopeExpansionAttempt({ jobId, attemptId = null } = {}) {
    return runInTransaction(() => {
      const original = getJob(Number(jobId));
      if (!original) return { ok: false, code: "scope_request_job_missing" };
      const payload = parseJobPayloadObject(original);
      const pending = payload._pending_scope_request;
      if (!pending) return { ok: false, code: "scope_request_not_pending", job: original };
      const normalizedAttemptId = Number(attemptId) || null;
      if (pending.attempt_id && normalizedAttemptId && Number(pending.attempt_id) !== normalizedAttemptId) {
        return { ok: false, code: "scope_request_attempt_mismatch", job: original, request: pending };
      }

      const nextPayload = { ...payload };
      const settled = { ...pending, execution_settled: true, settled_at: now() };
      if (settled.decision === "approved") {
        delete nextPayload._pending_scope_request;
        updateJobPayload(original.id, JSON.stringify(nextPayload));
        updateJobStatus(original.id, "queued", { expectedStatuses: ["waiting_on_human"], force: true });
        return { ok: true, decision: "approved", finalized: true, job: getJob(original.id), request: settled };
      }
      if (settled.decision === "rejected") {
        delete nextPayload._pending_scope_request;
        updateJobPayload(original.id, JSON.stringify(nextPayload));
        const error = scopeRequestDeniedError(settled);
        setJobError(original.id, error);
        updateJobStatus(original.id, "failed", { expectedStatuses: ["waiting_on_human"], force: true });
        return { ok: true, decision: "rejected", finalized: true, job: getJob(original.id), request: settled, error };
      }
      nextPayload._pending_scope_request = settled;
      updateJobPayload(original.id, JSON.stringify(nextPayload));
      return { ok: true, decision: null, finalized: false, job: getJob(original.id), request: settled };
    });
  }

  return {
    requestJobScopeExpansion,
    abandonJobScopeExpansionRequest,
    abandonScopeRequestForCanceledGate,
    resolveJobScopeExpansion,
    awaitJobScopeExpansionDecision,
    settleJobScopeExpansionAttempt,
    parseJobPayloadObject,
  };
}
