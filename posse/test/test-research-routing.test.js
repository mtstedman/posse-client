import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyResearchTask } from "../lib/domains/research/functions/routing.js";

const projectMap = {
  modules: {
    artifacts: ["lib/artifacts.js", "lib/artifacts/"],
    planner: ["lib/worker/roles/planner.js"],
    provider: ["lib/provider/", "lib/provider/provider.js"],
    queue: ["lib/queue.js", "lib/queue/"],
    worker: ["lib/worker/", "lib/worker/roles/"],
  },
  module_aliases: {
    artifacts: ["lib/artifacts.js", "lib/artifacts"],
    planner: ["planner", "lib/worker/roles/planner.js"],
    provider: ["provider", "lib/provider", "lib/provider/provider.js"],
    queue: ["queue", "lib/queue", "lib/queue.js", "lib/queue/locks.js"],
    worker: ["worker", "lib/worker", "lib/worker/roles"],
  },
};

function route(input) {
  return classifyResearchTask({ projectMap, ...input });
}

describe("classifyResearchTask", () => {
  it("classifies deterministic routing fixtures", () => {
    const cases = [
      {
        name: "intake typo intent skips research",
        input: { title: "Fix typo", description: "Fix the typo in the queue help text.", intakeHints: { intent_type: "typo_fix" } },
        bucket: "no_research",
        budget: "low",
      },
      {
        name: "promote mode skips research",
        input: { title: "Promote artifacts", description: "Move prepared artifacts into the branch.", mode: "promote" },
        bucket: "no_research",
        budget: "low",
      },
      {
        name: "single-file typo skips research",
        input: { title: "Typo", description: "Fix typo in lib/queue.js" },
        bucket: "no_research",
        budget: "low",
      },
      {
        name: "question mode single-file typo still researches",
        input: { title: "Question typo", description: "Fix typo in lib/queue.js", mode: "question" },
        bucket: "solo",
        budget: "low",
      },
      {
        name: "single-file rename skips research",
        input: { title: "Rename", description: "Rename local variable in lib/worker/roles/researcher.js" },
        bucket: "no_research",
        budget: "low",
      },
      {
        name: "single-file comment fix skips research",
        input: { title: "Comment", description: "Comment fix in lib/provider/provider.js" },
        bucket: "no_research",
        budget: "low",
      },
      {
        name: "protected prompt typo does not skip research",
        input: { title: "Prompt typo", description: "Fix typo in prompts/researcher.md" },
        bucket: "solo",
        budget: "low",
      },
      {
        name: "bare comment is not a low-budget wording fix",
        input: { title: "User comment", description: "Add a comment to the user about retries in lib/queue.js" },
        bucket: "solo",
        budget: "normal",
      },
      {
        name: "long title does not disable a short no-research edit",
        input: { title: `${"Very long title ".repeat(20)} typo`, description: "Fix typo in lib/queue.js" },
        bucket: "no_research",
        budget: "low",
      },
      {
        name: "plain feature defaults to solo",
        input: { title: "Planner metadata", description: "Add retry metadata to the planner output." },
        bucket: "solo",
        budget: "normal",
      },
      {
        name: "single module remains solo",
        input: { title: "Queue timeout", description: "Update queue timeout handling." },
        bucket: "solo",
        budget: "normal",
      },
      {
        name: "list of one does not fan out",
        input: { title: "Audit queue", description: "Audit queue\n- lib/queue.js" },
        bucket: "solo",
        budget: "normal",
      },
      {
        name: "three named modules with broad trigger fans out",
        input: { title: "Review all", description: "Review all queue, worker, and provider behavior." },
        bucket: "fanout_clear",
        budget: "high",
        branches: ["queue", "worker", "provider"],
      },
      {
        name: "three listed modules fan out",
        input: { title: "Audit routing", description: "Audit these areas:\n- queue locks\n- worker dispatch\n- provider usage" },
        bucket: "fanout_clear",
        budget: "high",
        branches: ["provider", "queue", "worker"],
      },
      {
        name: "find all across modules fans out",
        input: { title: "Find all", description: "Find all mismatched handoffs across queue, worker, and artifacts." },
        bucket: "fanout_clear",
        budget: "high",
        branches: ["artifacts", "queue", "worker"],
      },
      {
        name: "verify each module fans out",
        input: { title: "Verify each", description: "Verify each area:\n1. provider\n2. worker\n3. planner" },
        bucket: "fanout_clear",
        budget: "high",
        branches: ["planner", "provider", "worker"],
      },
      {
        name: "fanout cap downgrades to ambiguous",
        input: { title: "Audit all", description: "Audit all queue, worker, provider, planner, and artifacts paths." },
        bucket: "ambiguous",
        budget: "high",
      },
      {
        name: "broad list without module branches is ambiguous",
        input: { title: "Audit unknowns", description: "Audit these:\n- startup path\n- retry path\n- shutdown path" },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "multi-paragraph no scope is ambiguous",
        input: { title: "Improve it", description: "The behavior feels off.\n\nPlease make it reliable and polished." },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "investigate without files is ambiguous",
        input: { title: "Investigate", description: "Investigate why the run sometimes stalls." },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "diagnose without files is ambiguous",
        input: { title: "Diagnose", description: "Diagnose the intermittent startup failure." },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "figure out why without scope is ambiguous",
        input: { title: "Why", description: "Figure out why this command exits early." },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "multi-paragraph with file stays solo",
        input: { title: "Inspect queue", description: "Please inspect lib/queue.js.\n\nThen summarize the likely fix." },
        bucket: "solo",
        budget: "normal",
      },
      {
        name: "auth keyword raises budget",
        input: { title: "Auth review", description: "Review auth handling in lib/provider/provider.js." },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "race keyword raises budget",
        input: { title: "Race", description: "Fix a race in the queue scheduler." },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "concurrency and lock keywords raise budget",
        input: { title: "Locks", description: "Check concurrency around worker locks." },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "urgent complex task gets xhigh",
        input: { title: "Security", description: "Investigate security around credential handling in lib/provider/provider.js.", intakeHints: { priority: "urgent" } },
        bucket: "solo",
        budget: "xhigh",
      },
      {
        name: "explicit xhigh budget is preserved",
        input: { title: "Deep", description: "Review worker dispatch.", intakeHints: { deepthink_budget: "xhigh" } },
        bucket: "solo",
        budget: "xhigh",
      },
      {
        name: "explicit high budget is preserved",
        input: { title: "Deep", description: "Review worker dispatch.", intakeHints: { research_budget: "high" } },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "legacy deepthink hint maps to high",
        input: { title: "Deep", description: "Review worker dispatch.", intakeHints: { deepthink: true } },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "shared xhigh aliases are honored",
        input: { title: "Deep", description: "Review worker dispatch.", intakeHints: { deepthink_budget: "ultrathink" } },
        bucket: "solo",
        budget: "xhigh",
      },
      {
        name: "single doc wording edit gets low budget",
        input: { title: "Docs", description: "No logic change: update README.md wording." },
        bucket: "solo",
        budget: "low",
      },
      {
        name: "queueing filename does not imply fanout",
        input: { title: "Queueing doc", description: "Update lib/queueing.js wording." },
        bucket: "solo",
        budget: "low",
      },
      {
        name: "queueing word does not match queue module",
        input: { title: "Guide", description: "Update the queueing guide." },
        bucket: "solo",
        budget: "normal",
      },
      {
        name: "path alias does not match backup extension",
        input: { title: "Backup path", description: "Review all lib/queue.js.bak, worker, and provider behavior." },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "two modules plus complex terms stays solo high",
        input: { title: "Audit locks", description: "Audit auth locking in provider and worker." },
        bucket: "solo",
        budget: "high",
      },
      {
        name: "three item module list fans out",
        input: { title: "Audit modules", description: "Audit modules:\n- queue\n- worker\n- provider" },
        bucket: "fanout_clear",
        budget: "high",
        branches: ["provider", "queue", "worker"],
      },
      {
        name: "suspected dirs contribute module signal",
        input: {
          title: "Review selected dirs",
          description: "Review all selected areas.",
          intakeHints: { suspected_dirs: ["lib/queue", "lib/worker", "lib/provider"] },
        },
        bucket: "fanout_clear",
        budget: "high",
        branches: ["provider", "queue", "worker"],
      },
      {
        name: "long single paragraph without scope is ambiguous",
        input: { title: "Large vague task", description: `${"Make the system more reliable and easier to operate for future work. ".repeat(20)}` },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "project map can be absent",
        input: { title: "Investigate", description: "Investigate why this sometimes fails.", projectMap: null },
        bucket: "ambiguous",
        budget: "normal",
      },
      {
        name: "web vendor comparison fans out into web branches",
        input: { title: "Compare rate limits", description: "Compare rate limiting between OpenAI, Anthropic, and Google." },
        bucket: "fanout_clear",
        budget: "normal",
        branches: ["anthropic", "google", "openai"],
        branchKind: "web",
      },
      {
        name: "question with one external vendor uses web-only answer path",
        input: { title: "Latest OpenAI model", description: "What is the latest OpenAI API model?", mode: "question" },
        bucket: "web_only_answer",
        budget: "normal",
      },
      {
        name: "same-module multi-file rename skips research",
        input: { title: "Rename queue helpers", description: "Rename queue helper across lib/queue/locks.js and lib/queue/state.js." },
        bucket: "no_research",
        budget: "low",
      },
    ];

    for (const fixture of cases) {
      const actual = route(fixture.input);
      assert.equal(actual.bucket, fixture.bucket, `${fixture.name} bucket: ${JSON.stringify(actual)}`);
      assert.equal(actual.budget, fixture.budget, `${fixture.name} budget: ${JSON.stringify(actual)}`);
      if (fixture.branches) {
        assert.deepEqual(
          actual.branches.map((branch) => branch.label).sort(),
          fixture.branches.sort(),
          `${fixture.name} branches: ${JSON.stringify(actual)}`,
        );
      }
      if (fixture.branchKind) {
        assert.ok(actual.branches.every((branch) => branch.kind === fixture.branchKind), `${fixture.name} branch kind: ${JSON.stringify(actual)}`);
      }
    }
  });

  it("returns branch scope hints for fanout decisions", () => {
    const actual = route({
      title: "Review all",
      description: "Review all queue, worker, and provider behavior.",
    });

    assert.equal(actual.bucket, "fanout_clear");
    assert.ok(actual.branches.every((branch) => branch.scope_hints.length > 0));
  });
});
