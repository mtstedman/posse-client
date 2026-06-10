import {
  it,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  EventEmitter,
  collectHandledSuggestionKeys,
  createApprovedSuggestionFollowUp,
  suggestionDecisionEventJson,
  suggestionDevJobDecision,
  suggestionReviewKey,
} from "../support/core-harness.js";
import { ReviewSession, askSingleKeyChoice } from "../../../lib/domains/cli/functions/review-session.js";

let db;

class FakeStdin extends EventEmitter {
  constructor({ isTTY = true, isRaw = false } = {}) {
    super();
    this.isTTY = isTTY;
    this.isRaw = isRaw;
    this.paused = true;
    this.rawModes = [];
    this.resumeCount = 0;
    this.pauseCount = 0;
  }

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {
    this.paused = false;
    this.resumeCount++;
  }

  pause() {
    this.paused = true;
    this.pauseCount++;
  }

  isPaused() {
    return this.paused;
  }
}

class FakeStdout {
  constructor() {
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
}

suite("Suggestion Review Guards", () => {
  it("accepts assessor suggestion choices with one TTY keypress", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();

    const answerPromise = askSingleKeyChoice("    (a)pprove / (s)kip / skip (r)est: ", ["a", "s", "r"], { stdin, stdout });
    stdin.emit("data", Buffer.from("a"));
    const answer = await answerPromise;

    assert.equal(answer, "a");
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.resumeCount, 1);
    assert.equal(stdin.pauseCount, 1);
    assert.equal(stdout.chunks.join(""), "    (a)pprove / (s)kip / skip (r)est: a\n");
  });

  it("does not spawn dev jobs for clarification-only suggestions with no file scope", () => {
    const decision = suggestionDevJobDecision({
      suggestion: "If more variants or additional thematic motifs are needed in the future, request clarify scope accordingly.",
      filesToModify: [],
      filesToCreate: [],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "clarification-only suggestion");
  });

  it("does not spawn dev jobs when an approved suggestion has no repo file scope", () => {
    const decision = suggestionDevJobDecision({
      suggestion: "Consider adding a short README section for future image requests.",
      filesToModify: [],
      filesToCreate: [],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "no repo file scope");
  });

  it("allows actionable suggestions with explicit repo file scope", () => {
    const decision = suggestionDevJobDecision({
      suggestion: "Add a short README section for future image requests.",
      filesToModify: ["README.md"],
      filesToCreate: [],
    });

    assert.equal(decision.ok, true);
  });

  it("queues approved assessor suggestions on a fresh WI instead of the resolved source WI", () => {
    resetRuntimeDb();
    const { queueMod } = runtimeModules;
    const sourceWi = queueMod.createWorkItem("Resolved source", "desc", "normal", {
      governance_tier: "production",
    });
    const originJob = queueMod.createJob({
      work_item_id: sourceWi.id,
      job_type: "dev",
      title: "Original dev",
      payload_json: JSON.stringify({
        task_spec: "Original scoped edit",
        files_to_modify: ["README.md"],
        files_to_create: [],
        create_roots: [],
      }),
    });
    queueMod.updateJobStatus(originJob.id, "succeeded");
    queueMod.refreshWorkItemStatus(sourceWi.id);
    queueMod.setMergeState(sourceWi.id, "merged");

    const suggestion = "Add a regression test covering the README update.";
    const result = createApprovedSuggestionFollowUp({
      sourceWorkItem: queueMod.getWorkItem(sourceWi.id),
      sourceJobId: originJob.id,
      artifactId: 7,
      suggestionIndex: 0,
      suggestion,
      taskSpec: `## Improvement Required\n${suggestion}`,
      filesToModify: ["README.md"],
      filesToCreate: [],
      createRoots: [],
    });

    const sourceJobs = queueMod.listJobsByWorkItem(sourceWi.id);
    const followUpJobs = queueMod.listJobsByWorkItem(result.workItem.id);
    const followUpWi = queueMod.getWorkItem(result.workItem.id);
    const payload = JSON.parse(result.job.payload_json);
    const metadata = JSON.parse(followUpWi.metadata_json);

    assert.notEqual(result.workItem.id, sourceWi.id);
    assert.equal(result.job.work_item_id, result.workItem.id);
    assert.equal(queueMod.getWorkItem(sourceWi.id).status, "complete");
    assert.equal(queueMod.getWorkItem(sourceWi.id).merge_state, "merged");
    assert.equal(sourceJobs.some((job) => {
      try { return JSON.parse(job.payload_json || "{}").from_suggestion; } catch { return false; }
    }), false);
    assert.equal(followUpJobs.length, 1);
    assert.equal(followUpWi.status, "running");
    assert.equal(followUpWi.source, "assessor_suggestion");
    assert.equal(followUpWi.governance_tier, "production");
    assert.equal(metadata.suggestion_origin.work_item_id, sourceWi.id);
    assert.equal(payload.from_suggestion, true);
    assert.equal(payload.origin_work_item_id, sourceWi.id);
    assert.deepEqual(payload.files_to_modify, ["README.md"]);
    assert.equal(queueMod.getDependencies(result.job.id).some(dep => dep.depends_on_job_id === originJob.id), true);

    queueMod.setWorkItemBranch(result.workItem.id, "posse/wi-suggestion-follow-up", "base");
    queueMod.updateJobStatus(result.job.id, "succeeded");
    queueMod.refreshWorkItemStatus(result.workItem.id);

    const completedFollowUp = queueMod.getWorkItem(result.workItem.id);
    assert.equal(completedFollowUp.status, "complete");
    assert.equal(completedFollowUp.merge_state, "pending_review");
  });

  it("sanitizes approved suggestion scopes before creating follow-up jobs", () => {
    resetRuntimeDb();
    const { queueMod } = runtimeModules;
    const sourceWi = queueMod.createWorkItem("Unsafe suggestion source", "desc");

    const mixed = createApprovedSuggestionFollowUp({
      sourceWorkItem: queueMod.getWorkItem(sourceWi.id),
      suggestion: "Apply the scoped follow-up safely.",
      filesToModify: ["README.md", "../outside.txt"],
      filesToCreate: ["C:/tmp/absolute.txt", "docs/new.md"],
      createRoots: ["..", "assets/generated"],
    });

    assert.deepEqual(mixed.payload.files_to_modify, ["README.md"]);
    assert.deepEqual(mixed.payload.files_to_create, ["docs/new.md"]);
    assert.deepEqual(mixed.payload.create_roots, ["assets/generated"]);

    const beforeWorkItems = queueMod.listWorkItems().length;
    assert.throws(() => createApprovedSuggestionFollowUp({
      sourceWorkItem: queueMod.getWorkItem(sourceWi.id),
      suggestion: "This scope should not queue.",
      filesToModify: ["../outside.txt"],
      filesToCreate: ["../../created.txt"],
      createRoots: [".."],
    }), /safe repo file scope/);
    assert.equal(queueMod.listWorkItems().length, beforeWorkItems);
  });

  it("tracks handled assessor suggestions by artifact and suggestion index", () => {
    const suggestion = "Add focused coverage for approved recommendations.";
    const event_json = JSON.stringify(suggestionDecisionEventJson({
      artifactId: 11,
      suggestionIndex: 2,
      suggestion,
      decision: "approved",
      targetWorkItemId: 12,
      targetJobId: 13,
    }));

    const handled = collectHandledSuggestionKeys([
      { event_type: "job.suggestion_approved", event_json },
    ]);

    assert.equal(handled.has(suggestionReviewKey({ artifactId: 11, suggestionIndex: 2, suggestion })), true);
    assert.equal(handled.has(suggestionReviewKey({ artifactId: 11, suggestionIndex: 1, suggestion })), false);
  });

  it("stores only capped assessor suggestions for end-of-run review", () => {
    resetRuntimeDb();
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Suggestion cap", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original dev",
      payload_json: JSON.stringify({ files_to_modify: ["README.md"] }),
    });

    assessorMod.processVerdict(job, {
      verdict: "pass",
      confidence: "high",
      reasons: ["looks good"],
      suggestions: ["one", "two", "three"],
    }, { emit: () => {} });

    const suggestionArtifacts = queueMod.getArtifacts(job.id, "review")
      .map((artifact) => {
        try { return JSON.parse(artifact.content_json || "{}"); } catch { return null; }
      })
      .filter((artifact) => artifact?.type === "suggestions");

    assert.equal(suggestionArtifacts.length, 1);
    assert.deepEqual(suggestionArtifacts[0].suggestions, ["one", "two"]);
  });

