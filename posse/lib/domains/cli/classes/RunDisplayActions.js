import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { NO_IMAGE_PROVIDERS_AVAILABLE, resolveImageExecutionProvider } from "../../providers/functions/execution-routing.js";
import { buildImageInjectionPayload } from "../functions/run-session.js";

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
    this.liveReviewPromise = null;
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
    this.storeArtifact({
      work_item_id: this.getJob(jobId)?.work_item_id,
      job_id: jobId,
      artifact_type: "nudge",
      content_long: correction,
    });

    this.logEvent({
      work_item_id: this.getJob(jobId)?.work_item_id,
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_NUDGED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Human correction: ${correction.slice(0, 200)}`,
    });

    const killed = this.worker.killJob(jobId, "user_nudge");
    if (killed) {
      this.display.addEvent(`${this.C.cyan}✎ Nudged job #${jobId} — will retry with correction${this.C.reset}`);
    } else {
      this.display.addEvent(`${this.C.cyan}✎ Correction stored for job #${jobId} (not currently running)${this.C.reset}`);
    }
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
