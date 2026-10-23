import { execGenerateImageInternal } from "../../../providers/functions/shared/image-generate-internal.js";

// Reserve before awaiting so concurrent calls cannot exceed the allowance.
// Preflight failures refund the reservation; attempted provider requests do not.
export async function generateImageWithAllowance(args, { state, maxCalls, execute = execGenerateImageInternal, ...options }) {
  if (state.imageGenerationCallCount >= maxCalls) {
    return `Error: generate_image call limit reached for this job (${maxCalls}). Ask for operator guidance before generating more images.`;
  }
  state.imageGenerationCallCount += 1;
  let attempted = false;
  try {
    return await execute(args, { ...options, onProviderRequest: () => { attempted = true; } });
  } finally {
    if (!attempted) state.imageGenerationCallCount = Math.max(0, state.imageGenerationCallCount - 1);
  }
}
