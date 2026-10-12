import { AGENT_DISPATCH_PROTOCOL } from "../../../catalog/agent.js";
import { buildAgentToolInstructions } from "../classes/AgentRuntime.js";
import { agentProviderUsesNativeTools, callAgentProvider, resolveAgentProvider } from "./provider-route.js";
import { dispatchTranscript, renderConversation, toolCallId } from "./transcript.js";
import { parseAgentToolTurn } from "./tool-turn.js";
import { estimateCallCost } from "../../billing/functions/pricing.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
function demand(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: "invalid_request" });
}

// One model decision, never tool execution. The caller owns its conversation,
// tool allowlist, tool results and write approvals; Posse owns provider routing.
export async function dispatchAgentTurn(request, dependencies = {}) {
  demand(request?.protocol === AGENT_DISPATCH_PROTOCOL, "Unsupported agent dispatch protocol");
  demand(typeof request.system_prompt === "string", "system_prompt must be text");
  demand(Array.isArray(request.messages) && request.messages.length > 0 && request.messages.length <= 512,
    "messages must contain 1 to 512 conversation entries");
  for (const message of request.messages) {
    demand(message && ["user", "assistant", "tool"].includes(message.role) && typeof message.content === "string", "Invalid conversation entry");
  }
  demand(Array.isArray(request.tools) && request.tools.length <= 256, "tools must be an explicit bounded allowlist");
  const names = new Set();
  for (const tool of request.tools) {
    demand(tool && /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(tool.name) && !names.has(tool.name)
      && typeof tool.description === "string" && tool.parameters?.type === "object", "Invalid or duplicate tool descriptor");
    names.add(tool.name);
  }
  const route = (dependencies.resolve || resolveAgentProvider)(request.model || "auto", request.provider || "");
  const native = (dependencies.native || agentProviderUsesNativeTools)(route.provider);
  const toolInstructions = native
    ? "Use only the provider-issued tools. Never invent tool results or print tool-call JSON as prose. After real results arrive, answer in plain language."
    : buildAgentToolInstructions(request.tools, { autonomy: { write_tools: "confirm" }, limits: { calls: 1 } }, { callerOwned: true });
  const generated = await (dependencies.call || callAgentProvider)(route.provider, renderConversation(request.messages), {
    modelName: route.modelName,
    systemPrompt: `${request.system_prompt}\n\n${toolInstructions}`,
    tools: request.tools, allowToolBatching: false, promptCache: true,
    cwd: dependencies.cwd || process.cwd(), signal: dependencies.signal,
    maxOutputTokens: 8192,
    ...(native ? { transcript: dispatchTranscript(request.messages) } : {}),
  });
  const content = String(generated?.output || "").trim();
  const nativeCalls = generated?.toolCalls || (generated?.toolCall ? [generated.toolCall] : null);
  const parsed = parseAgentToolTurn(content);
  demand(!(nativeCalls ? (!nativeCalls.length && (parsed.malformed || parsed.calls.length)) : parsed.malformed),
    "Provider simulated a tool result; no tool executed");
  const calls = (nativeCalls || parsed.calls).map((call, index) => ({
    id: toolCallId(call, request.messages.length, index), name: call.name, arguments: call.arguments,
  }));
  demand(calls.length <= 1, "Provider returned an unsupported tool batch");
  for (const call of calls) demand(names.has(call.name), `Provider requested unissued tool ${call.name}`);
  const message = { role: "assistant", content: nativeCalls || !calls.length ? content : "",
    ...(calls.length ? { tool_calls: calls, raw: JSON.stringify({ name: calls[0].name, arguments: calls[0].arguments }) } : {}),
    ...(generated?.providerContent ? { provider_content: generated.providerContent } : {}) };
  const stats = generated?.stats || {};
  const priced = estimateCallCost({ provider: route.provider, modelName: stats.modelName || route.modelName,
    modelTier: "standard", inputTokens: stats.inputTokens, outputTokens: stats.outputTokens,
    cachedInputTokens: stats.cachedInputTokens, cacheCreationInputTokens: stats.cacheCreationInputTokens,
    knownCostUsd: stats.costUsd, longContextInputTokens: stats.longContextInputTokens });
  return { protocol: AGENT_DISPATCH_PROTOCOL, provider: route.provider, model: route.modelName,
    message, stats: { ...stats, costUsd: priced.source === "none" ? null : priced.costUsd } };
}

export async function runAgentDispatchCli(argv, io = {}) {
  demand(argv.length === 0, "Usage: posse agent dispatch < request.json");
  const stdout = io.stdout || process.stdout;
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of io.stdin || process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      demand(bytes <= MAX_REQUEST_BYTES, "Agent dispatch request exceeds 2 MiB");
      chunks.push(data);
    }
    const result = await dispatchAgentTurn(JSON.parse(Buffer.concat(chunks).toString("utf8")), io.dispatchDependencies || {});
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify({ protocol: AGENT_DISPATCH_PROTOCOL,
      error: { code: error?.code || "dispatch_failed", message: error?.message || String(error) } })}\n`);
    return 1;
  }
}
