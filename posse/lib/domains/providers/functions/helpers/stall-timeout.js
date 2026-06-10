import { readStallTimeoutSec } from "../../../scheduler/functions/config.js";

export function resolveProviderStallTimeout(stallTimeout = null) {
  const parsed = Number(stallTimeout);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : readStallTimeoutSec();
}
