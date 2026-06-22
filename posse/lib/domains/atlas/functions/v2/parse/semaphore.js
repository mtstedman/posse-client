// @ts-check

import { ParseSemaphore } from "../../../classes/v2/ParseSemaphore.js";

export function createDbWriteSemaphore() {
  return new ParseSemaphore(1);
}

export function createScipStageSemaphore(max) {
  return new ParseSemaphore(max);
}
