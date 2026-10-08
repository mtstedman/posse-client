import { IMAGE_GENERATION_TIMEOUT_MS } from "../../../../catalog/artifact.js";
import { dispatchProvider } from "../../../../shared/native/functions/provider-dispatch-client.js";
import { buildNativeDispatchRequest } from "./native-dispatch.js";

const MAX_IMAGE_RESPONSE_BYTES = 96 * 1024 * 1024;

export function buildNativeImageClient(provider, { dispatch = dispatchProvider } = {}) {
  if (!["openai", "grok"].includes(provider)) throw new Error("Unsupported image provider");
  return {
    images: {
      async generate({ model, prompt, format, size, quality, cwd }, { signal, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS } = {}) {
        const request = buildNativeDispatchRequest(provider, prompt, {
          modelName: model, cwd, role: "artificer", taskMode: "artifact",
          maxTurns: 1, maxOutputTokens: 1, stallTimeoutMs: timeoutMs, wallTimeoutMs: timeoutMs,
          image: { format, ...(size ? { size } : {}), ...(quality ? { quality } : {}) },
        });
        const chunks = [];
        let bytes = 0;
        await dispatch(request, {
          signal,
          onEvent(event) {
            if (event.type !== "output.delta") return;
            if (typeof event.text !== "string") throw new Error("Invalid native image response");
            bytes += Buffer.byteLength(event.text);
            if (bytes > MAX_IMAGE_RESPONSE_BYTES) throw new Error("Native image response exceeds its size limit");
            chunks.push(event.text);
          },
        });
        signal?.throwIfAborted();
        const response = JSON.parse(chunks.join(""));
        if (!Array.isArray(response?.data) || response.data.length !== 1) {
          throw new Error("Native image response omitted its artifact");
        }
        return response;
      },
    },
  };
}
