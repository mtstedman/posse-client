// test/test-copilot-events.test.js
//
// Unit tests for the Copilot JSONL event normalizer. Exercises both
// real captured events (from docs/dev/copilot-jsonl-sample.txt) and
// synthetic events covering the message/tool/usage/session/error paths
// we expect to see once the policy gate is open.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consumeCopilotLine,
  createAccumulator,
  finalOutput,
  normalizeCopilotEvent,
  parseCopilotLine,
} from "../lib/domains/providers/functions/helpers/copilot-events.js";

describe("copilot-events: line parsing", () => {
  it("parses a valid JSONL line", () => {
    const evt = parseCopilotLine(JSON.stringify({ type: "session.warning", data: { message: "hi" } }));
    assert.equal(evt?.type, "session.warning");
    assert.equal(evt?.data?.message, "hi");
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseCopilotLine("not json"), null);
    assert.equal(parseCopilotLine(""), null);
    assert.equal(parseCopilotLine("{ malformed }"), null);
  });

  it("returns null for plain text (non-{ start)", () => {
    assert.equal(parseCopilotLine("Error: Access denied by policy settings"), null);
    assert.equal(parseCopilotLine("Your Copilot CLI policy..."), null);
  });

  it("returns null when type is missing or non-string", () => {
    assert.equal(parseCopilotLine(JSON.stringify({ data: {} })), null);
    assert.equal(parseCopilotLine(JSON.stringify({ type: 42, data: {} })), null);
  });
});

describe("copilot-events: captured probe events", () => {
  it("normalizes session.warning into the warnings list", () => {
    const acc = createAccumulator();
    const out = consumeCopilotLine(JSON.stringify({
      type: "session.warning",
      data: { warningType: "policy", message: "Third-party MCP servers are disabled" },
      id: "a1d2266e",
      timestamp: "2026-05-19T13:02:44.042Z",
      ephemeral: true,
    }), acc);
    assert.equal(out?.kind, "warning");
    assert.equal(acc.warnings.length, 1);
    assert.equal(acc.warnings[0].type, "policy");
    assert.ok(acc.warnings[0].message.includes("Third-party MCP"));
  });

  it("normalizes session.mcp_server_status_changed", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({
      type: "session.mcp_server_status_changed",
      data: { serverName: "github-mcp-server", status: "connected" },
    }), acc);
    assert.equal(acc.mcpStatusEvents.length, 1);
    assert.equal(acc.mcpStatusEvents[0].server, "github-mcp-server");
    assert.equal(acc.mcpStatusEvents[0].status, "connected");
  });

  it("passes plain-text policy errors through as null (line-consumer falls back to text buffer)", () => {
    const acc = createAccumulator();
    const out = consumeCopilotLine("Error: Access denied by policy settings (Request ID: ...)", acc);
    assert.equal(out, null);
    assert.equal(acc.errors.length, 0);
  });
});

describe("copilot-events: message / text events", () => {
  it("accumulates message.delta fragments in order", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({ type: "message.delta", data: { text: "Hello " } }), acc);
    consumeCopilotLine(JSON.stringify({ type: "message.delta", data: { delta: "world" } }), acc);
    consumeCopilotLine(JSON.stringify({ type: "message.delta", data: { text: "!" } }), acc);
    assert.equal(acc.text, "Hello world!");
    assert.equal(finalOutput(acc), "Hello world!");
  });

  it("uses message.complete only when deltas didn't fire", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({ type: "message.complete", data: { text: "single shot" } }), acc);
    assert.equal(acc.text, "single shot");
  });

  it("ignores message.complete content when deltas already produced text", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({ type: "message.delta", data: { text: "streamed" } }), acc);
    consumeCopilotLine(JSON.stringify({ type: "message.complete", data: { text: "WRONG" } }), acc);
    assert.equal(acc.text, "streamed");
  });
});

