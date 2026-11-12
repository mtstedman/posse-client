import { randomUUID } from "node:crypto";
import { SCRIPT_TOOL_AGENT_EXECUTION_KIND, SCRIPT_TOOL_AGENT_MAX_DEPTH } from "../../../catalog/custom-tools.js";
import { resolveAgentWorkingDirectory } from "../../agents/functions/scope.js";
import { demand, digest, schemaCheck } from "../functions/policy.js";
import { assertRegisteredCapability } from "../functions/registered-trust.js";

// Owner-executed tool type. No executable, CLI, registration credential or
// application dispatcher participates in the child invocation.
export class AgentToolRuntime {
  constructor(owner) { this.owner = owner; }

  pin(target) {
    demand(target && typeof target.name === "string" && Object.keys(target).every(key => ["name", "digest"].includes(key)), "Select an agent for this tool", "script_invalid");
    const loaded = this.owner.agentDefinitions.load(target.name);
    demand(!target.digest || target.digest === loaded.digest, "Selected agent changed; reload its definition", "agent_changed");
    return { name: loaded.definition.name, digest: loaded.digest };
  }

  available(target) {
    try { return this.owner.agentDefinitions.load(target.name).digest === target.digest; }
    catch { return false; }
  }

  async run(tool, input, { signal, privateInputs = {}, invocation = null, check = () => {}, usage = () => {} } = {}) {
    const target = tool.manifest.invoke_agent;
    const loaded = this.owner.agentDefinitions.load(target.name);
    demand(loaded.digest === target.digest, "Selected agent changed; update and retest the invocation tool", "agent_changed");
    const ancestors = invocation?.ancestors || [];
    demand(!ancestors.includes(target.name) && ancestors.length < SCRIPT_TOOL_AGENT_MAX_DEPTH,
      "Agent delegation cycle or depth limit reached", "agent_delegation_limit");
    const definition = loaded.definition;
    const budget = invocation?.budget || {};
    const unbudgeted = invocation?.unbudgeted === true;
    const limits = {
      ...definition.limits,
      wall_seconds: Math.min(definition.limits.wall_seconds, budget.wall_seconds ?? Infinity),
      spend_usd: Math.min(definition.limits.spend_usd, budget.spend_usd ?? Infinity),
    };
    demand(limits.wall_seconds > 0 && (unbudgeted || limits.spend_usd > 0), "Parent agent budget is exhausted", "agent_budget_exceeded");
    const privateSchema = this.owner.agents.privateInputSchema(definition);
    schemaCheck(privateSchema, privateInputs);
    const cwd = resolveAgentWorkingDirectory(definition, definition.scope.folder_path || invocation?.cwd || process.cwd());
    const sessionID = `conv_${randomUUID()}`;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const started = Date.now();
    const state = { uncertain: false };
    const execution = {
      unbudgeted, kind: SCRIPT_TOOL_AGENT_EXECUTION_KIND, clientID: sessionID, agent: target.name, definition,
      inputs: Object.freeze(structuredClone(privateInputs)), inputsDigest: digest(privateInputs),
      requestID: invocation?.run_id || sessionID, state, signal: controller.signal, limits,
      ancestors: [...ancestors, target.name],
      cwd,
      check: () => {
        controller.signal.throwIfAborted();
        check();
        this.owner.service.assertOwner();
        demand(this.available(target), "Selected agent changed during execution", "agent_changed");
        invocation?.check?.();
      },
      checkCapability: (id, pin, principal) => assertRegisteredCapability(this.owner.service, id, pin, principal, null),
    };
    const client = { request: async (operation, args) => {
      if (operation !== "agent.turn.abort") execution.check();
      switch (operation) {
        case "agent.session.get": return this.owner.agents.registeredSession(args.id, execution);
        case "agent.turn.begin": return this.owner.agents.begin(args, execution);
        case "agent.turn.touch": return this.owner.agents.touch(args, execution);
        case "agent.turn.invoke": return this.owner.agents.invoke(args, execution);
        case "agent.turn.complete": return this.owner.agents.complete(args, execution);
        case "agent.turn.abort": return this.owner.agents.abort(args, execution);
        default: demand(false, "Operation is outside the delegated agent protocol", "forbidden");
      }
    } };
    try {
      execution.check();
      const result = await this.owner.agentRuntime.run({
        agent: target.name, session: sessionID, message: JSON.stringify(input),
        idempotencyKey: sessionID, client, execution, includeToolSummary: true,
        onProgress: event => { if (event.totals) usage(event.totals); },
      });
      usage(result.usage);
      if (state.uncertain && invocation?.execution) invocation.execution.state.uncertain = true;
      const output = JSON.stringify(result);
      // Never clip a success into malformed JSON or lose the child identity.
      if (Buffer.byteLength(output) > tool.manifest.max_output_bytes) {
        result.reply = "Child result exceeded this tool's output limit; inspect its conversation.";
        result.tool_calls = []; delete result.tool_summary;
        result.status = "failed"; result.error = { code: "agent_output_limit", message: result.reply };
      }
      return { ok: result.status === "done", exit_code: result.status === "done" ? 0 : 1,
        output_json: result, stdout: "", stderr: "", timed_out: controller.signal.aborted,
        duration_ms: Date.now() - started };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
