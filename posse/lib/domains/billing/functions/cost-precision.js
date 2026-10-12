// @ts-check



export function costPrecision({ callCount, exactCostCalls, estimatedCostCalls, unknownCostCalls }) {
  if (callCount > 0 && unknownCostCalls === callCount) return "unknown";
  if (unknownCostCalls > 0) return "partial";
  if (estimatedCostCalls > 0) return "estimated";
  return "exact";
}
