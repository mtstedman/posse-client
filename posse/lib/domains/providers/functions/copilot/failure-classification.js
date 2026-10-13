import { classifyProviderError } from "../shared/api-resilience.js";

// Scheduling consumes the native adapter's normalized failure and retry delay.
export function parseCopilotErrorBackoff(error) {
  return classifyProviderError(error, { defaultBackoffSec: 30 });
}
