import {
  assert,
  beforeEach,
  it,
  runtimeModules,
  suite,
} from "../support/core-harness.js";
import {
  __testClearReplayMemory,
  buildAgentCallReplayPacket,
  recordRecoveryCheckpoint,
  retainReplayPrompt,
} from "../../../lib/domains/observability/functions/recovery/job-replay.js";

suite("Recovery replay", () => {
  beforeEach(() => {
    __testClearReplayMemory();
  });

  it("stores compact recovery checkpoints as durable artifacts and observations", () => {
    const { dbMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Checkpoint replay", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Checkpoint a provider call",
    });
    const call = queueMod.createAgentCall({
      work_item_id: wi.id,
      job_id: job.id,
      role: "dev",
      model_tier: "standard",
      model_name: "model-a",
      prompt_chars: 120,
      provider: "openai",
    });
    queueMod.completeAgentCall(call.id, {
      status: "succeeded",
      output_chars: 42,
      input_tokens: 30,
      output_tokens: 10,
      duration_ms: 12,
    });

    const artifact = recordRecoveryCheckpoint({
      work_item_id: wi.id,
      job_id: job.id,
      agent_call_id: call.id,
      phase: "agent_call_succeeded",
      reason: "test_checkpoint",
      status: "succeeded",
      extra: { note: "x".repeat(2000) },
    });

    assert.ok(artifact?.id);
    assert.equal(artifact.artifact_type, "log");
    assert.match(artifact.content_long, /recovery_checkpoint:agent_call_succeeded/);
    const content = JSON.parse(artifact.content_json);
    assert.equal(content.kind, "recovery_checkpoint");
    assert.equal(content.agent_call_id, call.id);
    assert.equal(content.agent_call.status, "succeeded");
    assert.equal(content.extra.note.truncated, true);

    const observation = dbMod.getDb().prepare(`
      SELECT observation_type, summary, detail_json
      FROM job_observations
      WHERE job_id = ? AND observation_type = 'system.recovery_checkpoint'
    `).get(job.id);
    assert.ok(observation);
    assert.match(observation.summary, /call#/);
    assert.equal(JSON.parse(observation.detail_json).artifact_id, artifact.id);
  });

  it("builds compressed replay by default and exact prompt replay only when requested", () => {
    const { queueMod, observationsMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Replay packet", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Replay a provider call",
    });
    const call = queueMod.createAgentCall({
      work_item_id: wi.id,
      job_id: job.id,
      role: "dev",
      model_tier: "strong",
      model_name: "model-b",
      prompt_chars: 25,
      provider: "claude",
    });
    retainReplayPrompt(call.id, {
      prompt: "exact prompt body retained in worker memory",
      systemPrompt: "system contract",
    });
    observationsMod.recordObservation({
      work_item_id: wi.id,
      job_id: job.id,
      observation_type: "tool.file_read",
      summary: "Read: src/example.js",
      detail: {
        kind: "deterministic",
        tool_name: "read_file",
        file_path: "src/example.js",
        input: { path: "src/example.js", prompt: "should not leak" },
      },
    });
    queueMod.completeAgentCall(call.id, {
      status: "succeeded",
      output_chars: 80,
      input_tokens: 11,
      output_tokens: 9,
      duration_ms: 15,
    });

    const compressed = buildAgentCallReplayPacket({ agentCallId: call.id });
    assert.equal(compressed.replay_mode, "reconstruct_from_packet_version");
    assert.equal(compressed.prompt.exact_prompt_included, false);
    assert.equal(compressed.prompt.exact_prompt_available_in_memory, true);
    assert.equal(Object.prototype.hasOwnProperty.call(compressed.prompt, "prompt"), false);
    assert.equal(compressed.tool_transcript.length, 1);
    assert.equal(compressed.tool_transcript[0].detail.file_path, "src/example.js");
    assert.equal(compressed.tool_transcript[0].detail.input.prompt, "[redacted key]");

    const exact = buildAgentCallReplayPacket({ agentCallId: call.id, exactPrompt: true });
    assert.equal(exact.replay_mode, "exact_prompt");
    assert.equal(exact.prompt.exact_prompt_source, "memory");
    assert.equal(exact.prompt.prompt, "exact prompt body retained in worker memory");
  });
});
