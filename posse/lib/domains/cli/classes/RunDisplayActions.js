import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { NO_IMAGE_PROVIDERS_AVAILABLE, resolveImageExecutionProvider } from "../../providers/functions/execution-routing.js";
import { createOperatorNudge } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  approvePlan as approvePlanGate,
  rejectPlan as rejectPlanGate,
} from "../../planning/functions/plan-approval.js";
import { buildImageInjectionPayload } from "../functions/run-session.js";

function planApprovalAnswer(answers = []) {
  const first = Array.isArray(answers) ? answers[0] : answers;
  const value = first && typeof first === "object" ? first.answer : first;
  return String(value || "").trim().toLowerCase();
}

function planApprovalContext(workItem, payload = {}) {
  const lines = [`Task: ${String(workItem?.title || "Plan awaiting approval").slice(0, 500)}`];
  const summary = payload.summary;
  if (summary != null) {
    const text = typeof summary === "string" ? summary : JSON.stringify(summary);
    if (text) lines.push(`Summary: ${text.slice(0, 1400)}`);
  }
  const gatedCount = Array.isArray(payload.gated_job_ids) ? payload.gated_job_ids.length : 0;
  if (gatedCount > 0) lines.push(`Status: ${gatedCount} downstream job(s) blocked pending this decision.`);
  return lines.join("\n");
}

export class RunDisplayActions {
  constructor({
    display = null,
    worker = null,
    projectDir,
    C,
    inferWiMode,
    researchBudgetMetadata,
    createWorkItem,
    updateWorkItemStatus,
    createInitialResearchOrPlanJob,
    shouldUseRedTeamPlanForWorkItem,
    classifyResearchForRouting,
    ensureArtifactDirs,
    wiScopeId,
    artifactsDir,
    getResolvedImageProtocol,
    createJob,
    getJob,
    getWorkItem,
    storeArtifact,
    logEvent,
    cancelWorkItemJobs,
    cleanupWiBranchAsync,
    skipJob,
    refreshWorkItemStatus,
    runLiveReview,
    defaultResearchModelTier = () => "strong",
    researchBudgetToReasoningEffort,
    researchPayload,
    refreshDisplaySnapshotsForQueue = () => {},
    approvePlan = approvePlanGate,
    rejectPlan = rejectPlanGate,
  } = {}) {
    this.display = display;
    this.worker = worker;
    this.projectDir = projectDir;
    this.C = C;
    this.inferWiMode = inferWiMode;
    this.researchBudgetMetadata = researchBudgetMetadata;
    this.createWorkItem = createWorkItem;
    this.updateWorkItemStatus = updateWorkItemStatus;
    this.createInitialResearchOrPlanJob = createInitialResearchOrPlanJob;
    this.shouldUseRedTeamPlanForWorkItem = shouldUseRedTeamPlanForWorkItem;
    this.classifyResearchForRouting = classifyResearchForRouting;
    this.ensureArtifactDirs = ensureArtifactDirs;
    this.wiScopeId = wiScopeId;
    this.artifactsDir = artifactsDir;
    this.getResolvedImageProtocol = getResolvedImageProtocol;
    this.createJob = createJob;
    this.getJob = getJob;
    this.getWorkItem = getWorkItem;
    this.storeArtifact = storeArtifact;
    this.logEvent = logEvent;
    this.cancelWorkItemJobs = cancelWorkItemJobs;
    this.cleanupWiBranchAsync = cleanupWiBranchAsync;
    this.skipJob = skipJob;
    this.refreshWorkItemStatus = refreshWorkItemStatus;
    this.runLiveReview = runLiveReview;
    this.defaultResearchModelTier = defaultResearchModelTier;
    this.researchBudgetToReasoningEffort = researchBudgetToReasoningEffort;
    this.researchPayload = researchPayload;
    this.refreshDisplaySnapshotsForQueue = refreshDisplaySnapshotsForQueue;
    this.approvePlan = approvePlan;
    this.rejectPlan = rejectPlan;
    this.liveReviewPromise = null;
    this.planApprovalPrompts = new Map();
  }

