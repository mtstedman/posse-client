import { execGenerateImageInternal } from "../../../providers/functions/shared/image-generate-internal.js";

/** An allowance counted on `state.imageGenerationCallCount`, in memory. */
export function memoryImageAllowance(state) {
  return {
    reserve(maxCalls) {
      if (state.imageGenerationCallCount >= maxCalls) return false;
      state.imageGenerationCallCount += 1;
      return true;
    },
    release() {
      state.imageGenerationCallCount = Math.max(0, state.imageGenerationCallCount - 1);
    },
  };
}

// Reserve before awaiting so concurrent calls cannot exceed the allowance.
// Preflight failures refund the reservation; attempted provider requests do not.
export async function generateImageWithAllowance(args, { state, allowance = memoryImageAllowance(state), maxCalls, execute = execGenerateImageInternal, ...options }) {
  if (!allowance.reserve(maxCalls)) {
    return `Error: generate_image call limit reached for this job (${maxCalls}). Ask for operator guidance before generating more images.`;
  }
  let attempted = false;
  try {
    return await execute(args, { ...options, onProviderRequest: () => { attempted = true; } });
  } finally {
    if (!attempted) allowance.release();
  }
}
