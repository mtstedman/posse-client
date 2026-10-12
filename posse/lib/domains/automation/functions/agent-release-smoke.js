#!/usr/bin/env node
// Live smoke for a staged agent-owner release, run by the release reconciler
// as the owner account with owner.env:
//
//   node agent-release-smoke.js <package-root>
//
// A two-turn native tool-call chat through <package-root> (default: the
// release this file ships in): turn 1 must call the lookup tool, turn 2 must
// answer from its result. Prints only shapes, ids and token counts, and exits
// non-zero on any failure. The last line of a failure carries
// `failure: { class, code }` when the provider dispatch classified it (see
// AGENT_RELEASE_SMOKE.transientFailureClasses); the reconciler reads that,
// never the message.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AGENT_RELEASE_LIMITS, AGENT_RELEASE_SMOKE } from "../../../catalog/agent-release.js";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function line(fields) { process.stdout.write(`${JSON.stringify(fields)}\n`); }

const usage = stats => ({ in: stats?.inputTokens ?? null, cache_read: stats?.cachedInputTokens ?? null,
  cache_write: stats?.cacheCreationInputTokens ?? null, out: stats?.outputTokens ?? null });

async function smoke(root) {
  const moduleUrl = relative => pathToFileURL(path.join(root, relative)).href;
  const { resolveAgentProvider, callAgentProvider } = await import(moduleUrl("lib/domains/agents/functions/provider-route.js"));
  const route = resolveAgentProvider(AGENT_RELEASE_SMOKE.model);
  // Enough stable policy text that the cached prefix clears the provider minimum.
  const policy = Array.from({ length: 60 }, (_, n) =>
    `Rule ${n + 1}: answer from tool results only, name the record you used, and never invent a field the tool did not return.`).join("\n");
  const tool = { name: AGENT_RELEASE_SMOKE.tool, description: "Look up one record by id and return its fields.", effect: "read",
    parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] } };
  const base = { modelName: route.modelName, systemPrompt: policy, promptCache: true, tools: [tool], allowToolBatching: true, maxOutputTokens: 4096 };
  const transcript = [{ role: "user", text: `Use ${AGENT_RELEASE_SMOKE.tool} to find record ${AGENT_RELEASE_SMOKE.recordId}, then tell me its colour.` }];

  const first = await callAgentProvider(route.provider, "unused flattened prompt", { ...base, transcript });
  const calls = Array.isArray(first.toolCalls) ? first.toolCalls : [];
  line({ turn: 1, provider: route.provider, calls: calls.map(call => call.name), usage: usage(first.stats) });
  const call = calls.find(item => item.name === AGENT_RELEASE_SMOKE.tool);
  if (!call) throw new Error(`turn 1 did not call ${AGENT_RELEASE_SMOKE.tool}`);
  transcript.push(
    { role: "assistant", text: String(first.output || ""), toolCalls: calls, ...(first.providerContent ? { providerContent: first.providerContent } : {}) },
    { role: "tool", toolCallId: call.id, name: call.name, isError: false,
      content: JSON.stringify({ id: AGENT_RELEASE_SMOKE.recordId, colour: AGENT_RELEASE_SMOKE.expected, size: "large" }) },
  );
  const second = await callAgentProvider(route.provider, "unused flattened prompt", { ...base, transcript });
  const reply = String(second.output || "");
  const answered = reply.toLowerCase().includes(AGENT_RELEASE_SMOKE.expected);
  line({ turn: 2, calls: (second.toolCalls || []).map(item => item.name), reply_chars: reply.length, answered, usage: usage(second.stats) });
  if (!answered) throw new Error("turn 2 did not answer from the tool result");
}

// The provider dispatch's own classification of a failure (ProviderDispatchError
// class and code), when it made one.
function failureOf(error) {
  const failureClass = typeof error?.classification === "string" ? error.classification : "";
  return failureClass ? { failure: { class: failureClass, code: typeof error.code === "string" ? error.code : "" } } : {};
}

const root = path.resolve(process.argv[2] || OWN_ROOT);
const timer = setTimeout(() => {
  line({ ok: false, error: "smoke timed out", failure: { class: "timeout", code: "smoke_timeout" } });
  process.exit(1);
}, AGENT_RELEASE_LIMITS.smokeTimeoutSeconds * 1000);
try {
  await smoke(root);
  line({ ok: true, root });
  process.exitCode = 0;
} catch (error) {
  line({ ok: false, error: String(error?.message || error).slice(0, 300), ...failureOf(error) });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
// Native workers or keep-alive sockets must not hold the smoke open.
process.exit(process.exitCode);