describe("copilot-events: tool calls", () => {
  it("pairs tool.call with tool.result by id", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({
      type: "tool.call",
      data: { id: "t1", name: "read_file", input: { path: "src/foo.ts" } },
    }), acc);
    consumeCopilotLine(JSON.stringify({
      type: "tool.result",
      data: { id: "t1", status: "succeeded", output: "file contents..." },
    }), acc);
    assert.equal(acc.toolUses.length, 1);
    const call = acc.toolUses[0];
    assert.equal(call.name, "read_file");
    assert.equal(call.status, "succeeded");
    assert.equal(call.resultText, "file contents...");
    assert.deepEqual(call.input, { path: "src/foo.ts" });
  });

  it("pairs result to most-recent open call when no id is present", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({ type: "tool.call", data: { name: "list_files" } }), acc);
    consumeCopilotLine(JSON.stringify({ type: "tool.result", data: { output: "a, b, c" } }), acc);
    assert.equal(acc.toolUses.length, 1);
    assert.equal(acc.toolUses[0].status, "succeeded");
    assert.equal(acc.toolUses[0].resultText, "a, b, c");
  });

  it("records orphaned tool.result as a synthetic call when no open call exists", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({
      type: "tool.result",
      data: { tool: "ghost_tool", id: "x99", status: "failed", output: "stderr" },
    }), acc);
    assert.equal(acc.toolUses.length, 1);
    assert.equal(acc.toolUses[0].name, "ghost_tool");
    assert.equal(acc.toolUses[0].status, "failed");
  });

  it("inferred 'failed' status when result carries an error and no explicit status", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({ type: "tool.call", data: { id: "t2", name: "exec" } }), acc);
    consumeCopilotLine(JSON.stringify({ type: "tool.result", data: { id: "t2", error: "exit 1" } }), acc);
    assert.equal(acc.toolUses[0].status, "failed");
  });
});

describe("copilot-events: session + usage + errors", () => {
  it("captures session id from session.created", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({
      type: "session.created",
      data: { sessionId: "sess_abc123" },
    }), acc);
    assert.equal(acc.sessionId, "sess_abc123");
  });

  it("accumulates usage tokens across multiple events", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({
      type: "session.usage",
      data: { inputTokens: 100, outputTokens: 50 },
    }), acc);
    consumeCopilotLine(JSON.stringify({
      type: "usage",
      data: { input_tokens: 25, output_tokens: 75 },
    }), acc);
    assert.equal(acc.inputTokens, 125);
    assert.equal(acc.outputTokens, 125);
  });

  it("captures session.completed reason", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({
      type: "session.completed",
      data: { reason: "end_turn" },
    }), acc);
    assert.equal(acc.completionReason, "end_turn");
  });

  it("captures errors into the errors list without affecting text", () => {
    const acc = createAccumulator();
    consumeCopilotLine(JSON.stringify({ type: "message.delta", data: { text: "partial" } }), acc);
    consumeCopilotLine(JSON.stringify({
      type: "session.error",
      data: { code: "rate_limited", message: "Try again later" },
    }), acc);
    assert.equal(acc.text, "partial");
    assert.equal(acc.errors.length, 1);
    assert.equal(acc.errors[0].type, "rate_limited");
  });
});

describe("copilot-events: unknown event types", () => {
  it("records unknowns for later analysis without throwing", () => {
    const acc = createAccumulator();
    const kind = normalizeCopilotEvent({ type: "novel.event.type", data: { foo: "bar" } }, acc);
    assert.equal(kind, "unknown");
    assert.equal(acc.unknown.length, 1);
    assert.equal(acc.unknown[0].type, "novel.event.type");
  });

  it("does not double-count when normalized twice", () => {
    const acc = createAccumulator();
    normalizeCopilotEvent({ type: "novel.thing", data: {} }, acc);
    normalizeCopilotEvent({ type: "novel.thing", data: {} }, acc);
    // We expect two unknown entries — the adapter doesn't dedupe.
    assert.equal(acc.unknown.length, 2);
  });
});

describe("copilot-events: full session walk", () => {
  it("produces a coherent accumulator across a realistic turn", () => {
    const acc = createAccumulator();
    const events = [
      { type: "session.created", data: { sessionId: "sess_test" } },
      { type: "session.mcp_server_status_changed", data: { serverName: "github-mcp-server", status: "connected" } },
      { type: "message.delta", data: { text: "Looking at " } },
      { type: "tool.call", data: { id: "c1", name: "read_file", input: { path: "README.md" } } },
      { type: "tool.result", data: { id: "c1", status: "succeeded", output: "# Project" } },
      { type: "message.delta", data: { text: "the README. " } },
      { type: "message.delta", data: { text: "It says: Project." } },
      { type: "session.usage", data: { inputTokens: 1200, outputTokens: 80 } },
      { type: "session.completed", data: { reason: "stop" } },
    ];
    for (const evt of events) consumeCopilotLine(JSON.stringify(evt), acc);

    assert.equal(acc.sessionId, "sess_test");
    assert.equal(acc.text, "Looking at the README. It says: Project.");
    assert.equal(acc.toolUses.length, 1);
    assert.equal(acc.toolUses[0].status, "succeeded");
    assert.equal(acc.inputTokens, 1200);
    assert.equal(acc.outputTokens, 80);
    assert.equal(acc.completionReason, "stop");
    assert.equal(acc.errors.length, 0);
    assert.equal(acc.unknown.length, 0);
    assert.equal(acc.warnings.length, 0);
    assert.equal(acc.mcpStatusEvents.length, 1);
  });
});
