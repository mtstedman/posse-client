import { readonlySet } from "./readonly-collections.js";

// Atlas language and aggregate progress cells share these settled states.
export const TERMINAL_BOOT_PROGRESS_STATES = readonlySet(["done", "skipped", "deferred", "failed"]);