  wire() {
    if (!this.display) return this;
    this.display.onInject = (description) => this.inject(description);
    this.display.onImage = (prompt) => this.image(prompt);
    this.display.onKill = (jobId) => this.kill(jobId);
    this.display.onNudge = (jobId, correction) => this.nudge(jobId, correction);
    this.display.onKillWI = (wiId) => this.killWorkItem(wiId);
    this.display.onSkipJob = (jobId) => this.skip(jobId);
    this.display.onReviewPending = () => this.reviewPending();
    this.display.onAsk = (question) => this.ask(question);
    return this;
  }

  getLiveReviewPromise() {
    return this.liveReviewPromise;
  }

  surfacePlanApprovalGates(activeJobs = []) {
    if (!this.display?.askQuestions) return [];
    const pending = (Array.isArray(activeJobs) ? activeJobs : [])
      .filter((job) => (
        job?.job_type === "human_input"
        && job?.status === "waiting_on_human"
        && parseJobPayload(job)?.subtype === "plan_approval"
      ));
    const pendingIds = new Set(pending.map((job) => Number(job.id)));
    for (const gateId of this.planApprovalPrompts.keys()) {
      if (pendingIds.has(Number(gateId))) continue;
      this.display.cancelQuestionsForJob?.(gateId);
    }

    const launched = [];
    for (const gate of pending) {
      if (this.planApprovalPrompts.has(gate.id)) continue;
      let resurfaceAfterAnswer = false;
      const payload = parseJobPayload(gate);
      const workItem = this.getWorkItem?.(gate.work_item_id);
      const payloadQuestions = Array.isArray(payload.questions)
        ? payload.questions.map((question) => String(question || "").trim()).filter(Boolean)
        : [];
      const questions = payloadQuestions.length > 0
        ? [payloadQuestions.join("\n\n")]
        : ["Approve or reject the current plan?"];
      const prompt = this.display.askQuestions(
        gate.id,
        questions,
        planApprovalContext(workItem, payload),
        gate.work_item_id,
        {
          choices: ["approve", "reject"],
          promptIdentity: {
            work_item_id: gate.work_item_id ?? null,
            original_job_id: payload.plan_job_id ?? gate.parent_job_id ?? null,
            gate_job_id: gate.id,
            gate_kind: "plan_approval",
            age_ms: Number.isFinite(Date.parse(gate.created_at || ""))
              ? Math.max(0, Date.now() - Date.parse(gate.created_at))
              : null,
          },
        },
      ).then((answers) => {
        const action = planApprovalAnswer(answers);
        const freshGate = this.getJob?.(gate.id);
        if (!freshGate || freshGate.status !== "waiting_on_human") return null;
        if (action !== "approve" && action !== "reject") {
          resurfaceAfterAnswer = true;
          this.display.addEvent?.(`${this.C.yellow}Plan gate #${gate.id} was not resolved: choose approve or reject.${this.C.reset}`);
          return { ok: false, reason: "invalid_plan_approval_answer" };
        }
        const result = action === "reject"
          ? this.rejectPlan(gate.work_item_id, { actor: "tui", actorType: EVENT_ACTORS.HUMAN })
          : this.approvePlan(gate.work_item_id, { actor: "tui", actorType: EVENT_ACTORS.HUMAN });
        if (!result?.ok) {
          this.display.addEvent?.(`${this.C.yellow}Plan gate #${gate.id} could not be resolved: ${result?.reason || "unknown error"}${this.C.reset}`);
          return result;
        }
        const label = action === "reject" ? "rejected" : "approved";
        this.display.addEvent?.(`${action === "reject" ? this.C.yellow : this.C.green}Plan ${label} for WI#${gate.work_item_id}; gate #${gate.id} closed.${this.C.reset}`);
        this.refreshWorkItemStatus?.(gate.work_item_id);
        this.refreshDisplaySnapshotsForQueue();
        return result;
      }).catch((err) => {
        const message = String(err?.message || err || "");
        if (!/Prompt withdrawn|Display aborted/i.test(message)) {
          this.display.addEvent?.(`${this.C.red}Plan gate #${gate.id} prompt failed: ${message}${this.C.reset}`);
        }
        return null;
      }).finally(() => {
        this.planApprovalPrompts.delete(gate.id);
        if (resurfaceAfterAnswer) {
          try {
            this.surfacePlanApprovalGates([this.getJob?.(gate.id) || gate]);
          } catch (err) {
            this.display.addEvent?.(`${this.C.red}Plan gate #${gate.id} could not be re-prompted: ${err?.message || err}${this.C.reset}`);
          }
        }
      });
      this.planApprovalPrompts.set(gate.id, prompt);
      launched.push(prompt);
    }
    return launched;
  }

