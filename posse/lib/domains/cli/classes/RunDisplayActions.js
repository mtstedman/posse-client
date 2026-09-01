import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { humanInputChoicesForPayload } from "../../../catalog/human-input.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../catalog/native-tools.js";
import { NO_IMAGE_PROVIDERS_AVAILABLE, resolveImageExecutionProvider } from "../../providers/functions/execution-routing.js";
import { createOperatorNudge, getHumanGate as getHumanGateContract } from "../../queue/functions/index.js";
import { answerWorkItemQuestionChoice as answerQuestionChoice } from "../../queue/functions/interaction-contract.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  approvePlan as approvePlanGate,
  rejectPlan as rejectPlanGate,
} from "../../planning/functions/plan-approval.js";
import { createWorkItemTransitionExecutor } from "../../bridge/functions/work-item-actions.js";
import { buildImageInjectionPayload } from "../functions/run-session.js";

function firstPromptAnswer(answers = []) {
  const first = Array.isArray(answers) ? answers[0] : answers;
  const value = first && typeof first === "object" ? first.answer : first;
  return String(value || "").trim();
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

function humanGateContext(workItem, gate, payload = {}) {
  if (payload.subtype === "plan_approval") return planApprovalContext(workItem, payload);
  const lines = [`Task: ${String(workItem?.title || gate?.title || "Human input requested").slice(0, 500)}`];
  if (payload.context) lines.push(String(payload.context).slice(0, 1400));
  if (payload.subtype === "push_offer") {
    const remote = String(payload.remote || "origin");
    const branch = String(payload.push_branch || payload.target_branch || "current branch");
    lines.push(`Publication target: ${remote}/${branch}`);
    if (Number.isFinite(Number(payload.ahead_count))) {
      lines.push(`Unpushed commits: ${Number(payload.ahead_count)}`);
    }
    if (payload.working_tree_dirty) {
      lines.push("The working tree has uncommitted changes; they are not included in this push.");
    }
  }
  return lines.join("\n");
}

function humanGateChoices(payload = {}) {
  const explicit = humanInputChoicesForPayload(payload);
  if (explicit.length > 0) return explicit;
  const kind = String(payload.question_kind || payload.subtype || "");
  return Array.isArray(WORK_ITEM_QUESTION_CHOICE_IDS[kind])
    ? [...WORK_ITEM_QUESTION_CHOICE_IDS[kind]]
    : [];
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
    getHumanGate = getHumanGateContract,
    answerWorkItemQuestionChoice = answerQuestionChoice,
    executeHumanGateTransition = null,
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
    this.getHumanGate = getHumanGate;
    this.answerWorkItemQuestionChoice = answerWorkItemQuestionChoice;
    this.executeHumanGateTransition = executeHumanGateTransition
      || createWorkItemTransitionExecutor({ projectDir, actor: "tui" }, {
        approvePlan,
        rejectPlan,
      });
    this.liveReviewPromise = null;
    this.humanGatePrompts = new Map();
    // Reservation ids must never repeat across processes: a rejected answer is
    // persisted and replayed verbatim for an identical action_id, so a fresh
    // process re-answering the same still-open gate needs a fresh identity.
    this.humanGateSessionToken = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
    this.humanGateActionSequence = 0;
    // Compatibility for callers/tests that inspected the old plan-only map.
    this.planApprovalPrompts = this.humanGatePrompts;
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
    this.display.onAnswerJob = (jobId) => {
      const gate = this.getJob?.(Number(jobId));
      if (!gate) return false;
      return this.surfaceActionableHumanGates([gate], { authoritative: false }).length > 0;
    };
    return this;
  }

  getLiveReviewPromise() {
    return this.liveReviewPromise;
  }

  surfaceActionableHumanGates(activeJobs = [], { authoritative = true } = {}) {
    if (!this.display?.askQuestions) return [];
    const pending = (Array.isArray(activeJobs) ? activeJobs : [])
      .filter((job) => (
        job?.job_type === "human_input"
        && job?.status === "waiting_on_human"
        && ["plan_approval", "push_offer"].includes(parseJobPayload(job)?.subtype)
        && humanGateChoices(parseJobPayload(job)).length > 0
      ));
    const pendingIds = new Set(pending.map((job) => Number(job.id)));
    if (authoritative) {
      for (const gateId of this.humanGatePrompts.keys()) {
        if (pendingIds.has(Number(gateId))) continue;
        this.display.cancelQuestionsForJob?.(gateId);
      }
    }

    const launched = [];
    for (const gate of pending) {
      if (this.humanGatePrompts.has(gate.id) || this.display.hasQuestionsForJob?.(gate.id)) continue;
      let resurfaceAfterAnswer = false;
      const payload = parseJobPayload(gate);
      const workItem = this.getWorkItem?.(gate.work_item_id);
      const choices = humanGateChoices(payload);
      const payloadQuestions = Array.isArray(payload.questions)
        ? payload.questions.map((question) => String(question || "").trim()).filter(Boolean)
        : [];
      const questions = payloadQuestions.length > 0
        ? [payloadQuestions.join("\n\n")]
        : [String(payload.prompt || gate.title || "Human input requested")];
      const gateContract = this.getHumanGate?.(gate.id);
      const generation = String(gateContract?.generation || 1);
      const prompt = this.display.askQuestions(
        gate.id,
        questions,
        humanGateContext(workItem, gate, payload),
        gate.work_item_id,
        {
          choices,
          promptIdentity: {
            work_item_id: gate.work_item_id ?? null,
            original_job_id: gateContract?.original_job_id
              ?? payload.original_job_id
              ?? payload.plan_job_id
              ?? gate.parent_job_id
              ?? null,
            gate_job_id: gate.id,
            gate_kind: gateContract?.gate_kind
              ?? payload.question_kind
              ?? payload.subtype
              ?? payload.review_type
              ?? "human_input",
            question_generation: generation,
            gate_generation: generation,
            age_ms: Number.isFinite(Date.parse(gate.created_at || ""))
              ? Math.max(0, Date.now() - Date.parse(gate.created_at))
              : null,
          },
        },
      ).then(async (answers) => {
        const answer = firstPromptAnswer(answers);
        const action = choices.find((choice) => choice === answer)
          || choices.find((choice) => choice.toLowerCase() === answer.toLowerCase());
        const freshGate = this.getJob?.(gate.id);
        if (!freshGate || freshGate.status !== "waiting_on_human") return null;
        if (!action) {
          resurfaceAfterAnswer = true;
          this.display.addEvent?.(`${this.C.yellow}Gate #${gate.id} was not resolved: choose ${choices.join(" or ")}.${this.C.reset}`);
          return { ok: false, reason: "invalid_human_gate_answer" };
        }
        const actionSequence = ++this.humanGateActionSequence;
        const result = await this.answerWorkItemQuestionChoice({
          action_id: `tui-gate:${gate.id}:${generation}:${this.humanGateSessionToken}:${actionSequence}:${action}`,
          work_item_id: String(gate.work_item_id),
          job_id: String(gate.id),
          question_id: `gate:${gate.id}:0`,
          question_generation: generation,
          choice_id: action,
          source: "tui",
          author: "operator",
        }, {
          executeTransition: this.executeHumanGateTransition,
        });
        const accepted = result?.outcome === "accepted" || result?.ok === true;
        if (!accepted) {
          resurfaceAfterAnswer = this.getJob?.(gate.id)?.status === "waiting_on_human";
          this.display.addEvent?.(`${this.C.yellow}Gate #${gate.id} could not be resolved: ${result?.safe_reason || result?.reason || result?.outcome || "unknown error"}${this.C.reset}`);
          return result;
        }
        this.display.addEvent?.(`${this.C.green}Gate #${gate.id} resolved with ${action}.${this.C.reset}`);
        this.refreshWorkItemStatus?.(gate.work_item_id);
        this.refreshDisplaySnapshotsForQueue();
        return result;
      }).catch((err) => {
        const message = String(err?.message || err || "");
        if (!/Prompt withdrawn|Display aborted/i.test(message)) {
          this.display.addEvent?.(`${this.C.red}Gate #${gate.id} prompt failed: ${message}${this.C.reset}`);
        }
        return null;
      }).finally(() => {
        this.humanGatePrompts.delete(gate.id);
        if (resurfaceAfterAnswer) {
          try {
            this.surfaceActionableHumanGates([this.getJob?.(gate.id) || gate], { authoritative: false });
          } catch (err) {
            this.display.addEvent?.(`${this.C.red}Gate #${gate.id} could not be re-prompted: ${err?.message || err}${this.C.reset}`);
          }
        }
      });
      this.humanGatePrompts.set(gate.id, prompt);
      launched.push(prompt);
    }
    return launched;
  }

  surfacePlanApprovalGates(activeJobs = []) {
    return this.surfaceActionableHumanGates(
      (Array.isArray(activeJobs) ? activeJobs : []).filter((job) => (
        parseJobPayload(job)?.subtype === "plan_approval"
      )),
    );
  }

  inject(description) {
    const title = description.split("\n")[0].slice(0, 100);
    const mode = this.inferWiMode(description) || "build";
    const deepthinkBudget = "normal";
    const item = this.createWorkItem(title, description, "normal", {
      source: "inject",
      mode,
      mode_source: "inferred",
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
    const item = this.createWorkItem(title, prompt, "normal", {
      source: "image",
      mode: "image",
      mode_source: "explicit",
    });
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
      mode_source: "explicit",
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