  it("does not treat a blank first suggestion response as skip", async () => {
    resetRuntimeDb();
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Suggestion prompt", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original dev",
      payload_json: JSON.stringify({ files_to_modify: [] }),
    });
    queueMod.updateJobStatus(job.id, "succeeded");
    queueMod.updateWorkItemStatus(wi.id, "complete");
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: job.id,
      artifact_type: "review",
      content_json: { type: "suggestions", suggestions: ["Add follow-up coverage when scope is available."] },
    });

    const answers = ["", "a"];
    const prompts = [];
    const colors = { bold: "", reset: "", cyan: "", dim: "", yellow: "", green: "", red: "" };
    const session = new ReviewSession({
      C: colors,
      listWorkItems: queueMod.listWorkItems,
      getIterativeState: () => null,
      collectHandledSuggestionKeys,
      getEventsByWorkItem: queueMod.getEventsByWorkItem,
      getArtifactsByWorkItem: queueMod.getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob: queueMod.getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      logEvent: queueMod.logEvent,
      ask: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "s";
      },
    });

    const approved = await session.reviewSuggestions();

    assert.equal(approved, 0);
    assert.equal(prompts.length, 2);
    const events = queueMod.getEventsByWorkItem(wi.id, 100);
    const decisionEvents = events
      .filter((event) => event.event_type === "job.suggestion_skipped")
      .map((event) => JSON.parse(event.event_json || "{}"));
    assert.equal(decisionEvents.length, 1);
    assert.equal(decisionEvents[0].reason, "no repo file scope");
    assert.equal(decisionEvents[0].decision, "skipped");
  });

  it("does not count suggestion-origin failures toward WI escalation totals", () => {
    resetRuntimeDb();
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Suggestion failure counting", "desc");

    const coreFailure = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Core failure",
      payload_json: JSON.stringify({}),
    });
    const suggestionFailure = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Suggestion failure",
      payload_json: JSON.stringify({ from_suggestion: true }),
    });
    queueMod.updateJobStatus(coreFailure.id, "failed");
    queueMod.updateJobStatus(suggestionFailure.id, "dead_letter");

    assert.equal(queueMod.countFailedJobs(wi.id), 1);
  });

  it("counts only unresolved leaf failures toward WI escalation totals", () => {
    resetRuntimeDb();
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Leaf failure counting", "desc");

    const parent = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Initial dev",
    });
    const leaf = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Fix chain leaf",
      parent_job_id: parent.id,
    });
    queueMod.updateJobStatus(parent.id, "failed");
    queueMod.updateJobStatus(leaf.id, "dead_letter");

    assert.equal(queueMod.countFailedJobs(wi.id), 1);
  });
});