  inject(description) {
    const title = description.split("\n")[0].slice(0, 100);
    const mode = this.inferWiMode(description) || "build";
    const deepthinkBudget = "normal";
    const item = this.createWorkItem(title, description, "normal", {
      source: "inject",
      mode,
      metadata: this.researchBudgetMetadata({}, deepthinkBudget),
    });
    this.updateWorkItemStatus(item.id, "planning");
    this.createInitialResearchOrPlanJob(item, {
      deepthinkBudget,
      source: "tui_inject",
      redTeamPlan: this.shouldUseRedTeamPlanForWorkItem(item),
      routing: this.classifyResearchForRouting({ workItem: item, mode, source: "tui_inject", live: true }),
    });
  }

  image(prompt) {
    const imageRoute = resolveImageExecutionProvider({ needs_image_generation: true });
    if (!imageRoute.readiness.ready) {
      this.display?.addEvent?.(`${this.C?.red || ""}${NO_IMAGE_PROVIDERS_AVAILABLE}${this.C?.reset || ""}`);
      return null;
    }

    const title = prompt.split("\n")[0].slice(0, 100);
    const item = this.createWorkItem(title, prompt, "normal", { source: "image", mode: "image" });
    this.ensureArtifactDirs(this.wiScopeId(item.id), "image", this.projectDir);
    const outputRoot = this.artifactsDir(this.wiScopeId(item.id), this.projectDir).replace(/\\/g, "/");
    const imgProvider = imageRoute.provider;

    this.updateWorkItemStatus(item.id, "running");
    this.createJob({
      work_item_id: item.id,
      job_type: "artificer",
      title: `Generate: ${title.slice(0, 70)}`,
      priority: "normal",
      model_tier: "standard",
      reasoning_effort: "medium",
      provider: imgProvider,
      payload_json: JSON.stringify(buildImageInjectionPayload({ prompt, outputRoot })),
    });
  }

  kill(jobId) {
    const killed = this.worker.killJob(jobId, "user_canceled");
    if (killed) {
      this.display.addEvent(`${this.C.red}⚡ Killed worker for job #${jobId} — will retry${this.C.reset}`);
    } else {
      this.display.addEvent(`${this.C.yellow}No active process found for job #${jobId}${this.C.reset}`);
    }
  }

  nudge(jobId, correction) {
    const job = this.getJob(jobId);
    // A finished job can never retrieve guidance — refuse instead of telling
    // the operator "agent will retrieve it live" about a nudge that would sit
    // pending until the finalizer sweep expires it.
    const status = String(job?.status || "");
    if (TERMINAL_JOB_STATUSES.includes(status)) {
      this.display.addEvent(`${this.C.yellow}Job #${jobId} is already ${status} — feedback cannot be delivered to it.${this.C.reset}`);
      return;
    }
    createOperatorNudge({
      work_item_id: job?.work_item_id,
      job_id: jobId,
      body: correction,
      source: "terminal",
    });

    this.display.addEvent(`${this.C.cyan}✎ Feedback queued for job #${jobId} — agent will retrieve it live${this.C.reset}`);
  }

