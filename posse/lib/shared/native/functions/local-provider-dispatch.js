// Universal dispatch transport hosted by posse-ml's authenticated resident worker.
import {
  LOCAL_PROVIDER_ADAPTER_VERSION, ML_CAPABILITIES_METHOD, ML_PROVIDER_DISPATCH_METHOD,
  PROVIDER_DISPATCH_PROTOCOL, PROVIDER_DISPATCH_EVENTS, PROVIDER_DISPATCH_MAX_EVENT_BYTES,
} from "../../../catalog/binary.js";
import { ProviderDispatchGateway, providerDispatchSurfaceDigest } from "../../tools/classes/ProviderDispatchGateway.js";
import { runMlNativeMethodAsync } from "./ml-invoke.js";
import { resolveDispatchGrant, toolGrantContractFrom } from "./provider-dispatch-client.js";

function protocolError(message) {
  return Object.assign(new Error(message), { code: "provider_dispatch_protocol", classification: "native_protocol" });
}

export async function dispatchLocalProvider(request, {
  manager, modelRoot, runtimeRoot, signal, mcpGate, onEvent, nativeToolGrant = null,
} = {}) {
  if (request.provider !== "posse-local" || request.gateway != null) throw protocolError("Invalid local provider dispatch");
  const controller = new AbortController();
  const workerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const options = { manager, modelRoot, runtimeRoot, signal: workerSignal, timeoutMs: request.limits.wallTimeoutMs };
  const capabilities = await runMlNativeMethodAsync(ML_CAPABILITIES_METHOD, {}, options);
  const contract = capabilities?.providerDispatch;
  if (contract?.protocol !== PROVIDER_DISPATCH_PROTOCOL || contract?.adapterVersion !== LOCAL_PROVIDER_ADAPTER_VERSION
    || contract?.method !== ML_PROVIDER_DISPATCH_METHOD) {
    throw Object.assign(new Error("The installed posse-ml does not support local provider dispatch; update the native ML artifact."), { code: "provider_dispatch_unavailable" });
  }
  const ids = [...request.execution.issuedToolIds].sort();
  // The ML host shares the native authority: the same grant decision applies
  // before its gateway opens.
  const grantField = resolveDispatchGrant({
    grant: nativeToolGrant ?? mcpGate?.nativeToolGrant ?? null,
    issuedToolIds: ids,
    request,
    contract: toolGrantContractFrom(contract),
  });
  let owner = null;
  let digest = providerDispatchSurfaceDigest([]);
  let gateway = null;
  let sequence = 0;
  let attested = false;
  let output = "";
  const usage = { inputTokens: 0, outputTokens: 0, modelRequests: 0 };
  let eventError = null;
  const accept = (frame, terminal = false) => {
    if (eventError) throw eventError;
    if (!frame || frame.protocol !== PROVIDER_DISPATCH_PROTOCOL || frame.id !== request.id
      || frame.sequence !== sequence + 1 || !PROVIDER_DISPATCH_EVENTS.includes(frame.type)
      || Buffer.byteLength(JSON.stringify(frame)) > PROVIDER_DISPATCH_MAX_EVENT_BYTES) {
      throw protocolError("Malformed local provider dispatch event");
    }
    if ((sequence === 0 && frame.type !== "dispatch.started")
      || (frame.type === "dispatch.started" && (sequence !== 0 || frame.provider !== request.provider || frame.adapterVersion !== LOCAL_PROVIDER_ADAPTER_VERSION))) {
      throw protocolError("Local provider did not start with the negotiated adapter");
    }
    if (frame.type === "surface.attested") {
      if (attested || frame.expectedDigest !== digest || frame.observedDigest !== digest) throw protocolError("Local tool surface attestation mismatch");
      attested = true;
    } else if (["output.delta", "tool.requested", "tool.completed", "usage.segment", "dispatch.completed"].includes(frame.type) && !attested) {
      throw protocolError("Local provider activity preceded tool surface attestation");
    }
    if (terminal !== ["dispatch.completed", "dispatch.failed", "dispatch.cancelled"].includes(frame.type)) throw protocolError("Unexpected local provider terminal event");
    sequence += 1;
    if (frame.type === "output.delta") output += String(frame.text || "");
    if (frame.type === "usage.segment") {
      usage.inputTokens += Number(frame.usage?.inputTokens) || 0;
      usage.outputTokens += Number(frame.usage?.outputTokens) || 0;
      usage.modelRequests += 1;
    }
    onEvent?.(frame);
    return frame;
  };
  try {
    if (request.decision) {
      if (mcpGate || !Array.isArray(request.decision.tools)) throw protocolError("Decision turns cannot execute gateway tools");
      digest = providerDispatchSurfaceDigest(request.decision.tools);
    } else if (ids.length) {
      owner = new ProviderDispatchGateway({
        dispatchId: request.id, issuedToolIds: ids, mcpGate, identity: request.identity, validateArguments: true,
        role: request.execution.role, provider: request.provider, cwd: request.scope.cwd,
        leaseTtlMs: request.limits.wallTimeoutMs + 5_000,
        maxToolResultChars: request.limits.maxToolResultChars,
      });
      ({ digest } = await owner.prepareSurface());
      gateway = await owner.start();
    }
    const result = await runMlNativeMethodAsync(ML_PROVIDER_DISPATCH_METHOD, {
      ...request, ...grantField, protocol: PROVIDER_DISPATCH_PROTOCOL, type: "start", gateway,
      execution: { ...request.execution, issuedToolIds: ids, issuedToolSurfaceDigest: digest },
    }, {
      ...options, idempotent: false,
      onProgress: (event) => {
        try { accept(event); } catch (error) {
          eventError = error;
          controller.abort(error);
          void owner?.close();
        }
      },
    });
    if (eventError) throw eventError;
    const frame = accept(result, true);
    if (frame.type !== "dispatch.completed") {
      throw Object.assign(new Error(frame.error?.message || "Local provider dispatch failed"), {
        code: frame.error?.code || "provider_dispatch_failed", classification: frame.error?.class,
        details: { partialOutput: frame.partialOutput || output, stats: frame.stats || usage, diagnostic: frame.error?.detail },
      });
    }
    if (typeof frame.output !== "string" || !frame.stats || typeof frame.stats !== "object") throw protocolError("Malformed local provider completion");
    return { output: frame.output, stats: frame.stats, sessionHandle: null };
  } catch (error) {
    const failure = eventError || error;
    if (signal?.aborted) failure.code = "provider_dispatch_cancelled";
    failure.details ||= { partialOutput: output, stats: usage };
    throw failure;
  } finally {
    await owner?.close();
  }
}