  killWorkItem(wiId) {
    const wi = this.getWorkItem(wiId);
    if (!wi) return;

    for (const [jobId, w] of this.display.workers) {
      if (w.workItemId === wiId) {
        this.worker.killJob(jobId, "work_item_canceled");
      }
    }

    const canceled = this.cancelWorkItemJobs(wiId);
    this.updateWorkItemStatus(wiId, "canceled");

    this.logEvent({
      work_item_id: wiId,
      event_type: EVENT_TYPES.WORK_ITEM_CANCELED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Work item canceled by user (${canceled.length} job(s) canceled)`,
    });

    if (!wi.branch_name) {
      this.display.addEvent(`${this.C.red}✗ WI#${wiId} canceled; ${canceled.length} job(s) stopped${this.C.reset}`);
      return;
    }

    this.display.addEvent(`${this.C.red}✗ WI#${wiId} canceled; ${canceled.length} job(s) stopped, branch cleanup running${this.C.reset}`);
    const cleanupRunner = typeof this.cleanupWiBranchAsync === "function"
      ? this.cleanupWiBranchAsync
      : null;
    if (!cleanupRunner) {
      this.display.addEvent(`${this.C.yellow}WI#${wiId} branch cleanup skipped: async cleanup unavailable${this.C.reset}`);
      return;
    }
    void cleanupRunner(wi, { clearMergeState: true })
      .then((cleanupOk) => {
        if (!cleanupOk) {
          this.display.addEvent(`${this.C.red}✗ WI#${wiId} branch cleanup failed${this.C.reset}`);
          return;
        }
        this.display.addEvent(`${this.C.green}✓ WI#${wiId} branch/worktree cleaned up${this.C.reset}`);
      })
      .catch((err) => {
        this.display.addEvent(`${this.C.red}✗ WI#${wiId} branch cleanup failed: ${String(err?.message || err)}${this.C.reset}`);
      })
      .finally(() => {
        this.refreshDisplaySnapshotsForQueue();
        this.display.requestRender?.({ reason: "event" });
      });
  }

  skip(jobId) {
    try {
      const job = this.getJob(jobId);
      if (!job) return;

      const skipped = this.skipJob(jobId);
      if (skipped) {
        this.refreshWorkItemStatus(job.work_item_id);
        this.display.addEvent(`${this.C.yellow}⏭ Skipped job #${jobId}: ${job.title.slice(0, 50)} — downstream unblocked${this.C.reset}`);
      } else {
        this.display.addEvent(`${this.C.yellow}Cannot skip job #${jobId} (${job.status})${this.C.reset}`);
      }
    } catch (err) {
      this.display.addEvent(`${this.C.red}Skip failed for job #${jobId}: ${err.message}${this.C.reset}`);
    }
  }

  reviewPending() {
    if (this.liveReviewPromise) {
      this.display.addEvent(`${this.C.dim}Review is already open/running${this.C.reset}`);
      return;
    }
    this.liveReviewPromise = this.runLiveReview(this.display)
      .catch((err) => {
        if (typeof this.display._resetApprovalState === "function") {
          this.display._resetApprovalState();
        } else {
          this.display._mode = "normal";
        }
        this.display.addEvent(`${this.C.red}Review failed: ${err.message}${this.C.reset}`);
        this.display.requestRender({ force: true });
      })
      .finally(() => {
        this.liveReviewPromise = null;
      });
  }

  ask(question) {
    const title = question.split("\n")[0].slice(0, 100);
    const deepthinkBudget = "normal";
    const item = this.createWorkItem(title, question, "normal", {
      source: "ask",
      metadata: this.researchBudgetMetadata({ mode: "question" }, deepthinkBudget),
    });
    this.updateWorkItemStatus(item.id, "planning");
    this.classifyResearchForRouting({ workItem: item, mode: "question", source: "tui_ask", live: true });

    this.createJob({
      work_item_id: item.id,
      job_type: "research",
      title: `Ask: ${title.slice(0, 60)}`,
      priority: "normal",
      model_tier: this.defaultResearchModelTier(),
      reasoning_effort: this.researchBudgetToReasoningEffort(deepthinkBudget, "medium"),
      payload_json: JSON.stringify(this.researchPayload({}, deepthinkBudget)),
    });
  }
}
